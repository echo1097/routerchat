import json
import logging
import sqlite3
import uuid
from contextlib import aclosing
from typing import Any, AsyncIterator

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
from backend.lorebook.lorebookStream import LorebookStream
from backend.lorebook.lorebookUsage import LorebookUsage
from backend.lorebook.parseLorebook import parse_lorebook_json
from backend.lorebook.targetedUpdates import apply_lorebook_updates
from backend.lorebook.updateSchema import (
    LOREBOOK_UPDATE_SYSTEM_PROMPT,
    lorebook_update_response_format,
)
from backend.providers.base import ChatOptions
from backend.stories.storyProvider import storyProvider
from backend.stories.storyRows import insert_chapter_history_entry, row_to_story
from backend.stories.storyQueries import getChapter, getStory

logger = logging.getLogger("uvicorn.error")


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
    provider = storyProvider(story_id)
    api_key = provider.readKey()
    if not api_key or not source_text.strip():
        yield {
            "type": "result",
            "value": {"applied": [], "skipped": [], "skipped_run": True},
        }
        return

    with get_db() as conn:
        story = getStory(conn, story_id)
        chapter = getChapter(conn, story_id, chapter_id)
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
    responseFormat = None
    if provider.supportsStructuredOutput(model):
        responseFormat = lorebook_update_response_format()

    request = provider.buildRequest(
        messages,
        model,
        ChatOptions(
            apiKey=api_key,
            temperature=0.1,
            maxTokens=max_tokens,
            thinkingEnabled=True,
            reasoningEffort=story["reasoning_effort"],
            responseFormat=responseFormat,
        ),
    )
    thinking_enabled = provider.effectiveThinkingEnabled(model, True)

    raw_output = ""
    error_text: str | None = None
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    usageRun = LorebookUsage(api_key, story_id, model, "update", chapter_id)
    lorebookStream = LorebookStream(provider, request, usageRun, thinking_enabled)
    try:
        async with aclosing(lorebookStream.events()) as events:
            async for event in events:
                if event["type"] == "reasoning":
                    yield {"type": "reasoning", "value": event["value"]}
                elif event["type"] == "contentStart":
                    yield {"type": "content"}
        error_text = lorebookStream.errorMessage

        raw_output = lorebookStream.text
        #a cut off response is never valid json anyway, so say why instead of letting the parser guess
        if lorebookStream.finishReason == "length":
            error_text = "The lorebook update hit the model token limit before it finished."
        elif not lorebookStream.receivedDone and not error_text:
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

    if error_text:
        logger.error(
            "Lorebook update failed (%s, story %s, chapter %s): %s",
            model,
            story_id,
            chapter_id,
            error_text,
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
