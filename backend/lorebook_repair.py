import asyncio
import json
import sqlite3
import time
import uuid
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.writing import (
    OPENROUTER_TIMEOUT,
    SUMMARY_INSTRUCTION,
    WritingDeps,
    lorebook_summary_chapter_id,
    normalize_lorebook_category,
    normalize_timeline_description,
    parse_lorebook_json,
    row_to_lorebook_entry,
    sanitize_lorebook_aliases,
)


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


def create_lorebook_repair_router(deps: WritingDeps) -> APIRouter:
    router = APIRouter()

    async def stream_lorebook_repair(
        story_id: str,
        story: sqlite3.Row,
        visible_chapters: list[sqlite3.Row],
        visible_lorebook: list[sqlite3.Row],
        preserved_summaries: list[sqlite3.Row],
    ) -> AsyncIterator[bytes]:
        startedAt = time.perf_counter()
        apiKey = deps.read_openrouter_key()
        if not apiKey:
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

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
        body: dict[str, Any] = {
            "model": deps.openrouter_request_model(story["model"], False),
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": story["max_tokens"],
            "stream": True,
        }
        providerOptions = deps.openrouter_provider_options()
        if providerOptions:
            body["provider"] = providerOptions

        effectiveThinkingEnabled = deps.effective_thinking_enabled(story["model"], True)
        reasoningConfig = deps.enabled_reasoning_config(
            story["model"], True, story["reasoning_effort"]
        )
        if reasoningConfig:
            body["reasoning"] = reasoningConfig
        if deps.model_supports_structured_output(story["model"]):
            body["response_format"] = lorebook_repair_response_format(summaryChapters)

        generatedText: list[str] = []
        finishReason: str | None = None
        generationId: str | None = None
        usage: dict[str, Any] | None = None
        receivedDone = False
        announcedWriting = False

        yield deps.stream_event("status", "rebuilding")

        try:
            async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    f"{deps.openrouter_base_url}/chat/completions",
                    headers={**deps.headers_for_key(apiKey), "Content-Type": "application/json"},
                    json=body,
                ) as response:
                    if response.status_code >= 400:
                        rawError = (await response.aread()).decode("utf-8", errors="replace")
                        message = deps.openrouter_error_message(response.status_code, rawError)
                        yield deps.stream_event(
                            "error",
                            {"code": "lorebook_repair_provider_error", "message": message},
                        )
                        return

                    generationId = response.headers.get("X-Generation-Id") or generationId
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            receivedDone = True
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue

                        generationId = generationId or chunk.get("id")
                        nextUsage = deps.normalize_usage(chunk.get("usage"))
                        if nextUsage:
                            usage = nextUsage
                            continue

                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finishReason = choice.get("finish_reason") or finishReason
                        delta = choice.get("delta") or {}
                        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                        if reasoning and effectiveThinkingEnabled:
                            yield deps.stream_event("reasoning", str(reasoning))
                        content = delta.get("content")
                        if content:
                            #first real content means the thinking is done and the lorebook is being written
                            if not announcedWriting:
                                announcedWriting = True
                                yield deps.stream_event("status", "writing")
                            generatedText.append(str(content))

            if generationId:
                try:
                    generationUsage = await deps.fetch_generation_usage(apiKey, generationId)
                    if generationUsage:
                        usage = {**(usage or {}), **generationUsage}
                except Exception:  # noqa: BLE001
                    pass
            if usage:
                yield deps.stream_event(
                    "usage",
                    {"generation_id": generationId, "model": story["model"], **usage},
                )

            if not receivedDone:
                yield deps.stream_event(
                    "error",
                    {
                        "code": "lorebook_repair_incomplete",
                        "message": "Lorebook repair ended before the provider completed the stream.",
                    },
                )
                return
            if finishReason == "length":
                yield deps.stream_event(
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
                yield deps.stream_event(
                    "error",
                    {"code": "lorebook_repair_invalid", "message": str(exc)},
                )
                return

            now = deps.utc_now()
            with deps.get_db() as conn:
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
                    yield deps.stream_event(
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
            yield deps.stream_event(
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
            yield deps.stream_event(
                "error",
                {
                    "code": "lorebook_repair_failed",
                    "message": f"RouterChat error: {exc}",
                },
            )

    #no request body, the server already has everything a rebuild needs
    @router.post("/api/stories/{story_id}/lorebook/repair/stream")
    async def repair_story_lorebook(story_id: str) -> StreamingResponse:
        if not deps.read_openrouter_key():
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

        with deps.get_db() as conn:
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

    return router
