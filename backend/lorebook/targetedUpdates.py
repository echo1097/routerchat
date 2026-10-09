import json
import sqlite3
import uuid
from typing import Any

from backend.lorebook.chapterSummaries import findEnabledChapterSummary
from backend.lorebook.editOperations import (
    applyLorebookEditOperations,
    skippedLorebookUpdate,
)
from backend.lorebook.lorebookRows import (
    lorebookEntrySnapshot,
    lorebookRowSnapshot,
    normalizeLorebookCategory,
    sanitizeLorebookAliases,
    sanitizeLorebookMetadata,
)
from backend.lorebook.timeline import normalizeTimelineDescription
from backend.stories.storyRows import wordDiffCounts


def enabledIdentityConflict(
    conn: sqlite3.Connection,
    story_id: str,
    name: str,
    category: str,
    exclude_id: str = "",
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT id FROM lorebook_entries
        WHERE story_id = ? AND id != ? AND disabled = 0
          AND (lower(name) = lower(?) OR (? = 'timeline' AND category = 'timeline'))
        LIMIT 1
        """,
        (story_id, exclude_id, name, category),
    ).fetchone()


def replaceChapterSummary(
    conn: sqlite3.Connection,
    story_id: str,
    summary: sqlite3.Row,
    name: str,
    description: str,
    chapter_id: str,
    now: str,
) -> list[dict[str, Any]]:
    metadata = {"chapter_id": chapter_id}
    beforeSnapshot = lorebookRowSnapshot(summary)
    afterSnapshot = lorebookEntrySnapshot("synopsis", description, [], [], metadata)
    if beforeSnapshot == afterSnapshot and str(summary["name"]) == name:
        return []

    conn.execute(
        """
        UPDATE lorebook_entries
        SET name = ?, category = 'synopsis', description = ?, aliases_json = '[]', tags_json = '[]',
            metadata_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND story_id = ?
        """,
        (name, description, json.dumps(metadata), now, summary["id"], story_id),
    )
    wordsAdded, wordsRemoved = wordDiffCounts(beforeSnapshot, afterSnapshot)
    return [{
        "action": "update",
        "id": summary["id"],
        "name": name,
        "wordsAdded": wordsAdded,
        "wordsRemoved": wordsRemoved,
    }]


def createLorebookEntryFromUpdate(
    conn: sqlite3.Connection,
    story_id: str,
    update: dict[str, Any],
    update_index: int,
    now: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    name = str(update.get("name") or "").strip()
    category = normalizeLorebookCategory(update.get("category"))
    description = str(update.get("description") or "").strip()
    if not name or not description:
        return [], [skippedLorebookUpdate(
            update_index, "lorebook_create_invalid", "new entries need a name and description", update
        )]

    metadata = sanitizeLorebookMetadata(category, update.get("metadata"))
    summaryChapterId = str(metadata.get("chapter_id") or "") if category == "synopsis" else ""
    if summaryChapterId:
        existingSummary = findEnabledChapterSummary(conn, story_id, summaryChapterId, name)
        if existingSummary:
            return replaceChapterSummary(
                conn, story_id, existingSummary, name, description, summaryChapterId, now
            ), []
    elif enabledIdentityConflict(conn, story_id, name, category):
        return [], [skippedLorebookUpdate(
            update_index,
            "lorebook_create_exists",
            "an enabled entry with that identity already exists; edit it by entryId",
            update,
        )]

    if category not in {"timeline", "synopsis"}:
        hidden = conn.execute(
            """
            SELECT id FROM lorebook_entries
            WHERE story_id = ? AND disabled = 1 AND lower(name) = lower(?)
            LIMIT 1
            """,
            (story_id, name),
        ).fetchone()
        if hidden:
            return [], [skippedLorebookUpdate(
                update_index,
                "lorebook_create_hidden",
                "a hidden entry with that name already exists; use include to bring it back",
                update,
            )]

    if category == "timeline":
        name = "Timeline"
        description = normalizeTimelineDescription(description)
    aliases = sanitizeLorebookAliases(category, update.get("aliases"), name)
    tags = update.get("tags") if isinstance(update.get("tags"), list) else []
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
    wordsAdded, wordsRemoved = wordDiffCounts(
        "", lorebookEntrySnapshot(category, description, aliases, tags, metadata)
    )
    return [{
        "action": "create",
        "id": entryId,
        "name": name,
        "wordsAdded": wordsAdded,
        "wordsRemoved": wordsRemoved,
    }], []


def includeLorebookEntry(
    conn: sqlite3.Connection,
    story_id: str,
    entry: sqlite3.Row,
    update: dict[str, Any],
    update_index: int,
    now: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    category = normalizeLorebookCategory(entry["category"])
    if enabledIdentityConflict(conn, story_id, str(entry["name"]), category, str(entry["id"])):
        return [], [skippedLorebookUpdate(
            update_index,
            "lorebook_identity_conflict",
            "another enabled entry already uses that identity",
            update,
        )]
    result = conn.execute(
        """
        UPDATE lorebook_entries
        SET disabled = 0, revision = revision + 1, updated_at = ?
        WHERE id = ? AND story_id = ? AND revision = ?
        """,
        (now, entry["id"], story_id, entry["revision"]),
    )
    if result.rowcount != 1:
        return [], [skippedLorebookUpdate(
            update_index,
            "lorebook_revision_conflict",
            "the entry changed before it could be included",
            update,
        )]
    wordsAdded, wordsRemoved = wordDiffCounts("", lorebookRowSnapshot(entry))
    return [{
        "action": "include",
        "id": entry["id"],
        "name": entry["name"],
        "wordsAdded": wordsAdded,
        "wordsRemoved": wordsRemoved,
    }], []


def applyTargetedLorebookUpdate(
    conn: sqlite3.Connection,
    story_id: str,
    update: dict[str, Any],
    update_index: int,
    now: str,
    claimed_entry_ids: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    action = str(update.get("action") or "").lower()
    if action == "create":
        return createLorebookEntryFromUpdate(conn, story_id, update, update_index, now)

    entryId = str(update.get("entryId") or "").strip()
    entryRevision = update.get("entryRevision")
    if not entryId or not isinstance(entryRevision, int):
        return [], [skippedLorebookUpdate(
            update_index,
            "lorebook_target_invalid",
            "existing entries require entryId and entryRevision",
            update,
        )]
    if entryId in claimed_entry_ids:
        return [], [skippedLorebookUpdate(
            update_index,
            "lorebook_target_repeated",
            "the same entry cannot be targeted by more than one update",
            update,
        )]
    claimed_entry_ids.add(entryId)
    entry = conn.execute(
        "SELECT * FROM lorebook_entries WHERE id = ? AND story_id = ?",
        (entryId, story_id),
    ).fetchone()
    if not entry:
        return [], [skippedLorebookUpdate(
            update_index,
            "lorebook_target_missing",
            "the entry was missing or belonged to another story",
            update,
        )]
    if entry["revision"] != entryRevision:
        return [], [skippedLorebookUpdate(
            update_index,
            "lorebook_revision_conflict",
            "the entry changed after the model read it",
            update,
        )]
    if action == "include":
        if not bool(entry["disabled"]):
            return [], [skippedLorebookUpdate(
                update_index,
                "lorebook_target_not_hidden",
                "the entry is already included in context",
                update,
            )]
        return includeLorebookEntry(conn, story_id, entry, update, update_index, now)
    if bool(entry["disabled"]):
        return [], [skippedLorebookUpdate(
            update_index,
            "lorebook_target_hidden",
            "the entry is hidden; only include can change it",
            update,
        )]
    if action == "keep":
        return [], []
    if action == "exclude":
        if normalizeLorebookCategory(entry["category"]) == "timeline":
            return [], [skippedLorebookUpdate(
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
            return [], [skippedLorebookUpdate(
                update_index,
                "lorebook_revision_conflict",
                "the entry changed before it could be excluded",
                update,
            )]
        wordsAdded, wordsRemoved = wordDiffCounts(lorebookRowSnapshot(entry), "")
        return [{
            "action": "delete",
            "id": entryId,
            "name": entry["name"],
            "wordsAdded": wordsAdded,
            "wordsRemoved": wordsRemoved,
        }], []
    if action != "edit":
        return [], [skippedLorebookUpdate(
            update_index,
            "lorebook_action_invalid",
            f"unsupported lorebook action: {action or 'missing'}",
            update,
        )]

    nextEntry, skipped, appliedOperations = applyLorebookEditOperations(
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
    if nextEntry["category"] == "timeline" and normalizeLorebookCategory(entry["category"]) != "timeline":
        existingTimeline = conn.execute(
            "SELECT id FROM lorebook_entries WHERE story_id = ? AND category = 'timeline' AND disabled = 0",
            (story_id,),
        ).fetchone()
        if existingTimeline:
            skipped.append(skippedLorebookUpdate(
                update_index,
                "lorebook_timeline_exists",
                "the story already has an enabled Timeline entry",
                update,
            ))
            return [], skipped

    if enabledIdentityConflict(conn, story_id, nextEntry["name"], nextEntry["category"], entryId):
        skipped.append(skippedLorebookUpdate(
            update_index,
            "lorebook_identity_conflict",
            "another enabled entry already uses that identity",
            update,
        ))
        return [], skipped

    beforeSnapshot = lorebookRowSnapshot(entry)
    afterSnapshot = lorebookEntrySnapshot(
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
        skipped.append(skippedLorebookUpdate(
            update_index,
            "lorebook_revision_conflict",
            "the entry changed before the edit could be saved",
            update,
        ))
        return [], skipped
    wordsAdded, wordsRemoved = wordDiffCounts(beforeSnapshot, afterSnapshot)
    return [{
        "action": "update",
        "id": entryId,
        "name": nextEntry["name"],
        "operations": appliedOperations,
        "wordsAdded": wordsAdded,
        "wordsRemoved": wordsRemoved,
    }], skipped


def applyLorebookUpdates(
    conn: sqlite3.Connection,
    story_id: str,
    updates: list[dict[str, Any]],
    now: str,
) -> dict[str, list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    claimedEntryIds: set[str] = set()
    for updateIndex, update in enumerate(updates):
        if not isinstance(update, dict):
            skipped.append(skippedLorebookUpdate(
                updateIndex, "lorebook_update_invalid", "update must be an object", update
            ))
            continue
        nextApplied, nextSkipped = applyTargetedLorebookUpdate(
            conn, story_id, update, updateIndex, now, claimedEntryIds
        )
        applied.extend(nextApplied)
        skipped.extend(nextSkipped)
    return {"applied": applied, "skipped": skipped}
