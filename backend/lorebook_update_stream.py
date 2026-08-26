import time
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.writing import (
    LorebookUpdateRequest,
    WritingDeps,
    finalize_lorebook_update,
    run_lorebook_update,
)


#the manual "update lorebook" button used to be a plain json post, this is the same thing over ndjson so the thinking shows up in the write mode dropdown while it runs
def create_lorebook_update_stream_router(deps: WritingDeps) -> APIRouter:
    router = APIRouter()

    async def stream_lorebook_update(
        story_id: str,
        chapter_id: str,
        story: Any,
        source_text: str,
    ) -> AsyncIterator[bytes]:
        startedAt = time.perf_counter()
        result: dict[str, Any] = {}

        yield deps.stream_event("status", "updating")

        async for event in run_lorebook_update(
            deps,
            story_id,
            chapter_id,
            source_text,
            story["model"],
            story["max_tokens"],
        ):
            if event["type"] == "reasoning":
                yield deps.stream_event("reasoning", event["value"])
                continue
            if event["type"] == "content":
                yield deps.stream_event("content", None)
                continue
            result = event["value"]

        durationMs = (time.perf_counter() - startedAt) * 1000
        payload = finalize_lorebook_update(deps, story_id, chapter_id, story, result, durationMs)

        #a failed run still returns the untouched entry list, the client decides how loud to be about the error
        yield deps.stream_event("complete", {**payload, "duration_ms": durationMs})

    @router.post("/api/stories/{story_id}/lorebook/update/stream")
    async def update_lorebook_from_chapter_stream(
        story_id: str, payload: LorebookUpdateRequest
    ) -> StreamingResponse:
        with deps.get_db() as conn:
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

    return router
