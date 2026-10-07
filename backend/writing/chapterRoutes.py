import sqlite3
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.attachments.attachmentCleanup import claimAttachments
from backend.attachments.attachmentLimits import checkAttachmentLimits
from backend.chats.chatModels import StreamMessageRequest
from backend.chats.systemPrompts import writeSystemPrompt
from backend.core.database import getDb
from backend.core.utils import utcNow
from backend.lorebook.chapterSummaries import (
    deleteLinkedChapterSummaries,
    renameLinkedChapterSummaries,
)
from backend.lorebook.lorebookQueries import listEntriesByCreated
from backend.stories.storyProvider import storyProvider
from backend.usage.recordUsage import recordUsage
from backend.writing.storyGeneration import (
    ChapterStreamingResponse,
    streamStoryGeneration,
)
from backend.writing.storyModels import (
    ChapterContentRequest,
    ChapterCreateRequest,
    ChapterPatchRequest,
)
from backend.stories.storyQueries import (
    cancelPendingGeneration,
    deleteChapter,
    getChapter,
    getChapterById,
    insertChapter,
    insertPendingGeneration,
    listChapterHistory,
    listChapters,
    requireChapter,
    requireStory,
    touchStory,
    updateChapterColumns,
    updateChapterColumnsAtRevision,
    updateStoryWriteSettings,
)
from backend.stories.storyRows import (
    nextChapterOrder,
    requestUpdates,
    rowToChapter,
    rowToChapterHistoryEntry,
    wordCount,
)

router = APIRouter()


@router.get("/api/stories/{story_id}/chapters")
def listChaptersRoute(story_id: str) -> dict[str, Any]:
    with getDb() as conn:
        story = requireStory(conn, story_id)
        rows = listChapters(conn, story_id)
        history_rows = listChapterHistory(conn, story_id)
    history_by_chapter: dict[str, list[dict[str, Any]]] = {}
    for row in history_rows:
        history_by_chapter.setdefault(row["chapter_id"], []).append(
            rowToChapterHistoryEntry(row)
        )
    chapters = []
    for row in rows:
        chapter = rowToChapter(row)
        chapter["history"] = history_by_chapter.get(row["id"], [])
        chapters.append(chapter)
    return {"chapters": chapters}


@router.post("/api/stories/{story_id}/chapters")
def createChapter(story_id: str, payload: ChapterCreateRequest) -> dict[str, Any]:
    now = utcNow()
    chapter_id = str(uuid.uuid4())
    content = payload.content
    with getDb() as conn:
        story = requireStory(conn, story_id)
        insertChapter(
            conn,
            (
                chapter_id,
                story_id,
                payload.title.strip() or "New chapter",
                content,
                wordCount(content),
                nextChapterOrder(conn, story_id),
                now,
                now,
            ),
        )
        row = getChapterById(conn, chapter_id)
    return {"chapter": rowToChapter(row)}


@router.patch("/api/stories/{story_id}/chapters/{chapter_id}")
def updateChapter(
    story_id: str, chapter_id: str, payload: ChapterPatchRequest
) -> dict[str, Any]:
    updates = requestUpdates(payload, reject_null=True)
    base_revision = updates.pop("revision", None)
    if "content" in updates:
        updates["word_count"] = wordCount(updates["content"])
    if "title" in updates:
        updates["title"] = str(updates["title"]).strip() or "New chapter"
    if not updates:
        with getDb() as conn:
            chapter = requireChapter(conn, story_id, chapter_id)
        return {"chapter": rowToChapter(chapter)}
    assignments: list[str] = []
    values: list[Any] = []
    for key, value in updates.items():
        assignments.append(f"{key} = ?")
        values.append(value)
    assignments.append("updated_at = ?")
    now = utcNow()
    values.append(now)
    content_changed = "content" in updates
    with getDb() as conn:
        chapter = requireChapter(conn, story_id, chapter_id)
        if base_revision is None:
            values.extend([chapter_id, story_id])
            updateChapterColumns(conn, assignments, values)
        else:
            values.extend([chapter_id, story_id, base_revision])
            result = updateChapterColumnsAtRevision(conn, assignments, values)
            if result.rowcount == 0:
                current = getChapter(conn, story_id, chapter_id)
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "chapter_revision_conflict",
                        "message": "Chapter changed on the server.",
                        "chapter": rowToChapter(current),
                    },
                )
        if content_changed:
            touchStory(conn, story_id, now)
        if "title" in updates:
            renameLinkedChapterSummaries(
                conn, story_id, chapter_id, updates["title"], now
            )
        row = getChapter(conn, story_id, chapter_id)
    return {"chapter": rowToChapter(row)}


@router.patch("/api/stories/{story_id}/chapters/{chapter_id}/content")
def saveChapterContent(
    story_id: str, chapter_id: str, payload: ChapterContentRequest
) -> dict[str, Any]:
    return updateChapter(
        story_id,
        chapter_id,
        ChapterPatchRequest(content=payload.content, revision=payload.revision),
    )


@router.delete("/api/stories/{story_id}/chapters/{chapter_id}")
def deleteChapterRoute(story_id: str, chapter_id: str) -> dict[str, Any]:
    with getDb() as conn:
        result = deleteChapter(conn, story_id, chapter_id)
        if result.rowcount:
            deleteLinkedChapterSummaries(conn, story_id, chapter_id)
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Chapter not found.")
    return {"ok": True}


@router.post("/api/stories/{story_id}/chapters/{chapter_id}/generate/stream")
async def streamStoryChapterGeneration(
    story_id: str,
    chapter_id: str,
    payload: StreamMessageRequest,
) -> StreamingResponse:
    provider = storyProvider(story_id)
    provider.requireKey()
    attachmentIds = list(payload.attachment_ids or [])
    if not payload.message.strip() and not attachmentIds:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    with getDb() as conn:
        story = requireStory(conn, story_id)
        chapter = requireChapter(conn, story_id, chapter_id)
        checkAttachmentLimits(conn, attachmentIds, provider, modelId=payload.model)
        base_revision = payload.chapter_revision
        if base_revision is None:
            raise HTTPException(status_code=422, detail="chapter_revision is required.")
        if base_revision != chapter["revision"]:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "chapter_revision_conflict",
                    "message": "Chapter changed on the server.",
                    "chapter": rowToChapter(chapter),
                },
            )
        lorebook_rows = listEntriesByCreated(conn, story_id)
        orderedChapters = listChapters(conn, story_id)
        previousChapters: list[sqlite3.Row] = []
        for row in orderedChapters:
            if row["id"] == chapter_id:
                break
            previousChapters.append(row)

        updateStoryWriteSettings(
            conn,
            (
                payload.model,
                writeSystemPrompt(payload),
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                utcNow(),
                story_id,
            ),
        )
        claimAttachments(conn, attachmentIds, story_id=story_id)

        generationId = payload.generation_status_id or str(uuid.uuid4())
        createdAt = utcNow()
        try:
            insertPendingGeneration(
                conn, generationId, story_id, chapter_id, payload.message, payload.model, createdAt
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="Generation status ID is already in use.") from exc
        recordUsage("story", generationId, payload.model, None, createdAt, provider=provider.id)

    def settleUnstartedGeneration():
        with getDb() as conn:
            cancelPendingGeneration(conn, generationId)

    return ChapterStreamingResponse(
        streamStoryGeneration(
            story_id,
            chapter_id,
            payload,
            story,
            chapter,
            lorebook_rows,
            base_revision,
            generationId,
            previousChapters,
        ),
        onClose=settleUnstartedGeneration,
        media_type="application/x-ndjson; charset=utf-8",
    )
