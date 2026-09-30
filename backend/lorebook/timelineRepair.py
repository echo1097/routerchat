import asyncio
import json
import sqlite3
import time
import uuid
from contextlib import aclosing
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.core.database import get_db
from backend.core.streamEvents import stream_event
from backend.core.utils import utc_now
from backend.lorebook.lorebookModels import TimelineRepairRequest
from backend.lorebook.lorebookRows import lorebook_model_for, row_to_lorebook_entry
from backend.lorebook.lorebookUsage import LorebookUsage
from backend.lorebook.parseLorebook import parse_lorebook_json
from backend.lorebook.timeline import normalize_timeline_description
from backend.providers.base import ChatOptions
from backend.providers.registry import getActiveProvider
from backend.providers.streaming import streamChat

router = APIRouter()


def timeline_repair_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "timeline_repair",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "timeline": {"type": "string", "minLength": 1},
                },
                "required": ["timeline"],
            },
        },
    }


def parse_timeline_repair(raw_output: str) -> str:
    parsed = parse_lorebook_json(raw_output)
    timeline = parsed.get("timeline")
    if not isinstance(timeline, str) or not timeline.strip():
        raise ValueError("The model returned an empty timeline.")

    normalized = normalize_timeline_description(timeline)
    if not normalized:
        raise ValueError("The model returned an empty timeline.")
    return normalized


