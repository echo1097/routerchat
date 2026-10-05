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
from backend.lorebook.chapterSummaries import (
    SUMMARY_INSTRUCTION,
    lorebook_summary_chapter_id,
)
from backend.lorebook.lorebookRows import (
    lorebook_model_for,
    normalize_lorebook_category,
    row_to_lorebook_entry,
    sanitize_lorebook_aliases,
)
from backend.lorebook.lorebookUsage import LorebookUsage
from backend.lorebook.parseLorebook import parse_lorebook_json
from backend.lorebook.timeline import normalize_timeline_description
from backend.providers.base import ChatOptions
from backend.providers.registry import providerForRow
from backend.writing.storyProvider import storyProvider
from backend.providers.streaming import streamChat

REPAIR_CATEGORIES = ["character", "location", "item", "event", "note", "timeline"]

REPAIR_SYSTEM_PROMPT = (
    "You are rebuilding a story's lorebook from scratch. The existing lorebook in "
    "current_lorebook is stale: it was written incrementally chapter by chapter, so it is "
    "expected to contain outdated facts, details the story later contradicted, entries for "
    "things that no longer matter, duplicates under slightly different names, and plain "
    "mistakes. Treat visible_chapters as the only source of truth. Use current_lorebook only "
    "as a hint about what someone once thought was worth tracking, and keep its wording only "
    "where the chapters still support it. Correct anything the chapters disagree with and drop "
    "anything the chapters do not support at all.\n"
    "Return the complete replacement lorebook: every entry you return is kept and everything "
    "you leave out is gone, so do not return a partial list or a list of changes. Write one "
    "entry per durable subject that matters for continuity. Merge duplicates into a single "
    "entry under the name the story uses most.\n"
    "Categories for entries: character, location, item, event, note, timeline. Include exactly "
    "one entry named \"Timeline\" with "
    "category \"timeline\" whose description is a chronological Markdown bullet list, one "
    "concise factual event per bullet, earliest to latest, covering every durable event needed "
    "to follow the story.\n"
    "Descriptions are dense factual continuity notes, not prose. Do not copy the story's "
    "writing style. For characters put age, physical appearance, personality, and background "
    "into the description. The aliases array is only for nicknames, shortened names, titles "
    "used as names, or alternate names the story actually uses for that entry, never jobs, "
    "roles, species, traits, or relationships, and it must be empty for note entries. Never "
    "invent facts that are not in the chapters.\n"
    f"{SUMMARY_INSTRUCTION} Return exactly one item in summaries for every chapter in "
    "visible_chapters, keyed by that chapter's id.\n"
    "When author_instructions is present it holds the story author's own instructions for this "
    "story. Follow the parts of it that apply to lorebook entries, such as entry length, level "
    "of detail, naming conventions, and language. Ignore the parts about writing prose or "
    "chapter structure, and never let it override the rules above or the JSON shape below.\n"
    "Return strict JSON only in this shape: {\"entries\":[{\"name\":\"\",\"category\":\"\","
    "\"description\":\"\",\"aliases\":[]}],\"summaries\":{\"chapter-id\":{"
    "\"name\":\"\",\"description\":\"\"}}}."
)


def lorebook_repair_response_format(summary_chapters: list[sqlite3.Row]) -> dict[str, Any]:
    summaryProperties = {
        str(chapter["id"]): {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "name": {"type": "string", "minLength": 1},
                "description": {"type": "string", "minLength": 1},
            },
            "required": ["name", "description"],
        }
        for chapter in summary_chapters
    }

    return {
        "type": "json_schema",
        "json_schema": {
            "name": "lorebook_repair",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "entries": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "name": {"type": "string", "minLength": 1},
                                "category": {"type": "string", "enum": REPAIR_CATEGORIES},
                                "description": {"type": "string", "minLength": 1},
                                "aliases": {"type": "array", "items": {"type": "string"}},
                            },
                            "required": ["name", "category", "description", "aliases"],
                        },
                    },
                    "summaries": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": summaryProperties,
                        "required": list(summaryProperties),
                    },
                },
                "required": ["entries", "summaries"],
            },
        },
    }


