import json
import sqlite3
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


DEFAULT_MAX_TOKENS = 30000
LOREBOOK_CATEGORIES = {
    "character",
    "location",
    "item",
    "event",
    "note",
    "synopsis",
    "timeline",
}


class StoryCreateRequest(BaseModel):
    title: str = Field(default="New story", min_length=1)
    author: str = ""
    language: str = "English"
    synopsis: str = ""
    model: str | None = None
    system_prompt: str = ""
    temperature: float = 0.7
    max_tokens: int = DEFAULT_MAX_TOKENS
    thinking_enabled: bool = False
    reasoning_effort: str = "medium"


class StoryPatchRequest(BaseModel):
    title: str | None = None
    author: str | None = None
    language: str | None = None
    synopsis: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    thinking_enabled: bool | None = None
    reasoning_effort: str | None = None


class ChapterCreateRequest(BaseModel):
    title: str = Field(default="New chapter", min_length=1)
    content: str = ""


class ChapterPatchRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    order_index: int | None = None


class ChapterContentRequest(BaseModel):
    content: str = ""


class LorebookEntryRequest(BaseModel):
    name: str = Field(min_length=1)
    category: str = "note"
    description: str = ""
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    disabled: bool = False


@dataclass(frozen=True)
class WritingDeps:
    get_db: Callable[[], sqlite3.Connection]
    utc_now: Callable[[], str]
    default_model_id: Callable[[], str]
    read_openrouter_key: Callable[[], str | None]
    headers_for_key: Callable[[str], dict[str, str]]
    write_system_prompt: Callable[[Any], str]
    openrouter_request_model: Callable[[str, bool], str]
    model_supports_reasoning: Callable[[str], bool]
    openrouter_error_message: Callable[[int, str], str]
    normalize_usage: Callable[[dict[str, Any] | None], dict[str, Any] | None]
    fetch_generation_usage: Callable[[str, str], Any]
    stream_event: Callable[[str, Any], bytes]
    stream_message_request: type[BaseModel]
    openrouter_base_url: str


def json_list(value: str) -> list[Any]:
    try:
        parsed = json.loads(value or "[]")
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def json_dict(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def word_count(value: str) -> int:
    return len(value.split())


def normalize_lorebook_category(category: str | None) -> str:
    value = str(category or "note").strip().lower()
    if value in {"characters", "character"}:
        return "character"
    if value in {"locations", "location"}:
        return "location"
    if value in {"items", "item"}:
        return "item"
    if value in {"events", "event"}:
        return "event"
    if value == "starting scenario":
        return "note"
    return value if value in LOREBOOK_CATEGORIES else "note"


def normalize_timeline_description(description: str) -> str:
    lines = []
    for line in str(description or "").splitlines():
        value = line.strip()
        if not value:
            continue
        if value.startswith("- "):
            lines.append(value)
            continue
        lines.append(f"- {value.removeprefix('-').removeprefix('*').strip()}")
    return "\n".join(lines)


def sanitize_lorebook_aliases(category: str, aliases: Any, fallback_name: str = "") -> list[Any]:
    if category in {"note", "synopsis"}:
        return []
    if isinstance(aliases, list):
        return aliases
    return [fallback_name] if fallback_name else []


def sanitize_lorebook_metadata(category: str, metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    if category == "character":
        blocked_keys = {"age", "physicalAppearance", "personality", "background"}
        return {key: value for key, value in metadata.items() if key not in blocked_keys}
    if category in {"note", "synopsis"}:
        return {}
    return metadata


def strip_json_fence(value: str) -> str:
    text = value.strip()
    if not text.startswith("```"):
        return text

    lines = text.splitlines()
    if len(lines) < 2:
        return text
    if lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return "\n".join(lines[1:]).strip()


def first_json_object(value: str) -> str:
    start = value.find("{")
    if start < 0:
        raise ValueError("No JSON object found in lorebook output.")

    depth = 0
    inString = False
    escapeNext = False
    for index, char in enumerate(value[start:], start):
        if escapeNext:
            escapeNext = False
            continue
        if char == "\\" and inString:
            escapeNext = True
            continue
        if char == "\"":
            inString = not inString
            continue
        if inString:
            continue
        if char == "{":
            depth += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                return value[start:index + 1]

    raise ValueError("Unclosed JSON object in lorebook output.")


def parse_lorebook_json(raw_output: str) -> dict[str, Any]:
    parse_errors: list[str] = []
    candidates = [raw_output.strip(), strip_json_fence(raw_output)]

    try:
        candidates.append(first_json_object(candidates[-1]))
    except ValueError as exc:
        parse_errors.append(str(exc))

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError as exc:
            parse_errors.append(str(exc))
            continue
        if isinstance(parsed, dict):
            return parsed
        parse_errors.append("Lorebook output JSON was not an object.")

    raise ValueError("; ".join(parse_errors) or "Could not parse lorebook JSON.")


def request_updates(payload: BaseModel) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        return payload.model_dump(exclude_unset=True)
    return payload.dict(exclude_unset=True)


def row_to_story(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "author": row["author"],
        "language": row["language"],
        "synopsis": row["synopsis"],
        "model": row["model"],
        "system_prompt": row["system_prompt"],
        "temperature": row["temperature"],
        "max_tokens": row["max_tokens"],
        "thinking_enabled": bool(row["thinking_enabled"]),
        "reasoning_effort": row["reasoning_effort"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_chapter(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "title": row["title"],
        "content": row["content"],
        "word_count": row["word_count"],
        "order_index": row["order_index"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_lorebook_entry(row: sqlite3.Row) -> dict[str, Any]:
    category = normalize_lorebook_category(row["category"])
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "name": row["name"],
        "category": category,
        "description": row["description"],
        "aliases": sanitize_lorebook_aliases(category, json_list(row["aliases_json"]), row["name"]),
        "tags": json_list(row["tags_json"]),
        "metadata": sanitize_lorebook_metadata(category, json_dict(row["metadata_json"])),
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_story_generation(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "chapter_id": row["chapter_id"],
        "model": row["model"],
        "generation_id": row["generation_id"],
        "prompt_tokens": row["prompt_tokens"],
        "completion_tokens": row["completion_tokens"],
        "reasoning_tokens": row["reasoning_tokens"],
        "total_tokens": row["total_tokens"],
        "cost": row["cost"],
        "provider_name": row["provider_name"],
        "generation_time": row["generation_time"],
        "latency": row["latency"],
        "created_at": row["created_at"],
    }


def next_chapter_order(conn: sqlite3.Connection, story_id: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order
        FROM chapters
        WHERE story_id = ?
        """,
        (story_id,),
    ).fetchone()
    return int(row["next_order"])


def build_story_messages(
    story: sqlite3.Row,
    chapter: sqlite3.Row,
    lorebook_rows: list[sqlite3.Row],
    prompt: str,
    system_prompt: str,
) -> list[dict[str, str]]:
    lorebook_text = "\n".join(
        f"- {row['name']} ({row['category']}): {row['description']}"
        for row in lorebook_rows
        if not bool(row["disabled"]) and row["description"].strip()
    )
    context_parts = [
        f"story title: {story['title']}",
        f"author: {story['author'] or 'unknown'}",
        f"language: {story['language'] or 'English'}",
        f"synopsis: {story['synopsis'] or 'none yet'}",
        f"chapter title: {chapter['title']}",
        f"current chapter draft:\n{chapter['content'] or 'empty chapter'}",
    ]
    if lorebook_text:
        context_parts.append(f"lorebook:\n{lorebook_text}")

    messages: list[dict[str, str]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    messages.append(
        {
            "role": "system",
            "content": (
                "You are writing prose for the active chapter. Return only the prose "
                "to insert into the chapter, with no analysis or wrapper text."
            ),
        }
    )
    messages.append({"role": "user", "content": "\n\n".join(context_parts)})
    messages.append({"role": "user", "content": prompt})
    return messages


def apply_lorebook_updates(
    conn: sqlite3.Connection, story_id: str, updates: list[dict[str, Any]], now: str
) -> list[dict[str, Any]]:
    applied: list[dict[str, Any]] = []
    for update in updates:
        action = str(update.get("action") or "create").lower()
        name = str(update.get("name") or "").strip()
        category = normalize_lorebook_category(update.get("category"))
        if category == "timeline":
            name = "Timeline"
            action = "update"
        if not name:
            continue
        description = str(update.get("description") or "").strip()
        if category == "timeline":
            description = normalize_timeline_description(description)
        aliases = sanitize_lorebook_aliases(category, update.get("aliases"), name)
        tags = update.get("tags") if isinstance(update.get("tags"), list) else []
        metadata = sanitize_lorebook_metadata(category, update.get("metadata"))

        if category == "timeline":
            existing = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ? AND lower(name) = lower('Timeline')
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()
        else:
            existing = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ? AND lower(name) = lower(?)
                LIMIT 1
                """,
                (story_id, name),
            ).fetchone()

        if action == "update" and existing:
            next_description = description or existing["description"]
            conn.execute(
                """
                UPDATE lorebook_entries
                SET category = ?, description = ?, aliases_json = ?, tags_json = ?,
                    metadata_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    category,
                    next_description,
                    json.dumps(aliases),
                    json.dumps(tags),
                    json.dumps(metadata),
                    now,
                    existing["id"],
                ),
            )
            applied.append({"action": "update", "id": existing["id"], "name": name})
            continue

        if existing:
            continue

        entry_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO lorebook_entries (
              id, story_id, name, category, description, aliases_json,
              tags_json, metadata_json, disabled, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?,  ?, 0, ?, ?)
            """,
            (
                entry_id,
                story_id,
                name,
                category,
                description,
                json.dumps(aliases),
                json.dumps(tags),
                json.dumps(metadata),
                now,
                now,
            ),
        )
        applied.append({"action": "create", "id": entry_id, "name": name})
    return applied


def create_writing_router(deps: WritingDeps) -> APIRouter:
    router = APIRouter()
    StreamMessageRequest = deps.stream_message_request

    def get_story_bundle(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            chapters = conn.execute(
                """
                SELECT * FROM chapters
                WHERE story_id = ?
                ORDER BY order_index ASC, created_at ASC
                """,
                (story_id,),
            ).fetchall()
            lorebook = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ?
                ORDER BY updated_at DESC, created_at DESC
                """,
                (story_id,),
            ).fetchall()
            latest_generation = conn.execute(
                """
                SELECT * FROM story_generations
                WHERE story_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()
        return {
            "story": row_to_story(story),
            "chapters": [row_to_chapter(row) for row in chapters],
            "lorebook": [row_to_lorebook_entry(row) for row in lorebook],
            "latest_generation": (
                row_to_story_generation(latest_generation) if latest_generation else None
            ),
        }

    async def update_lorebook_after_generation(
        story_id: str,
        chapter_id: str,
        generation_row_id: str,
        model: str,
        max_tokens: int,
        generated_text: str,
    ) -> dict[str, Any]:
        api_key = deps.read_openrouter_key()
        if not api_key or not generated_text.strip():
            return {"applied": []}

        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
            lorebook = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY updated_at DESC",
                (story_id,),
            ).fetchall()

        current_lore = "\n".join(
            f"- {row['name']} ({row['category']}): {row['description']}"
            for row in lorebook
            if not bool(row["disabled"])
        )
        prompt = {
            "story": row_to_story(story),
            "chapter": {"title": chapter["title"]},
            "existing_lorebook": current_lore,
            "new_prose": generated_text,
        }
        messages = [
            {
                "role": "system",
                "content": (
                    "Extract important durable lore from new prose. Return strict JSON only: "
                    "{\"updates\":[{\"action\":\"create|update\",\"name\":\"\","
                    "\"category\":\"character|location|item|event|note|synopsis|timeline\","
                    "\"description\":\"\",\"aliases\":[],\"tags\":[],\"metadata\":{}}]}. "
                    "The aliases array is only for nicknames, shortened names, titles used as "
                    "names, or alternate names explicitly used in the story to refer to this "
                    "entry. Do not put jobs, roles, species, traits, descriptions, "
                    "relationships, or categories in aliases. For note and synopsis entries, "
                    "aliases must be empty. Put character details like age, detailed physical "
                    "appearance, personality, and background into description instead of "
                    "metadata fields. "
                    "For story chronology, create or update exactly one timeline entry named "
                    "\"Timeline\" with category \"timeline\". Its description must be a "
                    "chronological Markdown bullet list. Merge new events into the existing "
                    "timeline instead of duplicating bullets. Keep each entry concise and "
                    "information-dense. Do not copy prose style from the story. Prefer short "
                    "factual summaries over long paragraphs. Preserve important concrete "
                    "details, but omit transient action, mood, and wording that does not "
                    "matter for continuity. Timeline bullets should be brief, one event per "
                    "bullet. Add only new durable events or necessary corrections."
                ),
            },
            {"role": "user", "content": json.dumps(prompt)},
        ]
        raw_output = ""
        error_text: str | None = None
        applied: list[dict[str, Any]] = []
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(
                    f"{deps.openrouter_base_url}/chat/completions",
                    headers={**deps.headers_for_key(api_key), "Content-Type": "application/json"},
                    json={
                        "model": deps.openrouter_request_model(model, False),
                        "messages": messages,
                        "temperature": 0.1,
                        "max_tokens": max_tokens,
                    },
                )
            if response.status_code >= 400:
                error_text = deps.openrouter_error_message(response.status_code, response.text)
            else:
                raw_output = (
                    response.json()
                    .get("choices", [{}])[0]
                    .get("message", {})
                    .get("content")
                    or ""
                )
                parsed = parse_lorebook_json(raw_output)
                updates = parsed.get("updates") if isinstance(parsed, dict) else []
                if not isinstance(updates, list):
                    updates = []
                with deps.get_db() as conn:
                    applied = apply_lorebook_updates(conn, story_id, updates, deps.utc_now())
        except Exception as exc:  # noqa: BLE001
            error_text = str(exc)

        with deps.get_db() as conn:
            conn.execute(
                """
                INSERT INTO lorebook_update_runs (
                  id, story_id, chapter_id, generation_id, raw_output,
                  applied_updates_json, error, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    story_id,
                    chapter_id,
                    generation_row_id,
                    raw_output or "",
                    json.dumps(applied),
                    error_text,
                    deps.utc_now(),
                ),
            )
        return {"applied": applied, "error": error_text}

    async def stream_story_generation(
        story_id: str,
        chapter_id: str,
        payload: StreamMessageRequest,
        story: sqlite3.Row,
        chapter: sqlite3.Row,
        lorebook_rows: list[sqlite3.Row],
    ) -> AsyncIterator[bytes]:
        api_key = deps.read_openrouter_key()
        if not api_key:
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

        messages = build_story_messages(
            story,
            chapter,
            lorebook_rows,
            payload.message,
            deps.write_system_prompt(payload),
        )
        body: dict[str, Any] = {
            "model": deps.openrouter_request_model(payload.model, payload.nitro_mode),
            "messages": messages,
            "temperature": payload.temperature,
            "max_tokens": payload.max_tokens,
            "stream": True,
        }
        if deps.model_supports_reasoning(payload.model) and payload.thinking_enabled:
            body["reasoning"] = {
                "enabled": True,
                "exclude": False,
                "effort": payload.reasoning_effort,
            }

        generated_text: list[str] = []
        reasoning_text: list[str] = []
        finish_reason: str | None = None
        error_text: str | None = None
        generation_id: str | None = None
        usage: dict[str, Any] | None = None
        story_generation_id = str(uuid.uuid4())

        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    f"{deps.openrouter_base_url}/chat/completions",
                    headers={**deps.headers_for_key(api_key), "Content-Type": "application/json"},
                    json=body,
                ) as response:
                    if response.status_code >= 400:
                        raw_error = (await response.aread()).decode("utf-8", errors="replace")
                        error_text = deps.openrouter_error_message(response.status_code, raw_error)
                        yield deps.stream_event("error", error_text)
                        return
                    generation_id = response.headers.get("X-Generation-Id") or generation_id

                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        generation_id = generation_id or chunk.get("id")
                        next_usage = deps.normalize_usage(chunk.get("usage"))
                        if next_usage:
                            usage = next_usage
                            continue
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finish_reason = choice.get("finish_reason") or finish_reason
                        delta = choice.get("delta") or {}
                        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                        if reasoning and payload.thinking_enabled:
                            value = str(reasoning)
                            reasoning_text.append(value)
                            yield deps.stream_event("reasoning", value)
                        content = delta.get("content")
                        if content:
                            value = str(content)
                            generated_text.append(value)
                            yield deps.stream_event("content", value)

                    if generation_id:
                        generation_usage = await deps.fetch_generation_usage(api_key, generation_id)
                        if generation_usage:
                            usage = {**(usage or {}), **generation_usage}
                    if usage:
                        yield deps.stream_event(
                            "usage",
                            {"generation_id": generation_id, "model": payload.model, **usage},
                        )
        except Exception as exc:  # noqa: BLE001
            error_text = str(exc)
            yield deps.stream_event("error", f"RouterChat error: {error_text}")
        finally:
            content = "".join(generated_text)
            now = deps.utc_now()
            with deps.get_db() as conn:
                current = conn.execute(
                    "SELECT content FROM chapters WHERE id = ? AND story_id = ?",
                    (chapter_id, story_id),
                ).fetchone()
                current_content = current["content"] if current else ""
                if content:
                    spacer = "\n\n" if current_content.strip() else ""
                    next_content = f"{current_content}{spacer}{content}"
                    conn.execute(
                        """
                        UPDATE chapters
                        SET content = ?, word_count = ?, updated_at = ?
                        WHERE id = ? AND story_id = ?
                        """,
                        (next_content, word_count(next_content), now, chapter_id, story_id),
                    )
                conn.execute(
                    """
                    INSERT INTO story_generations (
                      id, story_id, chapter_id, prompt, generated_text, model,
                      finish_reason, error, generation_id, prompt_tokens,
                      completion_tokens, reasoning_tokens, total_tokens, cost,
                      provider_name, generation_time, latency, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        story_generation_id,
                        story_id,
                        chapter_id,
                        payload.message,
                        content,
                        payload.model,
                        finish_reason,
                        error_text,
                        generation_id,
                        usage.get("prompt_tokens") if usage else None,
                        usage.get("completion_tokens") if usage else None,
                        usage.get("reasoning_tokens") if usage else None,
                        usage.get("total_tokens") if usage else None,
                        usage.get("cost") if usage else None,
                        usage.get("provider_name") if usage else None,
                        usage.get("generation_time") if usage else None,
                        usage.get("latency") if usage else None,
                        now,
                    ),
                )
                conn.execute(
                    "UPDATE stories SET updated_at = ? WHERE id = ?",
                    (now, story_id),
                )
            if content:
                yield deps.stream_event("lorebook_start", {"generation_id": story_generation_id})
            lorebook_result = await update_lorebook_after_generation(
                story_id, chapter_id, story_generation_id, payload.model, payload.max_tokens, content
            )
            yield deps.stream_event("lorebook", lorebook_result)

    @router.get("/api/stories")
    def list_stories() -> dict[str, Any]:
        with deps.get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM stories ORDER BY updated_at DESC, created_at DESC"
            ).fetchall()
        return {"stories": [row_to_story(row) for row in rows]}

    @router.post("/api/stories")
    def create_story(payload: StoryCreateRequest) -> dict[str, Any]:
        now = deps.utc_now()
        story_id = str(uuid.uuid4())
        model = payload.model or deps.default_model_id()
        with deps.get_db() as conn:
            conn.execute(
                """
                INSERT INTO stories (
                  id, title, author, language, synopsis, model, system_prompt,
                  temperature, max_tokens, thinking_enabled, reasoning_effort,
                  created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    story_id,
                    payload.title.strip() or "New story",
                    payload.author,
                    payload.language,
                    payload.synopsis,
                    model,
                    payload.system_prompt,
                    payload.temperature,
                    payload.max_tokens,
                    int(payload.thinking_enabled),
                    payload.reasoning_effort,
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        return {"story": row_to_story(row)}

    @router.get("/api/stories/{story_id}")
    def get_story(story_id: str) -> dict[str, Any]:
        return get_story_bundle(story_id)

    @router.patch("/api/stories/{story_id}")
    def update_story(story_id: str, payload: StoryPatchRequest) -> dict[str, Any]:
        updates = request_updates(payload)
        if not updates:
            return get_story_bundle(story_id)
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in updates.items():
            if key == "thinking_enabled":
                value = int(bool(value))
            if key == "title":
                value = str(value).strip() or "New story"
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        values.append(deps.utc_now())
        values.append(story_id)
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            conn.execute(f"UPDATE stories SET {', '.join(assignments)} WHERE id = ?", values)
        return get_story_bundle(story_id)

    @router.delete("/api/stories/{story_id}")
    def delete_story(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            conn.execute("DELETE FROM lorebook_update_runs WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM story_generations WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM lorebook_entries WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM chapters WHERE story_id = ?", (story_id,))
            result = conn.execute("DELETE FROM stories WHERE id = ?", (story_id,))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Story not found.")
        return {"ok": True}

    @router.get("/api/stories/{story_id}/chapters")
    def list_chapters(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            rows = conn.execute(
                """
                SELECT * FROM chapters
                WHERE story_id = ?
                ORDER BY order_index ASC, created_at ASC
                """,
                (story_id,),
            ).fetchall()
        return {"chapters": [row_to_chapter(row) for row in rows]}

    @router.post("/api/stories/{story_id}/chapters")
    def create_chapter(story_id: str, payload: ChapterCreateRequest) -> dict[str, Any]:
        now = deps.utc_now()
        chapter_id = str(uuid.uuid4())
        content = payload.content
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            conn.execute(
                """
                INSERT INTO chapters (
                  id, story_id, title, content, word_count, order_index, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chapter_id,
                    story_id,
                    payload.title.strip() or "New chapter",
                    content,
                    word_count(content),
                    next_chapter_order(conn, story_id),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
        return {"chapter": row_to_chapter(row)}

    @router.patch("/api/stories/{story_id}/chapters/{chapter_id}")
    def update_chapter(
        story_id: str, chapter_id: str, payload: ChapterPatchRequest
    ) -> dict[str, Any]:
        updates = request_updates(payload)
        if "content" in updates:
            updates["word_count"] = word_count(updates["content"])
        if "title" in updates:
            updates["title"] = str(updates["title"]).strip() or "New chapter"
        if not updates:
            return get_story_bundle(story_id)
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in updates.items():
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        values.append(deps.utc_now())
        values.extend([chapter_id, story_id])
        with deps.get_db() as conn:
            chapter = conn.execute(
                "SELECT id FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
            if not chapter:
                raise HTTPException(status_code=404, detail="Chapter not found.")
            conn.execute(
                f"UPDATE chapters SET {', '.join(assignments)} WHERE id = ? AND story_id = ?",
                values,
            )
            row = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
        return {"chapter": row_to_chapter(row)}

    @router.patch("/api/stories/{story_id}/chapters/{chapter_id}/content")
    def save_chapter_content(
        story_id: str, chapter_id: str, payload: ChapterContentRequest
    ) -> dict[str, Any]:
        return update_chapter(
            story_id,
            chapter_id,
            ChapterPatchRequest(content=payload.content),
        )

    @router.delete("/api/stories/{story_id}/chapters/{chapter_id}")
    def delete_chapter(story_id: str, chapter_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            result = conn.execute(
                "DELETE FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Chapter not found.")
        return {"ok": True}

    @router.get("/api/stories/{story_id}/lorebook")
    def list_lorebook_entries(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            rows = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ?
                ORDER BY updated_at DESC, created_at DESC
                """,
                (story_id,),
            ).fetchall()
        return {"entries": [row_to_lorebook_entry(row) for row in rows]}

    @router.post("/api/stories/{story_id}/lorebook")
    def create_lorebook_entry(story_id: str, payload: LorebookEntryRequest) -> dict[str, Any]:
        now = deps.utc_now()
        entry_id = str(uuid.uuid4())
        category = normalize_lorebook_category(payload.category)
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            conn.execute(
                """
                INSERT INTO lorebook_entries (
                  id, story_id, name, category, description, aliases_json,
                  tags_json, metadata_json, disabled, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry_id,
                    story_id,
                    payload.name.strip(),
                    category,
                    (
                        normalize_timeline_description(payload.description)
                        if category == "timeline"
                        else payload.description
                    ),
                    json.dumps(sanitize_lorebook_aliases(category, payload.aliases, payload.name.strip())),
                    json.dumps(payload.tags),
                    json.dumps(sanitize_lorebook_metadata(category, payload.metadata)),
                    int(payload.disabled),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM lorebook_entries WHERE id = ?", (entry_id,)).fetchone()
        return {"entry": row_to_lorebook_entry(row)}

    @router.patch("/api/stories/{story_id}/lorebook/{entry_id}")
    def update_lorebook_entry(
        story_id: str, entry_id: str, payload: LorebookEntryRequest
    ) -> dict[str, Any]:
        now = deps.utc_now()
        category = normalize_lorebook_category(payload.category)
        with deps.get_db() as conn:
            entry = conn.execute(
                "SELECT id FROM lorebook_entries WHERE id = ? AND story_id = ?",
                (entry_id, story_id),
            ).fetchone()
            if not entry:
                raise HTTPException(status_code=404, detail="Lorebook entry not found.")
            conn.execute(
                """
                UPDATE lorebook_entries
                SET name = ?, category = ?, description = ?, aliases_json = ?,
                    tags_json = ?, metadata_json = ?, disabled = ?, updated_at = ?
                WHERE id = ? AND story_id = ?
                """,
                (
                    payload.name.strip(),
                    category,
                    (
                        normalize_timeline_description(payload.description)
                        if category == "timeline"
                        else payload.description
                    ),
                    json.dumps(sanitize_lorebook_aliases(category, payload.aliases, payload.name.strip())),
                    json.dumps(payload.tags),
                    json.dumps(sanitize_lorebook_metadata(category, payload.metadata)),
                    int(payload.disabled),
                    now,
                    entry_id,
                    story_id,
                ),
            )
            row = conn.execute("SELECT * FROM lorebook_entries WHERE id = ?", (entry_id,)).fetchone()
        return {"entry": row_to_lorebook_entry(row)}

    @router.delete("/api/stories/{story_id}/lorebook/{entry_id}")
    def delete_lorebook_entry(story_id: str, entry_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            result = conn.execute(
                "DELETE FROM lorebook_entries WHERE id = ? AND story_id = ?",
                (entry_id, story_id),
            )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Lorebook entry not found.")
        return {"ok": True}

    @router.post("/api/stories/{story_id}/chapters/{chapter_id}/generate/stream")
    async def stream_story_chapter_generation(
        story_id: str,
        chapter_id: str,
        payload: StreamMessageRequest,
    ) -> StreamingResponse:
        if not deps.read_openrouter_key():
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
        if not payload.message.strip():
            raise HTTPException(status_code=400, detail="Message cannot be empty.")

        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
            if not chapter:
                raise HTTPException(status_code=404, detail="Chapter not found.")
            lorebook_rows = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY updated_at DESC",
                (story_id,),
            ).fetchall()
            conn.execute(
                """
                UPDATE stories
                SET model = ?, system_prompt = ?, temperature = ?, max_tokens = ?,
                    thinking_enabled = ?, reasoning_effort = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.model,
                    deps.write_system_prompt(payload),
                    payload.temperature,
                    payload.max_tokens,
                    int(payload.thinking_enabled),
                    payload.reasoning_effort,
                    deps.utc_now(),
                    story_id,
                ),
            )

        return StreamingResponse(
            stream_story_generation(
                story_id,
                chapter_id,
                payload,
                story,
                chapter,
                lorebook_rows,
            ),
            media_type="application/x-ndjson; charset=utf-8",
        )

    return router