async def stream_timeline_repair(
    story_id: str,
    story: sqlite3.Row,
    visible_chapters: list[sqlite3.Row],
    timeline_row: sqlite3.Row | None,
    current_timeline: str,
) -> AsyncIterator[bytes]:
    startedAt = time.perf_counter()
    provider = getActiveProvider()
    apiKey = provider.readKey()
    if not apiKey:
        raise HTTPException(status_code=401, detail=provider.missingKeyMessage)

    timelineSnapshot = (
        {
            "id": timeline_row["id"],
            "updated_at": timeline_row["updated_at"],
            "description": timeline_row["description"],
        }
        if timeline_row
        else None
    )
    chapterContext = [
        {
            "title": chapter["title"],
            "content": chapter["content"] or "",
        }
        for chapter in visible_chapters
    ]
    prompt = {
        "story": {
            "title": story["title"],
            "author": story["author"],
            "language": story["language"],
            "synopsis": story["synopsis"],
        },
        "current_timeline": current_timeline,
        "visible_chapters": chapterContext,
    }

    #same deal as the lorebook repair, the author's story instructions ride along so bullet style rules land
    authorInstructions = str(story["system_prompt"] or "").strip()
    if authorInstructions:
        prompt["author_instructions"] = authorInstructions

    messages = [
        {
            "role": "system",
            "content": (
                "Rebuild the complete story timeline from every visible chapter supplied. "
                "The current timeline is context only: keep useful chronology and wording when "
                "it is supported by the chapters, but correct it whenever the story disagrees. "
                "Include every durable event needed to understand story chronology, ordered "
                "from earliest to latest. Use one concise factual event per Markdown bullet. "
                "Do not invent events, repeat bullets, copy the prose style, or include facts "
                "that are not chronological events. When author_instructions is present it "
                "holds the story author's own instructions for this story: follow the parts "
                "that apply to the timeline, such as bullet length, detail, and language, "
                "ignore the parts about writing prose, and never let it override these rules "
                "or the JSON shape. Return strict JSON only in this shape: "
                "{\"timeline\":\"- event one\\n- event two\"}."
            ),
        },
        {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
    ]
    responseFormat = None
    if provider.supportsStructuredOutput(lorebook_model_for(story)):
        responseFormat = timeline_repair_response_format()

    request = provider.buildRequest(
        messages,
        lorebook_model_for(story),
        ChatOptions(
            apiKey=apiKey,
            temperature=0.1,
            maxTokens=story["max_tokens"],
            thinkingEnabled=True,
            reasoningEffort=story["reasoning_effort"],
            responseFormat=responseFormat,
        ),
    )
    effectiveThinkingEnabled = provider.effectiveThinkingEnabled(lorebook_model_for(story), True)

    generatedText: list[str] = []
    finishReason: str | None = None
    usageRun = LorebookUsage(apiKey, story_id, lorebook_model_for(story), "timeline_repair")
    receivedDone = False
    announcedWriting = False

    yield stream_event("status", "rebuilding")

    try:
        async with usageRun:
            async with aclosing(streamChat(provider, request)) as events:
                async for event in events:
                    if event["type"] in ("error", "open"):
                        usageRun.generationId = event["generationId"]
                    if event["type"] == "error":
                        yield stream_event(
                            "error",
                            {"code": "timeline_repair_provider_error", "message": event["message"]},
                        )
                        return
                    if event["type"] == "open":
                        continue
                    if event["type"] == "done":
                        receivedDone = True
                        continue

                    usageRun.generationId = usageRun.generationId or event["id"]
                    usageRun.addUsage(event["usage"])

                    if not event["hasChoice"]:
                        continue
                    finishReason = event["finishReason"] or finishReason
                    if event["reasoning"] and effectiveThinkingEnabled:
                        yield stream_event("reasoning", event["reasoning"])
                    if event["content"]:
                        #first real content means the thinking is done and the timeline is being written
                        if not announcedWriting:
                            announcedWriting = True
                            yield stream_event("status", "writing")
                        generatedText.append(event["content"])

        if usageRun.usage:
            yield stream_event(
                "usage",
                {"generation_id": usageRun.generationId, "model": usageRun.model, **usageRun.usage},
            )

        if not receivedDone:
            yield stream_event(
                "error",
                {
                    "code": "timeline_repair_incomplete",
                    "message": "Timeline repair ended before the provider completed the stream.",
                },
            )
            return
        if finishReason == "length":
            yield stream_event(
                "error",
                {
                    "code": "timeline_repair_truncated",
                    "message": "The rebuilt timeline hit the model token limit before it finished.",
                },
            )
            return

        try:
            nextTimeline = parse_timeline_repair("".join(generatedText))
        except ValueError as exc:
            yield stream_event(
                "error",
                {"code": "timeline_repair_invalid", "message": str(exc)},
            )
            return

        now = utc_now()
        with get_db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            currentRow = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ?
                  AND disabled = 0
                  AND (category = 'timeline' OR lower(name) = lower('Timeline'))
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()

            if timelineSnapshot is None:
                timelineChanged = currentRow is not None
            else:
                timelineChanged = (
                    currentRow is None
                    or currentRow["id"] != timelineSnapshot["id"]
                    or currentRow["updated_at"] != timelineSnapshot["updated_at"]
                    or currentRow["description"] != timelineSnapshot["description"]
                )
            if timelineChanged:
                conn.rollback()
                yield stream_event(
                    "error",
                    {
                        "code": "timeline_repair_conflict",
                        "message": "The timeline changed while it was being rebuilt. Nothing was replaced.",
                    },
                )
                return

            if currentRow:
                conn.execute(
                    """
                    UPDATE lorebook_entries
                    SET name = 'Timeline', category = 'timeline', description = ?,
                        revision = revision + 1, updated_at = ?
                    WHERE id = ? AND story_id = ?
                    """,
                    (nextTimeline, now, currentRow["id"], story_id),
                )
                entryId = currentRow["id"]
            else:
                entryId = str(uuid.uuid4())
                conn.execute(
                    """
                    INSERT INTO lorebook_entries (
                      id, story_id, name, category, description, aliases_json,
                      tags_json, metadata_json, disabled, created_at, updated_at
                    )
                    VALUES (?, ?, 'Timeline', 'timeline', ?, ?, '[]', '{}', 0, ?, ?)
                    """,
                    (
                        entryId,
                        story_id,
                        nextTimeline,
                        json.dumps(["Timeline"]),
                        now,
                        now,
                    ),
                )
            conn.execute("UPDATE stories SET updated_at = ? WHERE id = ?", (now, story_id))
            savedRow = conn.execute(
                "SELECT * FROM lorebook_entries WHERE id = ?",
                (entryId,),
            ).fetchone()

        durationMs = (time.perf_counter() - startedAt) * 1000
        yield stream_event(
            "complete",
            {
                "entry": row_to_lorebook_entry(savedRow),
                "duration_ms": durationMs,
            },
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        yield stream_event(
            "error",
            {
                "code": "timeline_repair_failed",
                "message": f"RouterChat error: {exc}",
            },
        )


@router.post("/api/stories/{story_id}/lorebook/timeline/repair/stream")
async def repair_story_timeline(
    story_id: str, payload: TimelineRepairRequest
) -> StreamingResponse:
    provider = getActiveProvider()
    if not provider.readKey():
        raise HTTPException(status_code=401, detail=provider.missingKeyMessage)

    with get_db() as conn:
        story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        visibleChapters = conn.execute(
            """
            SELECT * FROM chapters
            WHERE story_id = ? AND disabled = 0
            ORDER BY order_index ASC, created_at ASC
            """,
            (story_id,),
        ).fetchall()
        timelineRow = conn.execute(
            """
            SELECT * FROM lorebook_entries
            WHERE story_id = ?
              AND disabled = 0
              AND (category = 'timeline' OR lower(name) = lower('Timeline'))
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            """,
            (story_id,),
        ).fetchone()

    if not any(str(chapter["content"] or "").strip() for chapter in visibleChapters):
        raise HTTPException(
            status_code=422,
            detail="Add story content to a chapter that is visible in context first.",
        )

    return StreamingResponse(
        stream_timeline_repair(
            story_id,
            story,
            visibleChapters,
            timelineRow,
            payload.current_timeline,
        ),
        media_type="application/x-ndjson; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )
