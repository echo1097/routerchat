import asyncio
import json
import sqlite3
import time
import uuid
from typing import Any, AsyncIterator

import httpx
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from backend.attachments.attachmentContent import (
    attachment_content_parts,
    has_pdf_attachment,
    pdf_parser_plugins,
)
from backend.chats.chatModels import StreamMessageRequest
from backend.chats.systemPrompts import writeSystemPrompt
from backend.core.database import get_db
from backend.core.streamEvents import stream_event
from backend.core.utils import display_model_name, format_duration, utc_now
from backend.lorebook.lorebookHistory import lorebook_run_history_actions
from backend.lorebook.runUpdate import run_lorebook_update
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
    prompt_cache_control,
)
from backend.providers.openrouter.usage import fetch_generation_usage, normalize_usage
from backend.writing.chapterEdits.anchors import chapter_blocks
from backend.writing.chapterEdits.applyEdits import (
    append_chapter_text,
    apply_chapter_edits,
    format_edit_count,
)
from backend.writing.chapterEdits.editErrors import (
    CHAPTER_EDIT_INVALID_JSON,
    CHAPTER_EDIT_TRUNCATED,
    CHAPTER_REVISION_CONFLICT,
    ChapterEditError,
    repairable_error_event,
)
from backend.writing.chapterEdits.editSchema import chapter_edit_response_format
from backend.writing.chapterEdits.parseEdits import parse_chapter_edit_batch
from backend.writing.storyMessages import (
    build_story_messages,
    effective_generation_mode,
    mark_story_cache_points,
)
from backend.writing.storyRows import (
    insert_chapter_history_entry,
    row_to_chapter,
    word_count,
    word_diff_counts,
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


async def stream_story_generation(
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
        return stream_event(event_type, value, metadata)

    api_key = read_openrouter_key()
    if not api_key:
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

    generation_mode = effective_generation_mode(
        getattr(payload, "write_generation_mode", None),
        chapter["content"] or "",
    )
    starting_blocks = chapter_blocks(chapter["content"] or "") if generation_mode == "edit" else []

    repair_context = getattr(payload, "repair_context", None)
    if repair_context is not None and not isinstance(repair_context, dict):
        repair_context = repair_context.model_dump()
    is_repair = bool(repair_context)

    attachmentIds = list(getattr(payload, "attachment_ids", []) or [])
    with get_db() as conn:
        attachmentParts = attachment_content_parts(conn, attachmentIds)
        needsPdfParser = has_pdf_attachment(conn, attachmentIds)

    messages = build_story_messages(
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
    cacheControl = prompt_cache_control()
    if cacheControl:
        messages = mark_story_cache_points(messages, cacheControl)

    body: dict[str, Any] = {
        "model": openrouter_request_model(payload.model, payload.nitro_mode),
        "messages": messages,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "stream": True,
    }
    if cacheControl:
        body["session_id"] = story_id
    providerOptions = openrouter_provider_options()
    if providerOptions:
        body["provider"] = providerOptions
    if needsPdfParser:
        body["plugins"] = pdf_parser_plugins()

    effectiveThinkingEnabled = effective_thinking_enabled(
        payload.model, payload.thinking_enabled
    )
    reasoningConfig = enabled_reasoning_config(
        payload.model, payload.thinking_enabled, payload.reasoning_effort
    )
    if reasoningConfig:
        body["reasoning"] = reasoningConfig
    if generation_mode == "edit" and model_supports_structured_output(payload.model):
        body["response_format"] = chapter_edit_response_format()

    generated_text: list[str] = []
    reasoning_text: list[str] = []
    finish_reason: str | None = None
    error_text: str | None = None
    generation_id: str | None = None
    usage: dict[str, Any] | None = None
    story_generation_id = event_metadata["generationId"]
    history_run_id = str(uuid.uuid4())
    model_label = display_model_name(payload.model)
    reasoning_started_at: float | None = None
    #a run can think more than once, this marks how much of the reasoning already has a history row
    reasoning_saved_chunks = 0
    content_started_at: float | None = None
    stream_completed = False
    received_done = False
    cancelled = False
    pendingEvents: list[bytes] = []

    def save_history(
        label: str,
        detail: str = "",
        kind: str | None = None,
        words_added: int | None = None,
        words_removed: int | None = None,
        cost: float | None = None,
    ) -> dict[str, Any]:
        with get_db() as conn:
            return insert_chapter_history_entry(
                conn,
                story_id=story_id,
                chapter_id=chapter_id,
                run_id=history_run_id,
                label=label,
                detail=detail,
                now=utc_now(),
                kind=kind,
                words_added=words_added,
                words_removed=words_removed,
                cost=cost,
            )

    def revision_conflict_event(conn: sqlite3.Connection) -> dict[str, Any]:
        currentChapter = conn.execute(
            "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
            (chapter_id, story_id),
        ).fetchone()
        return {
            "code": CHAPTER_REVISION_CONFLICT,
            "message": "Chapter changed while generation was running.",
            "chapter": row_to_chapter(currentChapter) if currentChapter else None,
        }

    try:
        yield emit(
            "history",
            save_history("User prompt", " ".join(payload.message.split()), kind="prompt"),
        )
        async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client:
            async with client.stream(
                "POST",
                f"{OPENROUTER_BASE_URL}/chat/completions",
                headers={**headers_for_key(api_key), "Content-Type": "application/json"},
                json=body,
            ) as response:
                if response.status_code >= 400:
                    raw_error = (await response.aread()).decode("utf-8", errors="replace")
                    error_text = openrouter_error_message(response.status_code, raw_error)
                    yield emit("error", error_text)
                    return
                generation_id = response.headers.get("X-Generation-Id") or generation_id

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line.removeprefix("data:").strip()
                    if data == "[DONE]":
                        received_done = True
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    generation_id = generation_id or chunk.get("id")
                    next_usage = normalize_usage(chunk.get("usage"))
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
                    if reasoning and effectiveThinkingEnabled:
                        if reasoning_started_at is None:
                            reasoning_started_at = time.perf_counter()
                        value = str(reasoning)
                        reasoning_text.append(value)
                        yield emit("reasoning", value)
                    content = delta.get("content")
                    if content:
                        if reasoning_started_at is not None:
                            duration_ms = (time.perf_counter() - reasoning_started_at) * 1000
                            thoughts = "".join(reasoning_text[reasoning_saved_chunks:]).strip()
                            reasoning_saved_chunks = len(reasoning_text)
                            yield emit(
                                "history",
                                save_history(
                                    f"{model_label} thought for {format_duration(duration_ms)}",
                                    detail=thoughts,
                                    kind="thinking",
                                ),
                            )
                            reasoning_started_at = None
                        if content_started_at is None:
                            content_started_at = time.perf_counter()
                        value = str(content)
                        generated_text.append(value)
                        yield emit("content", value)

                if generation_id:
                    generation_usage = await fetch_generation_usage(api_key, generation_id)
                    if generation_usage:
                        usage = {**(usage or {}), **generation_usage}
                if usage:
                    yield emit(
                        "usage",
                        {"generation_id": generation_id, "model": payload.model, **usage},
                    )
                stream_completed = received_done or bool(finish_reason)
    except (asyncio.CancelledError, GeneratorExit):
        cancelled = True
        stream_completed = received_done or bool(finish_reason)
        if not stream_completed:
            error_text = "generation_cancelled"
        raise
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)
        yield emit("error", f"RouterChat error: {error_text}")
    finally:
        content = "".join(generated_text)
        now = utc_now()
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
                edit_batch = parse_chapter_edit_batch(content)
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
                error_event = repairable_error_event(code, message, is_repair)
                error_text = f"{code}: {message}"
                edit_batch = None

        with get_db() as conn:
            if (stream_completed or append_truncated or edit_stopped_early) and content:
                conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
            current_content = current["content"] if current else ""

            if (stream_completed or edit_stopped_early) and content and generation_mode == "edit" and edit_batch is not None:
                try:
                    if not current or current["revision"] != base_revision:
                        error_event = revision_conflict_event(conn)
                        error_text = CHAPTER_REVISION_CONFLICT
                    else:
                        operation_result = apply_chapter_edits(
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
                                word_count(nextContent),
                                now,
                                chapter_id,
                                story_id,
                                base_revision,
                            ),
                        )
                        if result.rowcount != 1:
                            error_event = revision_conflict_event(conn)
                            error_text = CHAPTER_REVISION_CONFLICT
                        else:
                            savedChapter = conn.execute(
                                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                                (chapter_id, story_id),
                            ).fetchone()
                            rejected_edits = operation_result.get("rejected") or []
                            applied_count = len(operation_result["edits"])
                            #a run cut off at the token limit lost whatever it had not written yet, and that work is invisible here: it never became an edit we could reject, so truncation has to count as incomplete on its own
                            incomplete = bool(rejected_edits) or edit_truncated
                            chapter_update_event = {
                                "chapter": row_to_chapter(savedChapter),
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
                                    f"partial: applied {format_edit_count(applied_count)} "
                                    "before the token limit"
                                )
                except ChapterEditError as exc:
                    error_event = repairable_error_event(exc.code, exc.message, is_repair)
                    error_text = f"{exc.code}: {exc.message}"
            elif content and generation_mode != "edit" and (stream_completed or append_truncated):
                operation_result = append_chapter_text(current_content, content)
                nextContent = operation_result["content"]
                result = conn.execute(
                    """
                    UPDATE chapters
                    SET content = ?, word_count = ?, revision = revision + 1, updated_at = ?
                    WHERE id = ? AND story_id = ? AND revision = ?
                    """,
                    (
                        nextContent,
                        word_count(nextContent),
                        now,
                        chapter_id,
                        story_id,
                        base_revision,
                    ),
                )
                if result.rowcount == 1:
                    savedChapter = conn.execute(
                        "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                        (chapter_id, story_id),
                    ).fetchone()
                    chapter_update_event = {
                        "chapter": row_to_chapter(savedChapter),
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
                    error_event = revision_conflict_event(conn)
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
                save_history(
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
                written_added, written_removed = word_diff_counts(
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
                        f"{model_label} applied {format_edit_count(applied_count)} "
                        f"before {stopped_at}"
                    )
                    detail = "the response was cut off, so any edits it had not written yet are missing"
                elif chapter_update_event.get("truncated"):
                    stoppedAt = "the run stopped" if cancelled else "the connection dropped"
                    label = f"{model_label} wrote for {format_duration(duration_ms)} before {stoppedAt}"
                    detail = "the response was cut off, so anything written after that point is missing"
                else:
                    label = f"{model_label} wrote for {format_duration(duration_ms)}"
                    detail = ""

                pendingEvents.append(emit(
                    "history",
                    save_history(
                        label,
                        detail=detail,
                        kind="write",
                        words_added=written_added,
                        words_removed=written_removed,
                        cost=usage.get("cost") if usage else None,
                    ),
                ))
                content_started_at = None

        with get_db() as conn:
            conn.execute(
                "UPDATE story_generations SET settled = 1 WHERE id = ?",
                (story_generation_id,),
            )

    for event in pendingEvents:
        yield event

    if chapter_update_event is not None:
        with get_db() as conn:
            auto_row = conn.execute(
                "SELECT lorebook_auto FROM stories WHERE id = ?", (story_id,)
            ).fetchone()

        #manual runs get their own button, this is only for the folks who opted into auto
        if auto_row and bool(auto_row["lorebook_auto"]):
            lorebook_started_at = time.perf_counter()
            yield emit("lorebook_start", {"generation_id": story_generation_id})

            lorebook_result: dict[str, Any] = {}
            #the reasoning rides the same stream so the write mode dropdown can show it live
            async for lorebook_event in run_lorebook_update(
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
                lorebook_result = lorebook_event["value"]

            lorebook_duration_ms = (time.perf_counter() - lorebook_started_at) * 1000
            #a skipped run never reached the model, so there is no activity to record
            if not lorebook_result.get("skipped_run"):
                for action in lorebook_run_history_actions(
                    model_label,
                    lorebook_result.get("applied") or [],
                    lorebook_duration_ms,
                    lorebook_result.get("cost"),
                    lorebook_result.get("skipped") or [],
                ):
                    yield emit(
                        "history",
                        save_history(
                            action["label"],
                            detail=action.get("detail") or "",
                            kind=action["kind"],
                            words_added=action["words_added"],
                            words_removed=action["words_removed"],
                            cost=action["cost"],
                        ),
                    )

            yield emit("lorebook", lorebook_result)
