import asyncio
import json
import sqlite3
import time
import uuid
from contextlib import aclosing
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.core.database import getDb
from backend.core.streamEvents import streamEvent
from backend.core.utils import utcNow
from backend.lorebook.lorebookModels import TimelineRepairRequest
from backend.lorebook.lorebookQueries import getTimelineEntry
from backend.lorebook.lorebookRows import lorebookModelFor, rowToLorebookEntry
from backend.lorebook.lorebookStream import LorebookStream
from backend.lorebook.lorebookUsage import LorebookUsage
from backend.lorebook.parseLorebook import parseLorebookJson
from backend.lorebook.timeline import normalizeTimelineDescription
from backend.providers.base import ChatOptions
from backend.providers.registry import providerForRow
from backend.stories.storyProvider import storyProvider
from backend.stories.storyQueries import listEnabledChapters, requireStory

router = APIRouter()


def timelineRepairResponseFormat() -> dict[str, Any]:
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


def parseTimelineRepair(raw_output: str) -> str:
    parsed = parseLorebookJson(raw_output)
    timeline = parsed.get("timeline")
    if not isinstance(timeline, str) or not timeline.strip():
        raise ValueError("The model returned an empty timeline.")

    normalized = normalizeTimelineDescription(timeline)
    if not normalized:
        raise ValueError("The model returned an empty timeline.")
    return normalized


async def streamTimelineRepair(
    story_id: str,
    story: sqlite3.Row,
    visible_chapters: list[sqlite3.Row],
    timeline_row: sqlite3.Row | None,
    current_timeline: str,
) -> AsyncIterator[bytes]:
    startedAt = time.perf_counter()
    provider = providerForRow(story)
    apiKey = provider.requireKey()

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
    if provider.supportsStructuredOutput(lorebookModelFor(story)):
        responseFormat = timelineRepairResponseFormat()

    request = provider.buildRequest(
        messages,
        lorebookModelFor(story),
        ChatOptions(
            apiKey=apiKey,
            temperature=0.1,
            maxTokens=story["max_tokens"],
            thinkingEnabled=True,
            reasoningEffort=story["reasoning_effort"],
            responseFormat=responseFormat,
        ),
    )
    effectiveThinkingEnabled = provider.effectiveThinkingEnabled(lorebookModelFor(story), True)

    usageRun = LorebookUsage(apiKey, story_id, lorebookModelFor(story), "timeline_repair")
    lorebookStream = LorebookStream(provider, request, usageRun, effectiveThinkingEnabled)

    yield streamEvent("status", "rebuilding")

    try:
        async with aclosing(lorebookStream.events()) as events:
            async for event in events:
                if event["type"] == "reasoning":
                    yield streamEvent("reasoning", event["value"])
                elif event["type"] == "contentStart":
                    yield streamEvent("status", "writing")

        if lorebookStream.errorMessage:
            yield streamEvent(
                "error",
                {"code": "timeline_repair_provider_error", "message": lorebookStream.errorMessage},
            )
            return

        usageValue = lorebookStream.usageEventValue()
        if usageValue:
            yield streamEvent("usage", usageValue)

        if not lorebookStream.receivedDone:
            yield streamEvent(
                "error",
                {
                    "code": "timeline_repair_incomplete",
                    "message": "Timeline repair ended before the provider completed the stream.",
                },
            )
            return
        if lorebookStream.finishReason == "length":
            yield streamEvent(
                "error",
                {
                    "code": "timeline_repair_truncated",
                    "message": "The rebuilt timeline hit the model token limit before it finished.",
                },
            )
            return

        try:
            nextTimeline = parseTimelineRepair(lorebookStream.text)
        except ValueError as exc:
            yield streamEvent(
                "error",
                {"code": "timeline_repair_invalid", "message": str(exc)},
            )
            return

        now = utcNow()
        with getDb() as conn:
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
                yield streamEvent(
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
        yield streamEvent(
            "complete",
            {
                "entry": rowToLorebookEntry(savedRow),
                "duration_ms": durationMs,
            },
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        yield streamEvent(
            "error",
            {
                "code": "timeline_repair_failed",
                "message": f"RouterChat error: {exc}",
            },
        )


@router.post("/api/stories/{story_id}/lorebook/timeline/repair/stream")
async def repairStoryTimeline(
    story_id: str, payload: TimelineRepairRequest
) -> StreamingResponse:
    provider = storyProvider(story_id)
    provider.requireKey()

    with getDb() as conn:
        story = requireStory(conn, story_id)
        visibleChapters = listEnabledChapters(conn, story_id)
        timelineRow = getTimelineEntry(conn, story_id)

    if not any(str(chapter["content"] or "").strip() for chapter in visibleChapters):
        raise HTTPException(
            status_code=422,
            detail="Add story content to a chapter that is visible in context first.",
        )

    return StreamingResponse(
        streamTimelineRepair(
            story_id,
            story,
            visibleChapters,
            timelineRow,
            payload.current_timeline,
        ),
        media_type="application/x-ndjson; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )
