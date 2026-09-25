import json
import sqlite3
import uuid
from typing import Any, AsyncIterator

import httpx

from backend.core.database import get_db
from backend.core.utils import display_model_name, utc_now
from backend.lorebook.chapterSummaries import (
    lorebook_summary_chapter_id,
    normalize_required_summary_update,
)
from backend.lorebook.lorebookHistory import lorebook_run_history_actions
from backend.lorebook.lorebookRows import (
    json_list,
    lorebook_model_for,
    normalize_lorebook_category,
    row_to_lorebook_entry,
    sanitize_lorebook_aliases,
)
from backend.lorebook.lorebookUsage import LorebookUsage
from backend.lorebook.parseLorebook import parse_lorebook_json
from backend.lorebook.targetedUpdates import apply_lorebook_updates
from backend.lorebook.updateSchema import (
    LOREBOOK_UPDATE_SYSTEM_PROMPT,
    lorebook_update_response_format,
)
from backend.providers.openrouter.apiKey import read_openrouter_key
from backend.providers.openrouter.client import (
    OPENROUTER_BASE_URL,
    OPENROUTER_TIMEOUT,
    headers_for_key,
)
from backend.providers.openrouter.errors import openrouter_error_message
from backend.providers.openrouter.models import model_supports_structured_output
from backend.providers.openrouter.requestOptions import (
    effective_thinking_enabled,
    enabled_reasoning_config,
    openrouter_provider_options,
    openrouter_request_model,
)
from backend.providers.openrouter.usage import normalize_usage
from backend.writing.storyRows import insert_chapter_history_entry, row_to_story


#used to be one blocking post, now it streams so write mode can show the thinking while it works.
#yields {"type": "reasoning"} chunks as they land, one {"type": "content"} the moment json generation
#starts, and exactly one {"type": "result"} at the end
async def run_lorebook_update(
    story_id: str,
    chapter_id: str,
    source_text: str,
    model: str,
    max_tokens: int,
    generation_row_id: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    api_key = read_openrouter_key()
    if not api_key or not source_text.strip():
        yield {
            "type": "result",
            "value": {"applied": [], "skipped": [], "skipped_run": True},
        }
        return

    with get_db() as conn:
        story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        chapter = conn.execute(
            "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
            (chapter_id, story_id),
        ).fetchone()
        lorebook = conn.execute(
            "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY updated_at DESC",
            (story_id,),
        ).fetchall()

    current_lore = [
        {
            "entryId": row["id"],
            "entryRevision": row["revision"],
            "name": row["name"],
            "category": normalize_lorebook_category(row["category"]),
            "description": row["description"] or "",
            "aliases": sanitize_lorebook_aliases(
                normalize_lorebook_category(row["category"]),
                json_list(row["aliases_json"]),
                row["name"],
            ),
            "tags": json_list(row["tags_json"]),
            "chapterId": lorebook_summary_chapter_id(row) or None,
        }
        for row in lorebook
        if not bool(row["disabled"])
    ]
    prompt = {
        "story": row_to_story(story),
        "chapter": {"id": chapter["id"], "title": chapter["title"]},
        "existing_lorebook": current_lore,
        "new_prose": source_text,
    }
    messages = [
        {"role": "system", "content": LOREBOOK_UPDATE_SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(prompt)},
    ]
    body: dict[str, Any] = {
        "model": openrouter_request_model(model, False),
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "stream": True,
    }
    providerOptions = openrouter_provider_options()
    if providerOptions:
        body["provider"] = providerOptions

    thinking_enabled = effective_thinking_enabled(model, True)
    reasoning_config = enabled_reasoning_config(model, True, story["reasoning_effort"])
    if reasoning_config:
        body["reasoning"] = reasoning_config
    if model_supports_structured_output(model):
        body["response_format"] = lorebook_update_response_format()

    raw_output = ""
    error_text: str | None = None
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    usageRun = LorebookUsage(api_key, story_id, model, "update", chapter_id)
    generated_text: list[str] = []
    finish_reason: str | None = None
    receivedDone = False
    content_started = False
    try:
        async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client, usageRun:
            async with client.stream(
                "POST",
                f"{OPENROUTER_BASE_URL}/chat/completions",
                headers={**headers_for_key(api_key), "Content-Type": "application/json"},
                json=body,
            ) as response:
                usageRun.generationId = response.headers.get("X-Generation-Id")
                if response.status_code >= 400:
                    raw_error = (await response.aread()).decode("utf-8", errors="replace")
                    error_text = openrouter_error_message(response.status_code, raw_error)
                else:
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

                        usageRun.generationId = usageRun.generationId or chunk.get("id")
                        usageRun.addUsage(normalize_usage(chunk.get("usage")))

                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finish_reason = choice.get("finish_reason") or finish_reason
                        delta = choice.get("delta") or {}
                        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                        if reasoning and thinking_enabled:
                            yield {"type": "reasoning", "value": str(reasoning)}
                        content = delta.get("content")
                        if content:
                            if not content_started:
                                content_started = True
                                yield {"type": "content"}
                            generated_text.append(str(content))

        raw_output = "".join(generated_text)
        #a cut off response is never valid json anyway, so say why instead of letting the parser guess
        if finish_reason == "length":
            error_text = "The lorebook update hit the model token limit before it finished."
        elif not receivedDone and not error_text:
            error_text = "The lorebook update ended before the provider completed the stream."
        elif not error_text:
            parsed = parse_lorebook_json(raw_output)
            updates = parsed.get("updates") if isinstance(parsed, dict) else []
            if not isinstance(updates, list):
                updates = []
            updates = normalize_required_summary_update(updates, chapter, lorebook)
            with get_db() as conn:
                applyResult = apply_lorebook_updates(
                    conn, story_id, updates, utc_now()
                )
                applied = applyResult["applied"]
                skipped = applyResult["skipped"]
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO lorebook_update_runs (
              id, story_id, chapter_id, generation_id, openrouter_generation_id,
              raw_output, applied_updates_json, rejected_updates_json, cost, error, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                usageRun.requestId,
                story_id,
                chapter_id,
                generation_row_id,
                usageRun.generationId,
                raw_output or "",
                json.dumps(applied),
                json.dumps(skipped),
                usageRun.usage.get("cost"),
                error_text,
                utc_now(),
            ),
        )

    yield {
        "type": "result",
        "value": {
            "applied": applied,
            "skipped": skipped,
            "skipped_run": False,
            "error": error_text,
            "cost": usageRun.usage.get("cost"),
        },
    }


#the manual and streaming lorebook endpoints both need the same history rows and the same fresh entry list
def finalize_lorebook_update(
    story_id: str,
    chapter_id: str,
    story: sqlite3.Row,
    result: dict[str, Any],
    duration_ms: float,
) -> dict[str, Any]:
    applied = result.get("applied") or []
    skipped = result.get("skipped") or []
    actions = lorebook_run_history_actions(
        display_model_name(lorebook_model_for(story)), applied, duration_ms, result.get("cost"), skipped
    )
    history_run_id = str(uuid.uuid4())
    history_entries: list[dict[str, Any]] = []

    with get_db() as conn:
        for action in actions:
            history_entries.append(
                insert_chapter_history_entry(
                    conn,
                    story_id=story_id,
                    chapter_id=chapter_id,
                    run_id=history_run_id,
                    label=action["label"],
                    detail=action.get("detail") or "",
                    now=utc_now(),
                    kind=action["kind"],
                    words_added=action["words_added"],
                    words_removed=action["words_removed"],
                    cost=action["cost"],
                )
            )

        rows = conn.execute(
            """
            SELECT * FROM lorebook_entries
            WHERE story_id = ?
            ORDER BY updated_at DESC, created_at DESC
            """,
            (story_id,),
        ).fetchall()

    return {
        "applied": applied,
        "error": result.get("error"),
        "skipped": skipped,
        "skipped_run": bool(result.get("skipped_run")),
        "entries": [row_to_lorebook_entry(row) for row in rows],
        "history": history_entries,
    }
