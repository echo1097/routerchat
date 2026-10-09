import json
import logging
import sqlite3
import uuid
from contextlib import aclosing
from typing import Any, AsyncIterator

from backend.core.database import getDb
from backend.core.utils import displayModelName, utcNow
from backend.lorebook.chapterDelta import chapterDelta, lorebookProseForPrompt
from backend.lorebook.chapterSummaries import (
    lorebookSummaryChapterId,
    normalizeRequiredSummaryUpdate,
)
from backend.lorebook.lorebookHistory import lorebookRunHistoryActions
from backend.lorebook.lorebookQueries import (
    getChapterSnapshot,
    insertUpdateRun,
    listEntries,
    listEntriesByUpdated,
    saveChapterSnapshot,
)
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
from backend.providers.base import ChatOptions, Provider
from backend.stories.storyProvider import storyProvider
from backend.stories.storyRows import insertChapterHistoryEntry, rowToStory
from backend.stories.storyQueries import getChapter, getStory

logger = logging.getLogger("uvicorn.error")

RETRY_NOTE = (
    "Your previous update was applied except for the items listed under skipped. Return decisions "
    "only for those items, using the fresh entryId and entryRevision values in existing_lorebook. "
    "Do not repeat edits that were already applied."
)


def lorebookPromptEntries(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [
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
            "hidden": bool(row["disabled"]),
        }
        for row in rows
    ]


async def runLorebookPass(
    provider: Provider,
    story: sqlite3.Row,
    chapter: sqlite3.Row,
    lorebook: list[sqlite3.Row],
    prompt: dict[str, Any],
    model: str,
    max_tokens: int,
    api_key: str,
    chapter_id: str,
    require_decisions: bool,
) -> AsyncIterator[dict[str, Any]]:
    story_id = str(story["id"])
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
            updates = parsed.get("updates") if isinstance(parsed, dict) else None
            if not isinstance(updates, list):
                raise ValueError("Lorebook output had no updates list.")
            updates, skipped = normalizeRequiredSummaryUpdate(
                updates, chapter, lorebook, require_decisions
            )
            with getDb() as conn:
                applyResult = applyLorebookUpdates(
                    conn, story_id, updates, utcNow()
                )
                applied = applyResult["applied"]
                skipped = [*skipped, *applyResult["skipped"]]
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)

    yield {
        "type": "pass",
        "requestId": usageRun.requestId,
        "generationId": usageRun.generationId,
        "rawOutput": raw_output or "",
        "applied": applied,
        "skipped": skipped,
        "cost": usageRun.usage.get("cost"),
        "error": error_text,
    }


def recordLorebookPass(
    conn: sqlite3.Connection,
    story_id: str,
    chapter_id: str,
    generation_row_id: str | None,
    lorebookPass: dict[str, Any],
) -> None:
    insertUpdateRun(
        conn,
        (
            lorebookPass["requestId"],
            story_id,
            chapter_id,
            generation_row_id,
            lorebookPass["generationId"],
            lorebookPass["rawOutput"],
            json.dumps(lorebookPass["applied"]),
            json.dumps(lorebookPass["skipped"]),
            lorebookPass["cost"],
            lorebookPass["error"],
            utcNow(),
        ),
    )


def sumCosts(*costs: Any) -> float | None:
    known = [float(cost) for cost in costs if cost is not None]
    return sum(known) if known else None


async def runLorebookUpdate(
    story_id: str,
    chapter_id: str,
    source_text: str,
    model: str,
    max_tokens: int,
    generation_row_id: str | None = None,
    force: bool = False,
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
        snapshot = getChapterSnapshot(conn, chapter_id)

    snapshotText = str(snapshot["content"]) if snapshot else None
    if snapshotText is not None and not force and not chapterDelta(snapshotText, source_text)["changed"]:
        yield {
            "type": "result",
            "value": {"applied": [], "skipped": [], "skipped_run": True, "unchanged": True},
        }
        return

    basePrompt = {
        "story": rowToStory(story),
        "chapter": {"id": chapter["id"], "title": chapter["title"]},
        **lorebookProseForPrompt(snapshotText, source_text),
    }

    firstPass: dict[str, Any] = {}
    async with aclosing(runLorebookPass(
        provider, story, chapter, lorebook,
        {**basePrompt, "existing_lorebook": lorebookPromptEntries(lorebook)},
        model, max_tokens, api_key, chapter_id, True,
    )) as events:
        async for event in events:
            if event["type"] == "pass":
                firstPass = event
            else:
                yield event

    with getDb() as conn:
        recordLorebookPass(conn, story_id, chapter_id, generation_row_id, firstPass)

    applied = list(firstPass["applied"])
    skipped = list(firstPass["skipped"])
    error_text = firstPass["error"]
    cost = firstPass["cost"]
    retry_error: str | None = None

    try:
        retryEnabled = bool(story["lorebook_retry"])
    except (KeyError, IndexError):
        retryEnabled = True
    if not error_text and skipped and retryEnabled:
        yield {"type": "retry", "value": {"skipped": len(skipped)}}
        with getDb() as conn:
            freshLorebook = listEntriesByUpdated(conn, story_id)
        retryPrompt = {
            **basePrompt,
            "existing_lorebook": lorebookPromptEntries(freshLorebook),
            "retry": {
                "note": RETRY_NOTE,
                "applied": [
                    {"action": item.get("action"), "name": item.get("name")} for item in applied
                ],
                "skipped": skipped,
            },
        }
        secondPass: dict[str, Any] = {}
        async with aclosing(runLorebookPass(
            provider, story, chapter, freshLorebook, retryPrompt,
            model, max_tokens, api_key, chapter_id, False,
        )) as events:
            async for event in events:
                if event["type"] == "pass":
                    secondPass = event
                else:
                    yield event
        with getDb() as conn:
            recordLorebookPass(conn, story_id, chapter_id, generation_row_id, secondPass)
        cost = sumCosts(cost, secondPass["cost"])
        if secondPass["error"]:
            retry_error = secondPass["error"]
        else:
            applied.extend(secondPass["applied"])
            skipped = list(secondPass["skipped"])

    if not error_text:
        with getDb() as conn:
            saveChapterSnapshot(
                conn, story_id, chapter_id, source_text, int(chapter["revision"]), utcNow()
            )

    if error_text or retry_error:
        logger.error(
            "Lorebook update failed (%s, story %s, chapter %s): %s",
            model,
            story_id,
            chapter_id,
            error_text or retry_error,
        )

    yield {
        "type": "result",
        "value": {
            "applied": applied,
            "skipped": skipped,
            "skipped_run": False,
            "error": error_text,
            "retry_error": retry_error,
            "cost": cost,
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
    actions = []
    if not result.get("skipped_run"):
        actions = lorebookRunHistoryActions(
            displayModelName(lorebookModelFor(story)),
            applied,
            duration_ms,
            result.get("cost"),
            skipped,
            result.get("retry_error"),
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
        "retry_error": result.get("retry_error"),
        "skipped": skipped,
        "skipped_run": bool(result.get("skipped_run")),
        "unchanged": bool(result.get("unchanged")),
        "entries": [rowToLorebookEntry(row) for row in rows],
        "history": history_entries,
    }
