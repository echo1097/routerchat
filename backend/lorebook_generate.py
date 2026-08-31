import asyncio
import json
import time
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.lorebook import (
    LorebookDeps,
    OPENROUTER_TIMEOUT,
    SUMMARY_INSTRUCTION,
    normalize_lorebook_category,
    parse_lorebook_json,
    sanitize_lorebook_aliases,
)


GENERATE_CATEGORIES = ["character", "location", "item", "event", "note", "synopsis"]

#the shared half of the prompt, every category gets this plus its own paragraph below
GENERATE_BASE_PROMPT = (
    "You are drafting a single lorebook entry for a story. Use author_brief when it is present.\n"
    "Write a dense factual continuity note, not prose, and do not copy the story's writing style. "
    "Stay consistent with story and existing_entries: never contradict what is already there, and "
    "never write a duplicate of an entry that already exists. Outside chapter summaries, invent "
    "whatever the brief leaves open while staying consistent with the story's setting and tone.\n"
    "The name is what the story calls this entry, short and without an article or a description "
    "tacked on. The aliases array is only for nicknames, shortened names, titles used as names, or "
    "alternate names, never jobs, roles, species, traits, or relationships, and it can be empty. "
    "The notes field is for extra structured details that do not belong in the description, and it "
    "can be an empty string.\n"
    "When author_instructions is present it holds the story author's own instructions for this "
    "story. Follow the parts that apply to lorebook entries, such as entry length, level of "
    "detail, naming conventions, and language. Ignore the parts about writing prose or chapter "
    "structure, and never let it override the rules here or the JSON shape.\n"
    "Return strict JSON only in this shape: {\"name\":\"\",\"description\":\"\",\"aliases\":[],"
    "\"notes\":\"\"}."
)

#one small nudge per entry type, this is what makes a character read differently from a location
GENERATE_CATEGORY_PROMPTS = {
    "character": (
        "You are writing a character entry. The description covers who they are, their age, their "
        "physical appearance, how they speak and act, their personality, their background, and "
        "their relationships to anyone else the story already knows about. Leave the notes field "
        "empty for characters, everything belongs in the description."
    ),
    "location": (
        "You are writing a location entry. The description covers what the place is, what it looks "
        "and feels like, where it sits relative to other known places, who is usually there, and "
        "what happens there that matters to the story."
    ),
    "item": (
        "You are writing an item entry. The description covers what the object is, what it looks "
        "like, what it does, where it came from, who holds it, and why it matters to the story."
    ),
    "event": (
        "You are writing an event entry. The description covers what happened, when it happened "
        "relative to the rest of the story, who was involved, and what changed because of it. "
        "Write it in past tense as a settled fact."
    ),
    "note": (
        "You are writing a free note for the author. The description is whatever standing rule, "
        "reminder, or piece of background the brief asks for, written plainly so the model writing "
        "the story can follow it. Return an empty aliases array and an empty notes field."
    ),
    "synopsis": (
        f"You are writing a chapter summary from chapter, which is the only source of truth. "
        f"{SUMMARY_INSTRUCTION} Return an empty aliases array and an empty notes field."
    ),
}


class GenerateEntryRequest(BaseModel):
    category: str = "character"
    brief: str = ""
    chapter_id: str | None = None


def lorebook_generate_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "lorebook_entry",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string", "minLength": 1},
                    "description": {"type": "string", "minLength": 1},
                    "aliases": {"type": "array", "items": {"type": "string"}},
                    "notes": {"type": "string"},
                },
                "required": ["name", "description", "aliases", "notes"],
            },
        },
    }


def parse_generated_entry(raw_output: str, category: str) -> dict[str, Any]:
    parsed = parse_lorebook_json(raw_output)

    name = str(parsed.get("name") or "").strip()
    description = str(parsed.get("description") or "").strip()
    if not name or not description:
        raise ValueError("The generated entry was missing a name or a description.")

    aliases = [
        str(alias).strip()
        for alias in sanitize_lorebook_aliases(category, parsed.get("aliases"))
        if str(alias).strip()
    ]
    #the notes field only exists on the categories whose editor actually shows it
    notes = "" if category in {"character", "note", "synopsis"} else str(parsed.get("notes") or "").strip()

    return {
        "name": name,
        "category": category,
        "description": description,
        "aliases": aliases,
        "notes": notes,
        "metadata": {},
    }


