import json
import sqlite3
import uuid
from typing import Any

from backend.lorebook.editOperations import (
    apply_lorebook_edit_operations,
    skipped_lorebook_update,
)
from backend.lorebook.legacyUpdates import apply_legacy_lorebook_updates
from backend.lorebook.lorebookRows import (
    lorebook_entry_snapshot,
    lorebook_row_snapshot,
    normalize_lorebook_category,
    sanitize_lorebook_aliases,
    sanitize_lorebook_metadata,
)
from backend.lorebook.timeline import normalize_timeline_description
from backend.writing.storyRows import word_diff_counts


def apply_targeted_lorebook_update(
    conn: sqlite3.Connection,
    story_id: str,
    update: dict[str, Any],
    update_index: int,
    now: str,
    claimed_entry_ids: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    action = str(update.get("action") or "").lower()
    if action == "create":
        name = str(update.get("name") or "").strip()
        category = normalize_lorebook_category(update.get("category"))
        description = str(update.get("description") or "").strip()
        if not name or not description:
            return [], [skipped_lorebook_update(
                update_index, "lorebook_create_invalid", "new entries need a name and description", update
            )]
        existing = conn.execute(
            """
            SELECT id FROM lorebook_entries
            WHERE story_id = ? AND disabled = 0
              AND (lower(name) = lower(?) OR (? = 'timeline' AND category = 'timeline'))
            LIMIT 1
            """,
            (story_id, name, category),
        ).fetchone()
        if existing:
            return [], [skipped_lorebook_update(
                update_index,
                "lorebook_create_exists",
                "an enabled entry with that identity already exists; edit it by entryId",
                update,
            )]
        if category == "timeline":
            name = "Timeline"
            description = normalize_timeline_description(description)
        aliases = sanitize_lorebook_aliases(category, update.get("aliases"), name)
        tags = update.get("tags") if isinstance(update.get("tags"), list) else []
        metadata = sanitize_lorebook_metadata(category, update.get("metadata"))
        entryId = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO lorebook_entries (
              id, story_id, name, category, description, aliases_json,
              tags_json, metadata_json, revision, disabled, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
            """,
            (
                entryId, story_id, name, category, description,
                json.dumps(aliases), json.dumps(tags), json.dumps(metadata), now, now,
            ),
        )
        wordsAdded, wordsRemoved = word_diff_counts(
            "", lorebook_entry_snapshot(category, description, aliases, tags, metadata)
        )
        return [{
            "action": "create",
            "id": entryId,
            "name": name,
            "wordsAdded": wordsAdded,
            "wordsRemoved": wordsRemoved,
        }], []

    entryId = str(update.get("entryId") or "").strip()
    entryRevision = update.get("entryRevision")
    if not entryId or not isinstance(entryRevision, int):
        return [], [skipped_lorebook_update(
            update_index,
            "lorebook_target_invalid",
            "existing entries require entryId and entryRevision",
            update,
        )]
    if entryId in claimed_entry_ids:
        return [], [skipped_lorebook_update(
            update_index,
            "lorebook_target_repeated",
            "the same entry cannot be targeted by more than one update",
            update,
        )]
    claimed_entry_ids.add(entryId)
    entry = conn.execute(
        "SELECT * FROM lorebook_entries WHERE id = ? AND story_id = ? AND disabled = 0",
        (entryId, story_id),
    ).fetchone()
    if not entry:
        return [], [skipped_lorebook_update(
            update_index,
            "lorebook_target_missing",
            "the entry was missing, hidden, or belonged to another story",
            update,
        )]
    if entry["revision"] != entryRevision:
        return [], [skipped_lorebook_update(
            update_index,
            "lorebook_revision_conflict",
            "the entry changed after the model read it",
            update,
        )]
    if action == "keep":
        return [], []
    if action == "exclude":
        if normalize_lorebook_category(entry["category"]) == "timeline":
            return [], [skipped_lorebook_update(
                update_index,
                "lorebook_timeline_required",
                "Timeline cannot be excluded",
                update,
            )]
        result = conn.execute(
            """
            UPDATE lorebook_entries
            SET disabled = 1, revision = revision + 1, updated_at = ?
            WHERE id = ? AND story_id = ? AND revision = ?
            """,
            (now, entryId, story_id, entryRevision),
        )
        if result.rowcount != 1:
            return [], [skipped_lorebook_update(
                update_index,
                "lorebook_revision_conflict",
                "the entry changed before it could be excluded",
                update,
            )]
        wordsAdded, wordsRemoved = word_diff_counts(lorebook_row_snapshot(entry), "")
        return [{
            "action": "delete",
            "id": entryId,
            "name": entry["name"],
            "wordsAdded": wordsAdded,
            "wordsRemoved": wordsRemoved,
        }], []
    if action != "edit":
        return [], [skipped_lorebook_update(
            update_index,
            "lorebook_action_invalid",
            f"unsupported lorebook action: {action or 'missing'}",
            update,
        )]

    nextEntry, skipped, appliedOperations = apply_lorebook_edit_operations(
        entry, update.get("operations"), update_index
    )
    if not appliedOperations:
        return [], skipped
    summaryChapterId = str(update.get("_summaryChapterId") or "").strip()
    if summaryChapterId:
        nextEntry["name"] = str(update.get("_summaryName") or entry["name"])
        nextEntry["category"] = "synopsis"
        nextEntry["aliases"] = []
        nextEntry["tags"] = []
        nextEntry["metadata"] = {"chapter_id": summaryChapterId}
    if nextEntry["category"] == "timeline" and normalize_lorebook_category(entry["category"]) != "timeline":
        existingTimeline = conn.execute(
            "SELECT id FROM lorebook_entries WHERE story_id = ? AND category = 'timeline' AND disabled = 0",
            (story_id,),
        ).fetchone()
        if existingTimeline:
            skipped.append(skipped_lorebook_update(
                update_index,
                "lorebook_timeline_exists",
                "the story already has an enabled Timeline entry",
                update,
            ))
            return [], skipped

    identityConflict = conn.execute(
        """
        SELECT id FROM lorebook_entries
        WHERE story_id = ? AND id != ? AND disabled = 0
          AND (lower(name) = lower(?) OR (? = 'timeline' AND category = 'timeline'))
        LIMIT 1
        """,
        (story_id, entryId, nextEntry["name"], nextEntry["category"]),
    ).fetchone()
    if identityConflict:
        skipped.append(skipped_lorebook_update(
            update_index,
            "lorebook_identity_conflict",
            "another enabled entry already uses that identity",
            update,
        ))
        return [], skipped

    beforeSnapshot = lorebook_row_snapshot(entry)
    afterSnapshot = lorebook_entry_snapshot(
        nextEntry["category"], nextEntry["description"], nextEntry["aliases"],
        nextEntry["tags"], nextEntry["metadata"],
    )
    if beforeSnapshot == afterSnapshot and str(entry["name"]) == nextEntry["name"]:
        return [], skipped
    result = conn.execute(
        """
        UPDATE lorebook_entries
        SET name = ?, category = ?, description = ?, aliases_json = ?, tags_json = ?,
            metadata_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND story_id = ? AND revision = ? AND disabled = 0
        """,
        (
            nextEntry["name"], nextEntry["category"], nextEntry["description"],
            json.dumps(nextEntry["aliases"]), json.dumps(nextEntry["tags"]),
            json.dumps(nextEntry["metadata"]), now, entryId, story_id, entryRevision,
        ),
    )
    if result.rowcount != 1:
        skipped.append(skipped_lorebook_update(
            update_index,
            "lorebook_revision_conflict",
            "the entry changed before the edit could be saved",
            update,
        ))
        return [], skipped
    wordsAdded, wordsRemoved = word_diff_counts(beforeSnapshot, afterSnapshot)
    return [{
        "action": "update",
        "id": entryId,
        "name": nextEntry["name"],
        "operations": appliedOperations,
        "wordsAdded": wordsAdded,
        "wordsRemoved": wordsRemoved,
    }], skipped


def apply_lorebook_updates(
    conn: sqlite3.Connection,
    story_id: str,
    updates: list[dict[str, Any]],
    now: str,
) -> dict[str, list[dict[str, Any]]]:
    targeted = any(
        str(update.get("action") or "").lower() in {"edit", "exclude", "keep"}
        for update in updates
        if isinstance(update, dict)
    )
    if not targeted:
        return {
            "applied": apply_legacy_lorebook_updates(conn, story_id, updates, now),
            "skipped": [],
        }

    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    claimedEntryIds: set[str] = set()
    for updateIndex, update in enumerate(updates):
        if not isinstance(update, dict):
            skipped.append(skipped_lorebook_update(
                updateIndex, "lorebook_update_invalid", "update must be an object", update
            ))
            continue
        nextApplied, nextSkipped = apply_targeted_lorebook_update(
            conn, story_id, update, updateIndex, now, claimedEntryIds
        )
        applied.extend(nextApplied)
        skipped.extend(nextSkipped)
    return {"applied": applied, "skipped": skipped}
