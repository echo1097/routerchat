import asyncio
import sqlite3
import time
import uuid
from contextlib import aclosing
from typing import Any, AsyncIterator

from fastapi.responses import StreamingResponse

from backend.attachments.attachmentContent import (
    attachmentContentParts,
    hasPdfAttachment,
    pdfParserPlugins,
)
from backend.chats.chatModels import StreamMessageRequest
from backend.chats.systemPrompts import writeSystemPrompt
from backend.core.database import getDb
from backend.core.streamEvents import streamEvent
from backend.core.utils import displayModelName, formatDuration, utcNow
from backend.lorebook.lorebookHistory import lorebookRunHistoryActions
from backend.lorebook.runUpdate import runLorebookUpdate
from backend.providers.base import ChatOptions
from backend.providers.modelStream import ModelStream
from backend.providers.registry import providerForRow
from backend.usage.recordUsage import recordUsage
from backend.writing.chapterEdits.anchors import chapterBlocks
from backend.writing.chapterEdits.applyEdits import (
    appendChapterText,
    applyChapterEdits,
    formatEditCount,
)
from backend.writing.chapterEdits.editErrors import (
    CHAPTER_EDIT_INVALID_JSON,
    CHAPTER_EDIT_TRUNCATED,
    CHAPTER_REVISION_CONFLICT,
    ChapterEditError,
    repairableErrorEvent,
)
from backend.writing.chapterEdits.editSchema import chapterEditResponseFormat
from backend.writing.chapterEdits.parseEdits import parseChapterEditBatch
from backend.writing.storyMessages import (
    buildStoryMessages,
    effectiveGenerationMode,
    markStoryCachePoints,
)
from backend.stories.storyQueries import getChapter, getStoryLorebookAuto, settleGeneration
from backend.stories.storyRows import (
    insertChapterHistoryEntry,
    rowToChapter,
    wordCount,
    wordDiffCounts,
)


class ChapterStreamingResponse(StreamingResponse):
    def __init__(self, content, *, onClose, **kwargs):
        super().__init__(content, **kwargs)
        self.onClose = onClose

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            closeStream = getattr(self.body_iterator, "aclose", None)
            if closeStream:
                await closeStream()
            self.onClose()


