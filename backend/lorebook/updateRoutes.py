import time
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.core.database import get_db
from backend.core.streamEvents import stream_event
from backend.lorebook.lorebookModels import LorebookUpdateRequest
from backend.lorebook.lorebookRows import lorebook_model_for
from backend.lorebook.runUpdate import finalize_lorebook_update, run_lorebook_update

router = APIRouter()


@router.post("/api/stories/{story_id}/lorebook/update")
async def update_lorebook_from_chapter(
    story_id: str, payload: LorebookUpdateRequest
) -> dict[str, Any]:
    with get_db() as conn:
        story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        chapter = conn.execute(
            "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
            (payload.chapter_id, story_id),
        ).fetchone()
        if not chapter:
            raise HTTPException(status_code=404, detail="Chapter not found.")

    source_text = chapter["content"] or ""
    if not source_text.strip():
        return {"applied": [], "skipped": True, "entries": [], "history": []}

    started_at = time.perf_counter()
    result: dict[str, Any] = {}
    #this one has nowhere to put reasoning, the streaming sibling endpoint is the one write mode calls
    async for event in run_lorebook_update(
        story_id,
        payload.chapter_id,
        source_text,
        lorebook_model_for(story),
        story["max_tokens"],
    ):
        if event["type"] == "result":
            result = event["value"]

    durationMs = (time.perf_counter() - started_at) * 1000
    return finalize_lorebook_update(
        story_id, payload.chapter_id, story, result, durationMs
    )


async def stream_lorebook_update(
    story_id: str,
    chapter_id: str,
    story: Any,
    source_text: str,
) -> AsyncIterator[bytes]:
    startedAt = time.perf_counter()
    result: dict[str, Any] = {}

    yield stream_event("status", "updating")

    async for event in run_lorebook_update(
        story_id,
        chapter_id,
        source_text,
        lorebook_model_for(story),
        story["max_tokens"],
    ):
        if event["type"] == "reasoning":
            yield stream_event("reasoning", event["value"])
            continue
        if event["type"] == "content":
            yield stream_event("content", None)
            continue
        result = event["value"]

    durationMs = (time.perf_counter() - startedAt) * 1000
    payload = finalize_lorebook_update(
        story_id, chapter_id, story, result, durationMs
    )
    yield stream_event("complete", {**payload, "duration_ms": durationMs})


@router.post("/api/stories/{story_id}/lorebook/update/stream")
async def update_lorebook_from_chapter_stream(
    story_id: str, payload: LorebookUpdateRequest
) -> StreamingResponse:
    with get_db() as conn:
        story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        chapter = conn.execute(
            "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
            (payload.chapter_id, story_id),
        ).fetchone()
        if not chapter:
            raise HTTPException(status_code=404, detail="Chapter not found.")

    sourceText = chapter["content"] or ""
    if not sourceText.strip():
        raise HTTPException(status_code=422, detail="Write something in this chapter first.")

    return StreamingResponse(
        stream_lorebook_update(story_id, payload.chapter_id, story, sourceText),
        media_type="application/x-ndjson; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )
