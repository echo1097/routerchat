import json
import sqlite3
import uuid
from typing import Any

from backend.lorebook.chapterSummaries import find_enabled_chapter_summary
from backend.lorebook.lorebookRows import (
    json_dict,
    json_list,
    lorebook_entry_snapshot,
    lorebook_row_snapshot,
    normalize_lorebook_category,
    sanitize_lorebook_aliases,
    sanitize_lorebook_metadata,
)
from backend.lorebook.timeline import normalize_timeline_description
from backend.writing.storyRows import word_diff_counts


def apply_legacy_lorebook_updates(
    conn: sqlite3.Connection,
    story_id: str,
    updates: list[dict[str, Any]],
    now: str,
) -> list[dict[str, Any]]:
    applied: list[dict[str, Any]] = []
    for update in updates:
        action = str(update.get("action") or "create").lower()
        name = str(update.get("name") or "").strip()
        category = normalize_lorebook_category(update.get("category"))
        if category == "timeline":
            name = "Timeline"
            #everything timeline shaped is an update, except a delete which gets refused below
            if action != "delete":
                action = "update"
        if not name:
            continue
        description = str(update.get("description") or "").strip()
        if category == "timeline":
            description = normalize_timeline_description(description)
        aliases = sanitize_lorebook_aliases(category, update.get("aliases"), name)
        tags = update.get("tags") if isinstance(update.get("tags"), list) else []
        metadata = sanitize_lorebook_metadata(category, update.get("metadata"))

        #disabled = 0 on every lookup, a hidden entry has to stay untouched by automatic updates
        if category == "timeline":
            existing = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ? AND lower(name) = lower('Timeline') AND disabled = 0
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()
        elif category == "synopsis" and metadata.get("chapter_id"):
            existing = find_enabled_chapter_summary(
                conn,
                story_id,
                str(metadata["chapter_id"]),
                name,
            )
        else:
            existing = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ? AND lower(name) = lower(?) AND disabled = 0
                LIMIT 1
                """,
                (story_id, name),
            ).fetchone()

        if action == "delete":
            #timeline is a singleton the model doesnt get to retire
            if not existing or category == "timeline" or name.casefold() == "timeline":
                continue
            conn.execute(
                "UPDATE lorebook_entries SET disabled = 1, revision = revision + 1, updated_at = ? WHERE id = ?",
                (now, existing["id"]),
            )
            wordsAdded, wordsRemoved = word_diff_counts(
                lorebook_row_snapshot(existing), ""
            )
            applied.append(
                {
                    "action": "delete",
                    "id": existing["id"],
                    "name": name,
                    "wordsAdded": wordsAdded,
                    "wordsRemoved": wordsRemoved,
                }
            )
            continue

        #model often says create for something it already knows about, treat that as the update it meant
        if action == "create" and existing and description:
            action = "update"

        if action == "update" and existing:
            next_description = description or existing["description"]
            #empty means no opinion, not "wipe it". the system prompt hands the model a template containing aliases:[] tags:[] metadata:{} so it echoes those back on every single update whether it meant anything by them or not
            next_aliases = sanitize_lorebook_aliases(
                category,
                update["aliases"]
                if isinstance(update.get("aliases"), list) and update["aliases"]
                else json_list(existing["aliases_json"]),
                name,
            )
            next_tags = (
                update["tags"]
                if isinstance(update.get("tags"), list) and update["tags"]
                else json_list(existing["tags_json"])
            )
            next_metadata = sanitize_lorebook_metadata(
                category,
                update["metadata"]
                if isinstance(update.get("metadata"), dict) and update["metadata"]
                else json_dict(existing["metadata_json"]),
            )

            beforeSnapshot = lorebook_row_snapshot(existing)
            afterSnapshot = lorebook_entry_snapshot(
                category, next_description, next_aliases, next_tags, next_metadata
            )
            nameChanged = str(existing["name"]) != name
            #an update that changes nothing is not an edit, dont write it and dont claim it in the history
            if beforeSnapshot == afterSnapshot and not nameChanged:
                continue

            conn.execute(
                """
                UPDATE lorebook_entries
                SET name = ?, category = ?, description = ?, aliases_json = ?, tags_json = ?,
                    metadata_json = ?, revision = revision + 1, updated_at = ?
                WHERE id = ?
                """,
                (
                    name,
                    category,
                    next_description,
                    json.dumps(next_aliases),
                    json.dumps(next_tags),
                    json.dumps(next_metadata),
                    now,
                    existing["id"],
                ),
            )
            wordsAdded, wordsRemoved = word_diff_counts(beforeSnapshot, afterSnapshot)
            applied.append(
                {
                    "action": "update",
                    "id": existing["id"],
                    "name": name,
                    "wordsAdded": wordsAdded,
                    "wordsRemoved": wordsRemoved,
                }
            )
            continue

        if existing:
            continue

        entry_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO lorebook_entries (
              id, story_id, name, category, description, aliases_json,
              tags_json, metadata_json, disabled, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?,  ?, 0, ?, ?)
            """,
            (
                entry_id,
                story_id,
                name,
                category,
                description,
                json.dumps(aliases),
                json.dumps(tags),
                json.dumps(metadata),
                now,
                now,
            ),
        )
        wordsAdded, wordsRemoved = word_diff_counts(
            "", lorebook_entry_snapshot(category, description, aliases, tags, metadata)
        )
        applied.append(
            {
                "action": "create",
                "id": entry_id,
                "name": name,
                "wordsAdded": wordsAdded,
                "wordsRemoved": wordsRemoved,
            }
        )
    return applied
