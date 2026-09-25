from __future__ import annotations

import json
import uuid
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.attachments.attachmentCleanup import (
    claim_attachments,
    delete_attachments_for_missing_messages,
)
from backend.attachments.attachmentContent import (
    chat_has_pdf_attachment,
    pdf_parser_plugins,
)
from backend.chats.buildMessages import build_openrouter_messages
from backend.chats.chatModels import StreamMessageRequest
from backend.chats.chatRows import chat_has_messages
from backend.chats.chatTitles import chat_title_from_message
from backend.chats.messageRoutes import refresh_chat_after_message_change
from backend.chats.systemPrompts import chatSystemPrompt
from backend.core.appSettings import globalChatSystemPrompt, read_app_setting
from backend.core.database import get_db, next_message_order
from backend.core.streamEvents import stream_event
from backend.core.utils import utc_now
from backend.providers.openrouter.apiKey import read_openrouter_key
from backend.providers.openrouter.client import (
    OPENROUTER_BASE_URL,
    OPENROUTER_TIMEOUT,
    headers_for_key,
)
from backend.providers.openrouter.errors import openrouter_error_message
from backend.providers.openrouter.models import model_supports_reasoning
from backend.providers.openrouter.requestOptions import (
    effective_thinking_enabled,
    enabled_reasoning_config,
    openrouter_provider_options,
    openrouter_request_model,
    prompt_cache_control,
)
from backend.providers.openrouter.usage import fetch_generation_usage, normalize_usage
from backend.webSearch.sources import (
    merge_sources,
    normalize_sources,
    serialize_sources,
    web_search_plugin,
)

router = APIRouter()