async def streamStoryGeneration(
    story_id: str,
    chapter_id: str,
    payload: StreamMessageRequest,
    story: sqlite3.Row,
    chapter: sqlite3.Row,
    lorebook_rows: list[sqlite3.Row],
    base_revision: int,
    generationId: str,
    previous_chapters: list[sqlite3.Row] | None = None,
) -> AsyncIterator[bytes]:
    event_metadata = {
        "runId": getattr(payload, "generation_run_id", None),
        "storyId": story_id,
        "chapterId": chapter_id,
        "generationId": generationId,
    }

    def emit(event_type: str, value: Any, revision: int | None = None) -> bytes:
        metadata = {**event_metadata, "revision": revision}
        return streamEvent(event_type, value, metadata)

    provider = providerForRow(story)
    api_key = provider.requireKey()

    generation_mode = effectiveGenerationMode(
        getattr(payload, "write_generation_mode", None),
        chapter["content"] or "",
    )
    starting_blocks = chapterBlocks(chapter["content"] or "") if generation_mode == "edit" else []

    repair_context = getattr(payload, "repair_context", None)
    if repair_context is not None and not isinstance(repair_context, dict):
        repair_context = repair_context.model_dump()
    is_repair = bool(repair_context)

    attachmentIds = list(getattr(payload, "attachment_ids", []) or [])
    with getDb() as conn:
        attachmentParts = attachmentContentParts(conn, attachmentIds)
        needsPdfParser = hasPdfAttachment(conn, attachmentIds)

    messages = buildStoryMessages(
        story,
        chapter,
        lorebook_rows,
        payload.message,
        writeSystemPrompt(payload),
        generation_mode,
        starting_blocks,
        repair_context,
        attachmentParts,
        previous_chapters,
    )
    cacheControl = provider.promptCacheControl()
    if cacheControl:
        messages = markStoryCachePoints(messages, cacheControl)

    responseFormat = None
    if generation_mode == "edit" and provider.supportsStructuredOutput(payload.model):
        responseFormat = chapterEditResponseFormat()

    request = provider.buildRequest(
        messages,
        payload.model,
        ChatOptions(
            apiKey=api_key,
            temperature=payload.temperature,
            maxTokens=payload.max_tokens,
            nitro=payload.nitro_mode,
            thinkingEnabled=payload.thinking_enabled,
            reasoningEffort=payload.reasoning_effort,
            responseFormat=responseFormat,
            plugins=pdfParserPlugins() if needsPdfParser and provider.capabilities.pdfParsing else [],
            sessionId=story_id if cacheControl else None,
        ),
    )
    effectiveThinkingEnabled = provider.effectiveThinkingEnabled(
        payload.model, payload.thinking_enabled
    )

    modelStream = ModelStream(provider, request, effectiveThinkingEnabled)
    error_text: str | None = None
    story_generation_id = event_metadata["generationId"]
    history_run_id = str(uuid.uuid4())
    model_label = displayModelName(payload.model)
    reasoning_started_at: float | None = None
    #a run can think more than once, this marks how much of the reasoning already has a history row
    reasoning_saved_chunks = 0
    content_started_at: float | None = None
    stream_completed = False
    cancelled = False
    pendingEvents: list[bytes] = []

    def saveHistory(
        label: str,
        detail: str = "",
        kind: str | None = None,
        words_added: int | None = None,
        words_removed: int | None = None,
        cost: float | None = None,
    ) -> dict[str, Any]:
        with getDb() as conn:
            return insertChapterHistoryEntry(
                conn,
                story_id=story_id,
                chapter_id=chapter_id,
                run_id=history_run_id,
                label=label,
                detail=detail,
                now=utcNow(),
                kind=kind,
                words_added=words_added,
                words_removed=words_removed,
                cost=cost,
            )

    def revisionConflictEvent(conn: sqlite3.Connection) -> dict[str, Any]:
        currentChapter = getChapter(conn, story_id, chapter_id)
        return {
            "code": CHAPTER_REVISION_CONFLICT,
            "message": "Chapter changed while generation was running.",
            "chapter": rowToChapter(currentChapter) if currentChapter else None,
        }

    try:
        yield emit(
            "history",
            saveHistory("User prompt", " ".join(payload.message.split()), kind="prompt"),
        )
        async with aclosing(modelStream.events()) as events:
            async for event in events:
                if event["type"] == "reasoning":
                    if reasoning_started_at is None:
                        reasoning_started_at = time.perf_counter()
                    yield emit("reasoning", event["value"])
                elif event["type"] == "content":
                    if reasoning_started_at is not None:
                        duration_ms = (time.perf_counter() - reasoning_started_at) * 1000
                        reasoningParts = modelStream.reasoningParts
                        thoughts = "".join(reasoningParts[reasoning_saved_chunks:]).strip()
                        reasoning_saved_chunks = len(reasoningParts)
                        yield emit(
                            "history",
                            saveHistory(
                                f"{model_label} thought for {formatDuration(duration_ms)}",
                                detail=thoughts,
                                kind="thinking",
                            ),
                        )
                        reasoning_started_at = None
                    if content_started_at is None:
                        content_started_at = time.perf_counter()
                    yield emit("content", event["value"])

        if modelStream.errorMessage:
            error_text = modelStream.errorMessage
            yield emit("error", error_text)
            return

        await modelStream.fetchFinalUsage(api_key)
        if modelStream.usage:
            yield emit(
                "usage",
                {
                    "generation_id": modelStream.generationId,
                    "model": payload.model,
                    **modelStream.usage,
                },
            )
        stream_completed = modelStream.receivedDone or bool(modelStream.finishReason)
    except (asyncio.CancelledError, GeneratorExit):
        cancelled = True
        stream_completed = modelStream.receivedDone or bool(modelStream.finishReason)
        if not stream_completed:
            error_text = "generation_cancelled"
        raise
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)
        yield emit("error", f"RouterChat error: {error_text}")
    finally:
        content = modelStream.text
        finish_reason = modelStream.finishReason
        generation_id = modelStream.generationId
        usage = modelStream.usage or None
        now = utcNow()
        chapter_update_event: dict[str, Any] | None = None
        error_event: dict[str, Any] | None = None
        edit_batch: dict[str, Any] | None = None

        if not stream_completed and not error_text:
            error_text = "generation_incomplete_stream"
            error_event = {
                "code": "generation_incomplete_stream",
                "message": "Generation ended before the provider completed the stream.",
            }
        incomplete_stream = error_text == "generation_incomplete_stream"
        append_truncated = (incomplete_stream or (cancelled and not stream_completed)) and generation_mode != "edit" and bool(content)
        #edit mode used to walk away from a run that stopped early, which threw away every finished paragraph the model had already written
        edit_stopped_early = (incomplete_stream or (cancelled and not stream_completed)) and generation_mode == "edit" and bool(content)
        if cancelled and not stream_completed:
            error_event = {
                "code": "generation_cancelled",
                "message": "Generation was cancelled.",
            }

        edit_truncated = False

        if (stream_completed or edit_stopped_early) and generation_mode == "edit" and content:
            try:
                edit_batch = parseChapterEditBatch(content)
                edit_truncated = (
                    bool(edit_batch.get("truncated"))
                    or finish_reason == "length"
                    or edit_stopped_early
                )
            except ChapterEditError as exc:
                message = exc.message
                code = exc.code
                if finish_reason == "length" and code == CHAPTER_EDIT_INVALID_JSON:
                    #the json was fine, it just never got to finish, and saying so beats blaming the model for bad output
                    code = CHAPTER_EDIT_TRUNCATED
                    message = "the response hit the token limit before a single complete edit came through"
                error_event = repairableErrorEvent(code, message, is_repair)
                error_text = f"{code}: {message}"
                edit_batch = None

        with getDb() as conn:
            if (stream_completed or append_truncated or edit_stopped_early) and content:
                conn.execute("BEGIN IMMEDIATE")
            current = getChapter(conn, story_id, chapter_id)
            current_content = current["content"] if current else ""

            if (stream_completed or edit_stopped_early) and content and generation_mode == "edit" and edit_batch is not None:
                try:
                    if not current or current["revision"] != base_revision:
                        error_event = revisionConflictEvent(conn)
                        error_text = CHAPTER_REVISION_CONFLICT
                    else:
                        operation_result = applyChapterEdits(
                            current_content,
                            edit_batch,
                            baseRevision=base_revision,
                            partial=True,
                        )
                        nextContent = operation_result["content"]
                        result = conn.execute(
                            """
                            UPDATE chapters
                            SET content = ?, word_count = ?, revision = revision + 1, updated_at = ?
                            WHERE id = ? AND story_id = ? AND revision = ?
                            """,
                            (
                                nextContent,
                                wordCount(nextContent),
                                now,
                                chapter_id,
                                story_id,
                                base_revision,
                            ),
                        )
                        if result.rowcount != 1:
                            error_event = revisionConflictEvent(conn)
                            error_text = CHAPTER_REVISION_CONFLICT
                        else:
                            savedChapter = getChapter(conn, story_id, chapter_id)
                            rejected_edits = operation_result.get("rejected") or []
                            applied_count = len(operation_result["edits"])
                            #a run cut off at the token limit lost whatever it had not written yet, and that work is invisible here: it never became an edit we could reject, so truncation has to count as incomplete on its own
                            incomplete = bool(rejected_edits) or edit_truncated
                            chapter_update_event = {
                                "chapter": rowToChapter(savedChapter),
                                "edits": operation_result["edits"],
                                "rejected": rejected_edits,
                                "truncated": edit_truncated,
                                #the applied edits are committed by now, so a repair is a fresh run on top of them and can never take them back
                                "repairable": incomplete and not is_repair,
                            }
                            #the prose landed, so a stream that merely ended early is no longer a failure worth showing
                            if incomplete_stream:
                                error_event = None
                            if rejected_edits:
                                error_text = (
                                    f"partial: applied {applied_count} of "
                                    f"{applied_count + len(rejected_edits)} edits"
                                )
                            elif edit_truncated:
                                error_text = (
                                    f"partial: applied {formatEditCount(applied_count)} "
                                    "before the token limit"
                                )
                except ChapterEditError as exc:
                    error_event = repairableErrorEvent(exc.code, exc.message, is_repair)
                    error_text = f"{exc.code}: {exc.message}"
            elif content and generation_mode != "edit" and (stream_completed or append_truncated):
                operation_result = appendChapterText(current_content, content)
                nextContent = operation_result["content"]
                result = conn.execute(
                    """
                    UPDATE chapters
                    SET content = ?, word_count = ?, revision = revision + 1, updated_at = ?
                    WHERE id = ? AND story_id = ? AND revision = ?
                    """,
                    (
                        nextContent,
                        wordCount(nextContent),
                        now,
                        chapter_id,
                        story_id,
                        base_revision,
                    ),
                )
                if result.rowcount == 1:
                    savedChapter = getChapter(conn, story_id, chapter_id)
                    chapter_update_event = {
                        "chapter": rowToChapter(savedChapter),
                        "edits": [
                            {
                                "operation": operation_result["operation"],
                                "deletedBlockIds": operation_result["deletedBlockIds"],
                                "insertedBlockIds": operation_result["insertedBlockIds"],
                                "appliedText": operation_result["appliedText"],
                            }
                        ],
                        "truncated": append_truncated,
                        #repair_context continuation only exists for edit mode, offering a retry here would go nowhere
                        "repairable": False,
                    }
                    #it saved, so the earlier incomplete-stream flag is no longer a user-facing failure
                    error_event = None
                else:
                    error_event = revisionConflictEvent(conn)
                    error_text = CHAPTER_REVISION_CONFLICT

            conn.execute(
                """
                UPDATE story_generations
                SET generated_text = ?, model = ?, finish_reason = ?, error = ?,
                    generation_id = ?, prompt_tokens = ?, completion_tokens = ?,
                    reasoning_tokens = ?, cached_tokens = ?, total_tokens = ?, cost = ?,
                    provider_name = ?, generation_time = ?, latency = ?, created_at = ?
                WHERE id = ?
                """,
                (
                    content,
                    payload.model,
                    finish_reason,
                    error_text,
                    generation_id,
                    usage.get("prompt_tokens") if usage else None,
                    usage.get("completion_tokens") if usage else None,
                    usage.get("reasoning_tokens") if usage else None,
                    usage.get("cached_tokens") if usage else None,
                    usage.get("total_tokens") if usage else None,
                    usage.get("cost") if usage else None,
                    usage.get("provider_name") if usage else None,
                    usage.get("generation_time") if usage else None,
                    usage.get("latency") if usage else None,
                    now,
                    story_generation_id,
                ),
            )
            recordUsage(
                "story", story_generation_id, payload.model, usage, now, generation_id, provider.id
            )
            conn.execute(
                "UPDATE stories SET updated_at = ? WHERE id = ?",
                (now, story_id),
            )
        if error_event is not None:
            pendingEvents.append(emit("error", error_event))
            #new mode never touches an edit at all, so the label needs to say what actually failed
            fail_label = (
                f"{model_label} could not apply the edit"
                if generation_mode == "edit"
                else f"{model_label} could not finish writing"
            )
            #a run that failed still burned tokens, so it gets a line and carries the cost the wrote for line never got to report
            pendingEvents.append(emit(
                "history",
                saveHistory(
                    fail_label,
                    detail=str(error_event.get("message") or ""),
                    kind="write_failed",
                    cost=usage.get("cost") if usage else None,
                ),
            ))
        if chapter_update_event is not None:
            pendingEvents.append(emit(
                "chapter_updated",
                chapter_update_event,
                chapter_update_event["chapter"]["revision"],
            ))
            if content_started_at is not None:
                duration_ms = (time.perf_counter() - content_started_at) * 1000
                written_added, written_removed = wordDiffCounts(
                    current_content, chapter_update_event["chapter"]["content"]
                )
                #whole run rides here including any thinking tokens, the thought for line stays cost free on purpose
                skipped = chapter_update_event.get("rejected") or []
                applied_count = len(chapter_update_event.get("edits") or [])
                if skipped:
                    label = f"{model_label} applied {applied_count} of {applied_count + len(skipped)} edits"
                    detail = "\n".join(
                        f"skipped edit {item['index'] + 1}: {item['message']}" for item in skipped
                    )
                elif chapter_update_event.get("truncated") and generation_mode == "edit":
                    #the token limit and a run that stopped early both cut the response off, but only one of them is the model's doing
                    stopped_at = "the run stopped" if edit_stopped_early else "the token limit"
                    label = (
                        f"{model_label} applied {formatEditCount(applied_count)} "
                        f"before {stopped_at}"
                    )
                    detail = "the response was cut off, so any edits it had not written yet are missing"
                elif chapter_update_event.get("truncated"):
                    stoppedAt = "the run stopped" if cancelled else "the connection dropped"
                    label = f"{model_label} wrote for {formatDuration(duration_ms)} before {stoppedAt}"
                    detail = "the response was cut off, so anything written after that point is missing"
                else:
                    label = f"{model_label} wrote for {formatDuration(duration_ms)}"
                    detail = ""

                pendingEvents.append(emit(
                    "history",
                    saveHistory(
                        label,
                        detail=detail,
                        kind="write",
                        words_added=written_added,
                        words_removed=written_removed,
                        cost=usage.get("cost") if usage else None,
                    ),
                ))
                content_started_at = None

        with getDb() as conn:
            settleGeneration(conn, story_generation_id)

    for event in pendingEvents:
        yield event

    if chapter_update_event is not None:
        with getDb() as conn:
            auto_row = getStoryLorebookAuto(conn, story_id)

        #manual runs get their own button, this is only for the folks who opted into auto
        if auto_row and bool(auto_row["lorebook_auto"]):
            lorebook_started_at = time.perf_counter()
            yield emit("lorebook_start", {"generation_id": story_generation_id})

            lorebook_result: dict[str, Any] = {}
            #the reasoning rides the same stream so the write mode dropdown can show it live
            async for lorebook_event in runLorebookUpdate(
                story_id,
                chapter_id,
                chapter_update_event["chapter"]["content"],
                payload.model,
                payload.max_tokens,
                generation_row_id=story_generation_id,
            ):
                if lorebook_event["type"] == "reasoning":
                    yield emit("lorebook_reasoning", lorebook_event["value"])
                    continue
                if lorebook_event["type"] == "content":
                    yield emit("lorebook_content", None)
                    continue
                if lorebook_event["type"] == "retry":
                    yield emit("lorebook_retry", lorebook_event["value"])
                    continue
                lorebook_result = lorebook_event["value"]

            lorebook_duration_ms = (time.perf_counter() - lorebook_started_at) * 1000
            #a skipped run never reached the model, so there is no activity to record
            if not lorebook_result.get("skipped_run"):
                for action in lorebookRunHistoryActions(
                    model_label,
                    lorebook_result.get("applied") or [],
                    lorebook_duration_ms,
                    lorebook_result.get("cost"),
                    lorebook_result.get("skipped") or [],
                    lorebook_result.get("retry_error"),
                ):
                    yield emit(
                        "history",
                        saveHistory(
                            action["label"],
                            detail=action.get("detail") or "",
                            kind=action["kind"],
                            words_added=action["words_added"],
                            words_removed=action["words_removed"],
                            cost=action["cost"],
                        ),
                    )

            yield emit("lorebook", lorebook_result)