def parse_lorebook_repair(
    raw_output: str,
    summary_chapters: list[sqlite3.Row],
) -> list[dict[str, Any]]:
    parsed = parse_lorebook_json(raw_output)
    rawEntries = parsed.get("entries")
    if not isinstance(rawEntries, list):
        raise ValueError("The rebuilt lorebook was missing its entries array.")

    entries: list[dict[str, Any]] = []
    seenNames: set[str] = set()
    seenTimeline = False

    for rawEntry in rawEntries:
        if not isinstance(rawEntry, dict):
            continue

        name = str(rawEntry.get("name") or "").strip()
        category = normalize_lorebook_category(rawEntry.get("category"))
        description = str(rawEntry.get("description") or "").strip()

        if category == "synopsis":
            continue
        if category == "timeline":
            name = "Timeline"
            description = normalize_timeline_description(description)
            #one timeline or none, a second one would just fight the first for the same slot
            if seenTimeline:
                continue
            seenTimeline = True

        if not name or not description:
            continue

        nameKey = name.casefold()
        if nameKey in seenNames:
            continue
        seenNames.add(nameKey)

        entries.append(
            {
                "name": name,
                "category": category,
                "description": description,
                "aliases": sanitize_lorebook_aliases(category, rawEntry.get("aliases"), name),
            }
        )

    if not entries:
        raise ValueError("The model returned an empty lorebook.")

    rawSummaries = parsed.get("summaries")
    if not isinstance(rawSummaries, dict):
        raise ValueError("The rebuilt lorebook was missing its chapter summaries.")

    chapterById = {str(chapter["id"]): chapter for chapter in summary_chapters}
    summariesById: dict[str, dict[str, Any]] = {}
    for chapterId, rawSummary in rawSummaries.items():
        if not isinstance(rawSummary, dict):
            raise ValueError("The rebuilt lorebook returned invalid chapter summaries.")
        chapterId = str(chapterId).strip()
        description = str(rawSummary.get("description") or "").strip()
        if chapterId not in chapterById or not description or chapterId in summariesById:
            raise ValueError("The rebuilt lorebook returned invalid chapter summaries.")
        chapter = chapterById[chapterId]
        summariesById[chapterId] = {
            "name": str(chapter["title"]),
            "category": "synopsis",
            "description": description,
            "aliases": [],
            "metadata": {"chapter_id": chapterId},
        }

    if set(summariesById) != set(chapterById):
        raise ValueError("The rebuilt lorebook must contain one summary for every visible chapter.")

    entries.extend(summariesById[chapterId] for chapterId in chapterById)
    return entries


def visible_lorebook_signature(rows: list[sqlite3.Row]) -> list[tuple[str, str]]:
    #id plus updated_at is enough to notice an auto lorebook run landing while this one was thinking
    return sorted((str(row["id"]), str(row["updated_at"])) for row in rows)


router = APIRouter()