def create_lorebook_generate_router(deps: LorebookDeps) -> APIRouter:
    router = APIRouter()

    async def stream_entry_generation(
        story: Any,
        category: str,
        brief: str,
        existing_entries: list[Any],
        chapter: Any | None = None,
    ) -> AsyncIterator[bytes]:
        startedAt = time.perf_counter()
        apiKey = deps.read_openrouter_key()
        if not apiKey:
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

        prompt: dict[str, Any] = {
            "entry_category": category,
            "story": {
                "title": story["title"],
                "author": story["author"],
                "language": story["language"],
                "synopsis": story["synopsis"],
            },
            #names and descriptions only, enough to stay consistent without shipping the whole book
            "existing_entries": [
                {
                    "name": row["name"],
                    "category": normalize_lorebook_category(row["category"]),
                    "description": row["description"] or "",
                }
                for row in existing_entries
            ],
        }
        if brief:
            prompt["author_brief"] = brief
        if chapter is not None:
            prompt["chapter"] = {
                "id": chapter["id"],
                "title": chapter["title"],
                "content": chapter["content"] or "",
            }

        authorInstructions = str(story["system_prompt"] or "").strip()
        if authorInstructions:
            prompt["author_instructions"] = authorInstructions

        systemPrompt = (
            f"{GENERATE_BASE_PROMPT}\n"
            f"{GENERATE_CATEGORY_PROMPTS.get(category, GENERATE_CATEGORY_PROMPTS['note'])}"
        )
        body: dict[str, Any] = {
            "model": deps.openrouter_request_model(story["model"], False),
            "messages": [
                {"role": "system", "content": systemPrompt},
                {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
            ],
            "temperature": 0.7,
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
            body["response_format"] = lorebook_generate_response_format()

        generatedText: list[str] = []
        finishReason: str | None = None
        generationId: str | None = None
        usage: dict[str, Any] | None = None
        receivedDone = False
        announcedWriting = False

        #a model with thinking off never sends reasoning, so the editor should say Writing from the start
        yield deps.stream_event("status", "thinking" if effectiveThinkingEnabled else "writing")

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
                            {"code": "lorebook_generate_provider_error", "message": message},
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
                            #first real content means the thinking is done and the entry is being written
                            if not announcedWriting:
                                announcedWriting = True
                                yield deps.stream_event("status", "writing")
                            generatedText.append(str(content))
                            #the editor renders the entry as it lands, so the raw delta goes out too
                            yield deps.stream_event("content", str(content))

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
                        "code": "lorebook_generate_incomplete",
                        "message": "Entry generation ended before the provider completed the stream.",
                    },
                )
                return
            if finishReason == "length":
                yield deps.stream_event(
                    "error",
                    {
                        "code": "lorebook_generate_truncated",
                        "message": "The generated entry hit the model token limit before it finished.",
                    },
                )
                return

            try:
                entry = parse_generated_entry("".join(generatedText), category)
            except ValueError as exc:
                yield deps.stream_event(
                    "error",
                    {"code": "lorebook_generate_invalid", "message": str(exc)},
                )
                return

            if category == "synopsis" and chapter is not None:
                entry["name"] = str(chapter["title"])
                entry["metadata"] = {"chapter_id": str(chapter["id"])}

            #nothing is saved here, the draft goes back to the editor and the author decides
            durationMs = (time.perf_counter() - startedAt) * 1000
            yield deps.stream_event("complete", {"entry": entry, "duration_ms": durationMs})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            yield deps.stream_event(
                "error",
                {
                    "code": "lorebook_generate_failed",
                    "message": f"RouterChat error: {exc}",
                },
            )

    @router.post("/api/stories/{story_id}/lorebook/generate/stream")
    async def generate_lorebook_entry(
        story_id: str,
        payload: GenerateEntryRequest,
    ) -> StreamingResponse:
        if not deps.read_openrouter_key():
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

        category = normalize_lorebook_category(payload.category)
        if category not in GENERATE_CATEGORIES:
            raise HTTPException(status_code=422, detail="That entry type cannot be generated.")
        brief = str(payload.brief or "").strip()
        if category != "synopsis" and not brief:
            raise HTTPException(status_code=422, detail="Describe what the entry should be first.")

        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            chapter = None
            if category == "synopsis":
                chapterId = str(payload.chapter_id or "").strip()
                if not chapterId:
                    raise HTTPException(status_code=422, detail="Choose a chapter to summarize.")
                chapter = conn.execute(
                    """
                    SELECT * FROM chapters
                    WHERE id = ? AND story_id = ? AND disabled = 0
                    """,
                    (chapterId, story_id),
                ).fetchone()
                if not chapter:
                    raise HTTPException(status_code=404, detail="Chapter not found or hidden from context.")
                if not str(chapter["content"] or "").strip():
                    raise HTTPException(status_code=422, detail="Write something in this chapter first.")
            existingEntries = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ? AND disabled = 0
                ORDER BY updated_at DESC, created_at DESC
                """,
                (story_id,),
            ).fetchall()

        return StreamingResponse(
            stream_entry_generation(story, category, brief, existingEntries, chapter),
            media_type="application/x-ndjson; charset=utf-8",
            headers={"Cache-Control": "no-store"},
        )

    return router