def saveAssistantReply(
    chat_id: str,
    payload: StreamMessageRequest,
    assistant_message_id: str,
    assistant_text: list[str],
    reasoning_text: list[str],
    sources: list[dict[str, str]],
    finish_reason: str | None,
    error_text: str | None,
    generation_id: str | None,
    usage: dict[str, Any] | None,
) -> None:
    content = "".join(assistant_text)
    with get_db() as conn:
        if payload.regenerate_message_id:
            regenerate_message = conn.execute(
                """
                SELECT * FROM messages
                WHERE id = ? AND chat_id = ? AND role = 'user'
                """,
                (payload.regenerate_message_id, chat_id),
            ).fetchone()
            if not regenerate_message:
                return
            previous_first_user = conn.execute(
                """
                SELECT content FROM messages
                WHERE chat_id = ? AND role = 'user'
                ORDER BY message_order ASC, created_at ASC, rowid ASC
                LIMIT 1
                """,
                (chat_id,),
            ).fetchone()
            previous_first_user_content = (
                previous_first_user["content"] if previous_first_user else None
            )
            conn.execute(
                """
                DELETE FROM messages
                WHERE chat_id = ? AND message_order > ?
                """,
                (chat_id, regenerate_message["message_order"]),
            )
            delete_attachments_for_missing_messages(conn)
            conn.execute(
                """
                UPDATE messages SET content = ? WHERE id = ? AND chat_id = ?
                """,
                (payload.message.strip(), payload.regenerate_message_id, chat_id),
            )
            refresh_chat_after_message_change(
                conn, chat_id, previous_first_user_content
            )

        conn.execute(
            """
            INSERT INTO messages (
              id, chat_id, role, content, reasoning, sources, model, finish_reason,
              error, generation_id, prompt_tokens, completion_tokens,
              reasoning_tokens, cached_tokens, total_tokens, cost, provider_name,
              generation_time, latency, message_order, created_at
            )
            VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                assistant_message_id,
                chat_id,
                content,
                "".join(reasoning_text) or None,
                serialize_sources(sources),
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
                next_message_order(conn, chat_id),
                utc_now(),
            ),
        )
        conn.execute(
            "UPDATE chats SET updated_at = ? WHERE id = ?", (utc_now(), chat_id)
        )


async def stream_openrouter_response(
    chat_id: str,
    payload: StreamMessageRequest,
    assistant_message_id: str,
) -> AsyncIterator[bytes]:
    api_key = read_openrouter_key()
    if not api_key:
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

    messages = build_openrouter_messages(
        chat_id,
        globalChatSystemPrompt(),
        payload.regenerate_message_id,
        payload.message.strip(),
    )
    body: dict[str, Any] = {
        "model": openrouter_request_model(payload.model, payload.nitro_mode),
        "messages": messages,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "stream": True,
    }
    providerOptions = openrouter_provider_options()
    if providerOptions:
        body["provider"] = providerOptions

    cacheControl = prompt_cache_control()
    if cacheControl:
        body["cache_control"] = cacheControl
        body["session_id"] = chat_id

    with get_db() as conn:
        needsPdfParser = chat_has_pdf_attachment(conn, chat_id)

    plugins: list[dict[str, Any]] = []
    if needsPdfParser:
        plugins.extend(pdf_parser_plugins())
    if payload.web_search_enabled:
        plugins.append(web_search_plugin())
    if plugins:
        body["plugins"] = plugins

    supportsReasoning = model_supports_reasoning(payload.model)
    effectiveThinkingEnabled = effective_thinking_enabled(
        payload.model, payload.thinking_enabled
    )
    reasoningConfig = enabled_reasoning_config(
        payload.model, payload.thinking_enabled, payload.reasoning_effort
    )
    if reasoningConfig:
        body["reasoning"] = reasoningConfig
        body["reasoning_effort"] = reasoningConfig["effort"]
    elif supportsReasoning:
        body["reasoning"] = {"enabled": False, "exclude": True}
        body["reasoning_effort"] = "none"
        body["include_reasoning"] = False

    assistant_text: list[str] = []
    reasoning_text: list[str] = []
    sources: list[dict[str, str]] = []
    finish_reason: str | None = None
    error_text: str | None = None
    generation_id: str | None = None
    usage: dict[str, Any] | None = None
    stream_completed = False

    try:
        async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client:
            async with client.stream(
                "POST",
                f"{OPENROUTER_BASE_URL}/chat/completions",
                headers={**headers_for_key(api_key), "Content-Type": "application/json"},
                json=body,
            ) as response:
                if response.status_code >= 400:
                    raw_error = (await response.aread()).decode(
                        "utf-8", errors="replace"
                    )
                    error_text = openrouter_error_message(
                        response.status_code, raw_error
                    )
                    assistant_text.append(error_text)
                    yield stream_event("error", error_text)
                    return
                generation_id = response.headers.get("X-Generation-Id") or generation_id

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line.removeprefix("data:").strip()
                    if data == "[DONE]":
                        stream_completed = True
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
                    if finish_reason:
                        stream_completed = True
                    delta = choice.get("delta") or {}
                    message = choice.get("message") or {}
                    incomingSources = normalize_sources(
                        delta.get("annotations") or message.get("annotations")
                    )
                    if incomingSources:
                        merged = merge_sources(sources, incomingSources)
                        if merged != sources:
                            sources = merged
                            yield stream_event("sources", sources)
                    reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                    if reasoning and effectiveThinkingEnabled:
                        value = str(reasoning)
                        reasoning_text.append(value)
                        yield stream_event("reasoning", value)
                    content = delta.get("content")
                    if content:
                        value = str(content)
                        assistant_text.append(value)
                        yield stream_event("content", value)
                if generation_id:
                    generation_usage = await fetch_generation_usage(api_key, generation_id)
                    if generation_usage:
                        usage = {**(usage or {}), **generation_usage}
                if usage:
                    yield stream_event(
                        "usage",
                        {
                            "generation_id": generation_id,
                            "model": payload.model,
                            **usage,
                        },
                    )
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)
        fallback = f"RouterChat error: {error_text}"
        assistant_text.append(fallback)
        yield stream_event("error", fallback)
    finally:
        if not (payload.regenerate_message_id and (error_text or not stream_completed)):
            saveAssistantReply(
                chat_id,
                payload,
                assistant_message_id,
                assistant_text,
                reasoning_text,
                sources,
                finish_reason,
                error_text,
                generation_id,
                usage,
            )


@router.post("/api/chats/{chat_id}/messages/stream")
async def stream_message(
    chat_id: str,
    payload: StreamMessageRequest,
) -> StreamingResponse:
    if not read_openrouter_key():
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
    message = payload.message.strip()
    attachmentIds = payload.attachment_ids
    if not message and not attachmentIds:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    now = utc_now()
    user_message_id = payload.regenerate_message_id or str(uuid.uuid4())
    assistant_message_id = str(uuid.uuid4())

    with get_db() as conn:
        chat = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found.")
        has_messages = chat_has_messages(conn, chat_id)
        locked_model = chat["model"] if has_messages else payload.model
        if has_messages and payload.model != locked_model:
            raise HTTPException(
                status_code=409,
                detail=f"This chat is locked to {locked_model}. Start a new chat to use another model.",
            )

        if payload.regenerate_message_id:
            regenerateMessage = conn.execute(
                """
                SELECT * FROM messages
                WHERE id = ? AND chat_id = ?
                """,
                (payload.regenerate_message_id, chat_id),
            ).fetchone()
            if not regenerateMessage:
                raise HTTPException(status_code=404, detail="Message not found.")
            if regenerateMessage["role"] != "user":
                raise HTTPException(
                    status_code=400,
                    detail="Only user prompts can be regenerated.",
                )
            claim_attachments(
                conn,
                attachmentIds,
                chat_id=chat_id,
                message_id=user_message_id,
            )
        else:
            conn.execute(
                """
                INSERT INTO messages (
                  id, chat_id, role, content, reasoning, model, finish_reason,
                  error, message_order, created_at
                )
                VALUES (?, ?, 'user', ?, NULL, ?, NULL, NULL, ?, ?)
                """,
                (
                    user_message_id,
                    chat_id,
                    message,
                    payload.model,
                    next_message_order(conn, chat_id),
                    now,
                ),
            )
            claim_attachments(
                conn,
                attachmentIds,
                chat_id=chat_id,
                message_id=user_message_id,
            )

        title = chat["title"]
        #the naming route fills this in once the run is done, so leave the placeholder alone for it
        if title == "New chat" and not bool(read_app_setting("generate_chat_name")):
            title = chat_title_from_message(message)
        conn.execute(
            """
            UPDATE chats
            SET title = ?, model = ?, system_prompt = ?, temperature = ?,
                max_tokens = ?, thinking_enabled = ?, reasoning_effort = ?,
                web_search_enabled = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                title,
                locked_model,
                chatSystemPrompt(payload),
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                int(payload.web_search_enabled),
                now,
                chat_id,
            ),
        )

    return StreamingResponse(
        stream_openrouter_response(chat_id, payload, assistant_message_id),
        media_type="application/x-ndjson; charset=utf-8",
        headers={
            "X-User-Message-Id": user_message_id,
            "X-Assistant-Message-Id": assistant_message_id,
        },
    )
