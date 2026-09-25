import json
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.core.database import get_db
from backend.core.utils import utc_now
from backend.lorebook.chapterSummaries import (
    find_enabled_chapter_summary,
    lorebook_summary_chapter_id,
)
from backend.lorebook.lorebookModels import LorebookEntryRequest
from backend.lorebook.lorebookRows import (
    normalize_lorebook_category,
    row_to_lorebook_entry,
    sanitize_lorebook_aliases,
    sanitize_lorebook_metadata,
)
from backend.lorebook.timeline import normalize_timeline_description


def request_updates(payload: BaseModel, reject_null: bool = False) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        updates = payload.model_dump(exclude_unset=True)
    else:
        updates = payload.dict(exclude_unset=True)
    if reject_null:
        nullFields = [key for key, value in updates.items() if value is None]
        if nullFields:
            raise HTTPException(
                status_code=422,
                detail=f"Fields cannot be null: {', '.join(sorted(nullFields))}.",
            )
    return updates


router = APIRouter()


@router.get("/api/stories/{story_id}/lorebook")
def list_lorebook_entries(story_id: str) -> dict[str, Any]:
    with get_db() as conn:
        story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        rows = conn.execute(
            """
            SELECT * FROM lorebook_entries
            WHERE story_id = ?
            ORDER BY updated_at DESC, created_at DESC
            """,
            (story_id,),
        ).fetchall()
    return {"entries": [row_to_lorebook_entry(row) for row in rows]}


@router.post("/api/stories/{story_id}/lorebook")
def create_lorebook_entry(story_id: str, payload: LorebookEntryRequest) -> dict[str, Any]:
    now = utc_now()
    entry_id = str(uuid.uuid4())
    category = normalize_lorebook_category(payload.category)
    metadata = sanitize_lorebook_metadata(category, payload.metadata)
    entryName = payload.name.strip()
    with get_db() as conn:
        story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        existingSummary = None
        if category == "synopsis" and metadata.get("chapter_id"):
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (metadata["chapter_id"], story_id),
            ).fetchone()
            if not chapter:
                raise HTTPException(status_code=422, detail="The summary chapter was not found.")
            entryName = str(chapter["title"])
            existingSummary = find_enabled_chapter_summary(
                conn,
                story_id,
                str(chapter["id"]),
                entryName,
            )

        if existingSummary:
            entry_id = str(existingSummary["id"])
            conn.execute(
                """
                UPDATE lorebook_entries
                SET name = ?, description = ?, aliases_json = '[]', tags_json = '[]',
                    metadata_json = ?, disabled = ?, revision = revision + 1, updated_at = ?
                WHERE id = ?
                """,
                (
                    entryName,
                    payload.description,
                    json.dumps(metadata),
                    int(payload.disabled),
                    now,
                    entry_id,
                ),
            )
            row = conn.execute(
                "SELECT * FROM lorebook_entries WHERE id = ?",
                (entry_id,),
            ).fetchone()
            return {"entry": row_to_lorebook_entry(row)}

        conn.execute(
            """
            INSERT INTO lorebook_entries (
              id, story_id, name, category, description, aliases_json,
              tags_json, metadata_json, disabled, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry_id,
                story_id,
                entryName,
                category,
                (
                    normalize_timeline_description(payload.description)
                    if category == "timeline"
                    else payload.description
                ),
                json.dumps(sanitize_lorebook_aliases(category, payload.aliases, entryName)),
                json.dumps(payload.tags),
                json.dumps(metadata),
                int(payload.disabled),
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM lorebook_entries WHERE id = ?", (entry_id,)).fetchone()
    return {"entry": row_to_lorebook_entry(row)}


@router.patch("/api/stories/{story_id}/lorebook/{entry_id}")
def update_lorebook_entry(
    story_id: str, entry_id: str, payload: LorebookEntryRequest
) -> dict[str, Any]:
    now = utc_now()
    category = normalize_lorebook_category(payload.category)
    baseRevision = payload.revision
    with get_db() as conn:
        entry = conn.execute(
            "SELECT * FROM lorebook_entries WHERE id = ? AND story_id = ?",
            (entry_id, story_id),
        ).fetchone()
        if not entry:
            raise HTTPException(status_code=404, detail="Lorebook entry not found.")
        metadata = sanitize_lorebook_metadata(category, payload.metadata)
        entryName = payload.name.strip()
        if category == "synopsis":
            chapterId = str(metadata.get("chapter_id") or "").strip()
            if not chapterId and normalize_lorebook_category(entry["category"]) == "synopsis":
                chapterId = lorebook_summary_chapter_id(entry)
                metadata = {"chapter_id": chapterId} if chapterId else {}
            if chapterId:
                chapter = conn.execute(
                    "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                    (chapterId, story_id),
                ).fetchone()
                if not chapter:
                    raise HTTPException(status_code=422, detail="The summary chapter was not found.")
                entryName = str(chapter["title"])
        result = conn.execute(
            """
            UPDATE lorebook_entries
            SET name = ?, category = ?, description = ?, aliases_json = ?,
                tags_json = ?, metadata_json = ?, disabled = ?,
                revision = revision + 1, updated_at = ?
            WHERE id = ? AND story_id = ? AND (? IS NULL OR revision = ?)
            """,
            (
                entryName,
                category,
                (
                    normalize_timeline_description(payload.description)
                    if category == "timeline"
                    else payload.description
                ),
                json.dumps(sanitize_lorebook_aliases(category, payload.aliases, entryName)),
                json.dumps(payload.tags),
                json.dumps(metadata),
                int(payload.disabled),
                now,
                entry_id,
                story_id,
                baseRevision,
                baseRevision,
            ),
        )
        if result.rowcount != 1:
            current = conn.execute(
                "SELECT * FROM lorebook_entries WHERE id = ? AND story_id = ?",
                (entry_id, story_id),
            ).fetchone()
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "lorebook_revision_conflict",
                    "message": "Lorebook entry changed on the server.",
                    "entry": row_to_lorebook_entry(current),
                },
            )
        row = conn.execute("SELECT * FROM lorebook_entries WHERE id = ?", (entry_id,)).fetchone()
    return {"entry": row_to_lorebook_entry(row)}


@router.delete("/api/stories/{story_id}/lorebook/{entry_id}")
def delete_lorebook_entry(story_id: str, entry_id: str) -> dict[str, Any]:
    with get_db() as conn:
        result = conn.execute(
            "DELETE FROM lorebook_entries WHERE id = ? AND story_id = ?",
            (entry_id, story_id),
        )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Lorebook entry not found.")
    return {"ok": True}
