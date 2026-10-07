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
from backend.lorebook.lorebookQueries import (
    deleteStoryEntry,
    getEntry,
    getStoryEntry,
    insertEntry,
    listEntries,
    refreshSummaryEntry,
    updateEntryAtRevision,
)
from backend.lorebook.lorebookRows import (
    normalize_lorebook_category,
    row_to_lorebook_entry,
    sanitize_lorebook_aliases,
    sanitize_lorebook_metadata,
)
from backend.lorebook.timeline import normalize_timeline_description
from backend.stories.storyQueries import getChapter, requireStory


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
        story = requireStory(conn, story_id)
        rows = listEntries(conn, story_id)
    return {"entries": [row_to_lorebook_entry(row) for row in rows]}


@router.post("/api/stories/{story_id}/lorebook")
def create_lorebook_entry(story_id: str, payload: LorebookEntryRequest) -> dict[str, Any]:
    now = utc_now()
    entry_id = str(uuid.uuid4())
    category = normalize_lorebook_category(payload.category)
    metadata = sanitize_lorebook_metadata(category, payload.metadata)
    entryName = payload.name.strip()
    with get_db() as conn:
        story = requireStory(conn, story_id)
        existingSummary = None
        if category == "synopsis" and metadata.get("chapter_id"):
            chapter = getChapter(conn, story_id, metadata["chapter_id"])
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
            refreshSummaryEntry(
                conn,
                (
                    entryName,
                    payload.description,
                    json.dumps(metadata),
                    int(payload.disabled),
                    now,
                    entry_id,
                ),
            )
            row = getEntry(conn, entry_id)
            return {"entry": row_to_lorebook_entry(row)}

        insertEntry(
            conn,
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
        row = getEntry(conn, entry_id)
    return {"entry": row_to_lorebook_entry(row)}


@router.patch("/api/stories/{story_id}/lorebook/{entry_id}")
def update_lorebook_entry(
    story_id: str, entry_id: str, payload: LorebookEntryRequest
) -> dict[str, Any]:
    now = utc_now()
    category = normalize_lorebook_category(payload.category)
    baseRevision = payload.revision
    with get_db() as conn:
        entry = getStoryEntry(conn, story_id, entry_id)
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
                chapter = getChapter(conn, story_id, chapterId)
                if not chapter:
                    raise HTTPException(status_code=422, detail="The summary chapter was not found.")
                entryName = str(chapter["title"])
        result = updateEntryAtRevision(
            conn,
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
            current = getStoryEntry(conn, story_id, entry_id)
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "lorebook_revision_conflict",
                    "message": "Lorebook entry changed on the server.",
                    "entry": row_to_lorebook_entry(current),
                },
            )
        row = getEntry(conn, entry_id)
    return {"entry": row_to_lorebook_entry(row)}


@router.delete("/api/stories/{story_id}/lorebook/{entry_id}")
def delete_lorebook_entry(story_id: str, entry_id: str) -> dict[str, Any]:
    with get_db() as conn:
        result = deleteStoryEntry(conn, story_id, entry_id)
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Lorebook entry not found.")
    return {"ok": True}