async def stream_lorebook_repair(
    story_id: str,
    story: sqlite3.Row,
    visible_chapters: list[sqlite3.Row],
    visible_lorebook: list[sqlite3.Row],
    preserved_summaries: list[sqlite3.Row],
) -> AsyncIterator[bytes]:
    startedAt = time.perf_counter()
    provider = providerForRow(story)
    apiKey = provider.requireKey()

    lorebookSignature = visible_lorebook_signature(visible_lorebook)
    summaryChapters = [
        chapter for chapter in visible_chapters if str(chapter["content"] or "").strip()
    ]
    preservedIds = {str(row["id"]) for row in preserved_summaries}
    prompt = {
        "story": {
            "title": story["title"],
            "author": story["author"],
            "language": story["language"],
            "synopsis": story["synopsis"],
        },
        "current_lorebook": [
            {
                "name": row["name"],
                "category": normalize_lorebook_category(row["category"]),
                "description": row["description"] or "",
            }
            for row in visible_lorebook
            if str(row["id"]) not in preservedIds
        ],
        "visible_chapters": [
            {
                "id": chapter["id"],
                "title": chapter["title"],
                "content": chapter["content"] or "",
            }
            for chapter in summaryChapters
        ],
    }

    #the author's own story instructions, sent so entry style rules get honored, skipped when blank so the model isnt handed an empty key to wonder about
    authorInstructions = str(story["system_prompt"] or "").strip()
    if authorInstructions:
        prompt["author_instructions"] = authorInstructions

    messages = [
        {"role": "system", "content": REPAIR_SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
    ]
    responseFormat = None
    if provider.supportsStructuredOutput(lorebook_model_for(story)):
        responseFormat = lorebook_repair_response_format(summaryChapters)

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
    usageRun = LorebookUsage(apiKey, story_id, lorebook_model_for(story), "repair")
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
                            {"code": "lorebook_repair_provider_error", "message": event["message"]},
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
                        #first real content means the thinking is done and the lorebook is being written
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
                    "code": "lorebook_repair_incomplete",
                    "message": "Lorebook repair ended before the provider completed the stream.",
                },
            )
            return
        if finishReason == "length":
            yield stream_event(
                "error",
                {
                    "code": "lorebook_repair_truncated",
                    "message": "The rebuilt lorebook hit the model token limit before it finished.",
                },
            )
            return

        try:
            nextEntries = parse_lorebook_repair("".join(generatedText), summaryChapters)
        except ValueError as exc:
            yield stream_event(
                "error",
                {"code": "lorebook_repair_invalid", "message": str(exc)},
            )
            return

        now = utc_now()
        with get_db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            currentRows = conn.execute(
                """
                SELECT id, updated_at FROM lorebook_entries
                WHERE story_id = ? AND disabled = 0
                """,
                (story_id,),
            ).fetchall()

            if visible_lorebook_signature(currentRows) != lorebookSignature:
                conn.rollback()
                yield stream_event(
                    "error",
                    {
                        "code": "lorebook_repair_conflict",
                        "message": "The lorebook changed while it was being rebuilt. Nothing was replaced.",
                    },
                )
                return

            #hidden lorebook rows and enabled summaries for hidden chapters both survive rebuild
            for currentRow in currentRows:
                if str(currentRow["id"]) in preservedIds:
                    continue
                conn.execute(
                    "DELETE FROM lorebook_entries WHERE id = ?",
                    (currentRow["id"],),
                )
            for entry in nextEntries:
                conn.execute(
                    """
                    INSERT INTO lorebook_entries (
                      id, story_id, name, category, description, aliases_json,
                      tags_json, metadata_json, disabled, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 0, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        story_id,
                        entry["name"],
                        entry["category"],
                        entry["description"],
                        json.dumps(entry["aliases"]),
                        json.dumps(entry.get("metadata") or {}),
                        now,
                        now,
                    ),
                )
            conn.execute("UPDATE stories SET updated_at = ? WHERE id = ?", (now, story_id))
            savedRows = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ?
                ORDER BY updated_at DESC, created_at DESC
                """,
                (story_id,),
            ).fetchall()

        durationMs = (time.perf_counter() - startedAt) * 1000
        yield stream_event(
            "complete",
            {
                "entries": [row_to_lorebook_entry(row) for row in savedRows],
                "entry_count": len(nextEntries) + len(preserved_summaries),
                "removed_count": len(visible_lorebook) - len(preserved_summaries),
                "duration_ms": durationMs,
            },
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        yield stream_event(
            "error",
            {
                "code": "lorebook_repair_failed",
                "message": f"RouterChat error: {exc}",
            },
        )


#no request body, the server already has everything a rebuild needs
@router.post("/api/stories/{story_id}/lorebook/repair/stream")
async def repair_story_lorebook(story_id: str) -> StreamingResponse:
    provider = storyProvider(story_id)
    provider.requireKey()

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
        hiddenChapterIds = {
            str(row["id"])
            for row in conn.execute(
                "SELECT id FROM chapters WHERE story_id = ? AND disabled = 1",
                (story_id,),
            ).fetchall()
        }
        visibleLorebook = conn.execute(
            """
            SELECT * FROM lorebook_entries
            WHERE story_id = ? AND disabled = 0
            ORDER BY updated_at DESC, created_at DESC
            """,
            (story_id,),
        ).fetchall()
        preservedSummaries = [
            row
            for row in visibleLorebook
            if lorebook_summary_chapter_id(row) in hiddenChapterIds
        ]

    if not any(str(chapter["content"] or "").strip() for chapter in visibleChapters):
        raise HTTPException(
            status_code=422,
            detail="Add story content to a chapter that is visible in context first.",
        )

    return StreamingResponse(
        stream_lorebook_repair(
            story_id,
            story,
            visibleChapters,
            visibleLorebook,
            preservedSummaries,
        ),
        media_type="application/x-ndjson; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )
