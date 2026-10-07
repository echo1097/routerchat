import json
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.core.database import getDb
from backend.core.utils import utcNow
from backend.lorebook.chapterSummaries import (
    findEnabledChapterSummary,
    lorebookSummaryChapterId,
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
    normalizeLorebookCategory,
    rowToLorebookEntry,
    sanitizeLorebookAliases,
    sanitizeLorebookMetadata,
)
from backend.lorebook.timeline import normalizeTimelineDescription
from backend.stories.storyQueries import getChapter, requireStory


def requestUpdates(payload: BaseModel, reject_null: bool = False) -> dict[str, Any]:
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
def listLorebookEntries(story_id: str) -> dict[str, Any]:
    with getDb() as conn:
        requireStory(conn, story_id)
        rows = listEntries(conn, story_id)
    return {"entries": [rowToLorebookEntry(row) for row in rows]}


@router.post("/api/stories/{story_id}/lorebook")
def createLorebookEntry(story_id: str, payload: LorebookEntryRequest) -> dict[str, Any]:
    now = utcNow()
    entry_id = str(uuid.uuid4())
    category = normalizeLorebookCategory(payload.category)
    metadata = sanitizeLorebookMetadata(category, payload.metadata)
    entryName = payload.name.strip()
    with getDb() as conn:
        requireStory(conn, story_id)
        existingSummary = None
        if category == "synopsis" and metadata.get("chapter_id"):
            chapter = getChapter(conn, story_id, metadata["chapter_id"])
            if not chapter:
                raise HTTPException(status_code=422, detail="The summary chapter was not found.")
            entryName = str(chapter["title"])
            existingSummary = findEnabledChapterSummary(
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
            return {"entry": rowToLorebookEntry(row)}

        insertEntry(
            conn,
            (
                entry_id,
                story_id,
                entryName,
                category,
                (
                    normalizeTimelineDescription(payload.description)
                    if category == "timeline"
                    else payload.description
                ),
                json.dumps(sanitizeLorebookAliases(category, payload.aliases, entryName)),
                json.dumps(payload.tags),
                json.dumps(metadata),
                int(payload.disabled),
                now,
                now,
            ),
        )
        row = getEntry(conn, entry_id)
    return {"entry": rowToLorebookEntry(row)}


@router.patch("/api/stories/{story_id}/lorebook/{entry_id}")
def updateLorebookEntry(
    story_id: str, entry_id: str, payload: LorebookEntryRequest
) -> dict[str, Any]:
    now = utcNow()
    category = normalizeLorebookCategory(payload.category)
    baseRevision = payload.revision
    with getDb() as conn:
        entry = getStoryEntry(conn, story_id, entry_id)
        if not entry:
            raise HTTPException(status_code=404, detail="Lorebook entry not found.")
        metadata = sanitizeLorebookMetadata(category, payload.metadata)
        entryName = payload.name.strip()
        if category == "synopsis":
            chapterId = str(metadata.get("chapter_id") or "").strip()
            if not chapterId and normalizeLorebookCategory(entry["category"]) == "synopsis":
                chapterId = lorebookSummaryChapterId(entry)
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
                    normalizeTimelineDescription(payload.description)
                    if category == "timeline"
                    else payload.description
                ),
                json.dumps(sanitizeLorebookAliases(category, payload.aliases, entryName)),
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
                    "entry": rowToLorebookEntry(current),
                },
            )
        row = getEntry(conn, entry_id)
    return {"entry": rowToLorebookEntry(row)}


@router.delete("/api/stories/{story_id}/lorebook/{entry_id}")
def deleteLorebookEntry(story_id: str, entry_id: str) -> dict[str, Any]:
    with getDb() as conn:
        result = deleteStoryEntry(conn, story_id, entry_id)
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Lorebook entry not found.")
    return {"ok": True}
