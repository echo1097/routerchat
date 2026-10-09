import time
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.core.database import getDb
from backend.core.streamEvents import streamEvent
from backend.lorebook.lorebookModels import LorebookUpdateRequest
from backend.lorebook.lorebookRows import lorebookModelFor
from backend.lorebook.runUpdate import finalizeLorebookUpdate, runLorebookUpdate
from backend.stories.storyQueries import requireChapter, requireStory

router = APIRouter()


@router.post("/api/stories/{story_id}/lorebook/update")
async def updateLorebookFromChapter(
    story_id: str, payload: LorebookUpdateRequest
) -> dict[str, Any]:
    with getDb() as conn:
        story = requireStory(conn, story_id)
        chapter = requireChapter(conn, story_id, payload.chapter_id)

    source_text = chapter["content"] or ""
    if not source_text.strip():
        return {"applied": [], "skipped": True, "entries": [], "history": []}

    started_at = time.perf_counter()
    result: dict[str, Any] = {}
    #this one has nowhere to put reasoning, the streaming sibling endpoint is the one write mode calls
    async for event in runLorebookUpdate(
        story_id,
        payload.chapter_id,
        source_text,
        lorebookModelFor(story),
        story["max_tokens"],
        force=payload.force,
    ):
        if event["type"] == "result":
            result = event["value"]

    durationMs = (time.perf_counter() - started_at) * 1000
    return finalizeLorebookUpdate(
        story_id, payload.chapter_id, story, result, durationMs
    )


async def streamLorebookUpdate(
    story_id: str,
    chapter_id: str,
    story: Any,
    source_text: str,
    force: bool = False,
) -> AsyncIterator[bytes]:
    startedAt = time.perf_counter()
    result: dict[str, Any] = {}

    yield streamEvent("status", "updating")

    async for event in runLorebookUpdate(
        story_id,
        chapter_id,
        source_text,
        lorebookModelFor(story),
        story["max_tokens"],
        force=force,
    ):
        if event["type"] == "reasoning":
            yield streamEvent("reasoning", event["value"])
            continue
        if event["type"] == "content":
            yield streamEvent("content", None)
            continue
        if event["type"] == "retry":
            yield streamEvent("retry", event["value"])
            continue
        result = event["value"]

    durationMs = (time.perf_counter() - startedAt) * 1000
    payload = finalizeLorebookUpdate(
        story_id, chapter_id, story, result, durationMs
    )
    yield streamEvent("complete", {**payload, "duration_ms": durationMs})


@router.post("/api/stories/{story_id}/lorebook/update/stream")
async def updateLorebookFromChapterStream(
    story_id: str, payload: LorebookUpdateRequest
) -> StreamingResponse:
    with getDb() as conn:
        story = requireStory(conn, story_id)
        chapter = requireChapter(conn, story_id, payload.chapter_id)

    sourceText = chapter["content"] or ""
    if not sourceText.strip():
        raise HTTPException(status_code=422, detail="Write something in this chapter first.")

    return StreamingResponse(
        streamLorebookUpdate(story_id, payload.chapter_id, story, sourceText, payload.force),
        media_type="application/x-ndjson; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )
