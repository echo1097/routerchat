import json
import logging
import sqlite3
import uuid
from contextlib import aclosing
from typing import Any, AsyncIterator

from backend.core.database import getDb
from backend.core.utils import displayModelName, utcNow
from backend.lorebook.chapterSummaries import (
    lorebookSummaryChapterId,
    normalizeRequiredSummaryUpdate,
)
from backend.lorebook.lorebookHistory import lorebookRunHistoryActions
from backend.lorebook.lorebookQueries import insertUpdateRun, listEntries, listEntriesByUpdated
from backend.lorebook.lorebookRows import (
    jsonList,
    lorebookModelFor,
    normalizeLorebookCategory,
    rowToLorebookEntry,
    sanitizeLorebookAliases,
)
from backend.lorebook.lorebookStream import LorebookStream
from backend.lorebook.lorebookUsage import LorebookUsage
from backend.lorebook.parseLorebook import parseLorebookJson
from backend.lorebook.targetedUpdates import applyLorebookUpdates
from backend.lorebook.updateSchema import (
    LOREBOOK_UPDATE_SYSTEM_PROMPT,
    lorebookUpdateResponseFormat,
)
from backend.providers.base import ChatOptions
from backend.stories.storyProvider import storyProvider
from backend.stories.storyRows import insertChapterHistoryEntry, rowToStory
from backend.stories.storyQueries import getChapter, getStory

logger = logging.getLogger("uvicorn.error")


#used to be one blocking post, now it streams so write mode can show the thinking while it works.
#yields {"type": "reasoning"} chunks as they land, one {"type": "content"} the moment json generation
#starts, and exactly one {"type": "result"} at the end
async def runLorebookUpdate(
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

    with getDb() as conn:
        story = getStory(conn, story_id)
        chapter = getChapter(conn, story_id, chapter_id)
        lorebook = listEntriesByUpdated(conn, story_id)

    current_lore = [
        {
            "entryId": row["id"],
            "entryRevision": row["revision"],
            "name": row["name"],
            "category": normalizeLorebookCategory(row["category"]),
            "description": row["description"] or "",
            "aliases": sanitizeLorebookAliases(
                normalizeLorebookCategory(row["category"]),
                jsonList(row["aliases_json"]),
                row["name"],
            ),
            "tags": jsonList(row["tags_json"]),
            "chapterId": lorebookSummaryChapterId(row) or None,
        }
        for row in lorebook
        if not bool(row["disabled"])
    ]
    prompt = {
        "story": rowToStory(story),
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
        responseFormat = lorebookUpdateResponseFormat()

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
            parsed = parseLorebookJson(raw_output)
            updates = parsed.get("updates") if isinstance(parsed, dict) else []
            if not isinstance(updates, list):
                updates = []
            updates = normalizeRequiredSummaryUpdate(updates, chapter, lorebook)
            with getDb() as conn:
                applyResult = applyLorebookUpdates(
                    conn, story_id, updates, utcNow()
                )
                applied = applyResult["applied"]
                skipped = applyResult["skipped"]
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)

    with getDb() as conn:
        insertUpdateRun(
            conn,
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
                utcNow(),
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
def finalizeLorebookUpdate(
    story_id: str,
    chapter_id: str,
    story: sqlite3.Row,
    result: dict[str, Any],
    duration_ms: float,
) -> dict[str, Any]:
    applied = result.get("applied") or []
    skipped = result.get("skipped") or []
    actions = lorebookRunHistoryActions(
        displayModelName(lorebookModelFor(story)), applied, duration_ms, result.get("cost"), skipped
    )
    history_run_id = str(uuid.uuid4())
    history_entries: list[dict[str, Any]] = []

    with getDb() as conn:
        for action in actions:
            history_entries.append(
                insertChapterHistoryEntry(
                    conn,
                    story_id=story_id,
                    chapter_id=chapter_id,
                    run_id=history_run_id,
                    label=action["label"],
                    detail=action.get("detail") or "",
                    now=utcNow(),
                    kind=action["kind"],
                    words_added=action["words_added"],
                    words_removed=action["words_removed"],
                    cost=action["cost"],
                )
            )

        rows = listEntries(conn, story_id)

    return {
        "applied": applied,
        "error": result.get("error"),
        "skipped": skipped,
        "skipped_run": bool(result.get("skipped_run")),
        "entries": [rowToLorebookEntry(row) for row in rows],
        "history": history_entries,
    }
