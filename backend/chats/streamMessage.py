from __future__ import annotations

import uuid
from contextlib import aclosing
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.attachments.attachmentCleanup import (
    claimAttachments,
    deleteAttachmentsForMissingMessages,
)
from backend.attachments.attachmentLimits import checkAttachmentLimits
from backend.attachments.attachmentContent import (
    chatHasPdfAttachment,
    pdfParserPlugins,
)
from backend.chats.buildMessages import buildMessages
from backend.chats.chatModels import StreamMessageRequest
from backend.chats.chatQueries import (
    deleteMessagesAfter,
    getFirstUserMessage,
    getUserMessage,
    insertAssistantMessage,
    insertUserMessage,
    requireChat,
    requireMessage,
    touchChat,
    updateChatAfterSend,
    updateMessageContent,
)
from backend.chats.chatRows import chatHasMessages, chatProvider, sendingProvider
from backend.chats.chatTitles import chatTitleFromMessage
from backend.chats.messageRoutes import refreshChatAfterMessageChange
from backend.chats.systemPrompts import chatSystemPrompt
from backend.core.appSettings import globalChatSystemPrompt, readAppSetting
from backend.core.database import getDb, nextMessageOrder
from backend.core.streamEvents import streamEvent
from backend.core.utils import utcNow
from backend.providers.base import ChatOptions
from backend.providers.modelStream import ModelStream
from backend.usage.recordUsage import recordUsage
from backend.webSearch.sources import (
    mergeSources,
    serializeSources,
    webSearchPlugin,
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
    with getDb() as conn:
        if payload.regenerate_message_id:
            regenerate_message = getUserMessage(conn, chat_id, payload.regenerate_message_id)
            if not regenerate_message:
                return
            previous_first_user = getFirstUserMessage(conn, chat_id)
            previous_first_user_content = (
                previous_first_user["content"] if previous_first_user else None
            )
            deleteMessagesAfter(conn, chat_id, regenerate_message["message_order"])
            deleteAttachmentsForMissingMessages(conn)
            updateMessageContent(
                conn, chat_id, payload.regenerate_message_id, payload.message.strip()
            )
            refreshChatAfterMessageChange(
                conn, chat_id, previous_first_user_content
            )

        createdAt = utcNow()
        insertAssistantMessage(
            conn,
            (
                assistant_message_id,
                chat_id,
                content,
                "".join(reasoning_text) or None,
                serializeSources(sources),
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
                nextMessageOrder(conn, chat_id),
                createdAt,
            ),
        )
        recordUsage(
            "message",
            assistant_message_id,
            payload.model,
            usage,
            createdAt,
            generation_id,
            chatProvider(conn, chat_id).id,
        )
        touchChat(conn, chat_id, utcNow())


async def streamChatResponse(
    chat_id: str,
    payload: StreamMessageRequest,
    assistant_message_id: str,
) -> AsyncIterator[bytes]:
    with getDb() as conn:
        provider = chatProvider(conn, chat_id)

    api_key = provider.requireKey()

    messages = buildMessages(
        chat_id,
        globalChatSystemPrompt(),
        payload.regenerate_message_id,
        payload.message.strip(),
    )

    with getDb() as conn:
        needsPdfParser = chatHasPdfAttachment(conn, chat_id)

    plugins: list[dict[str, Any]] = []
    if needsPdfParser and provider.capabilities.pdfParsing:
        plugins.extend(pdfParserPlugins())
    if payload.web_search_enabled and provider.capabilities.webSearch:
        plugins.append(webSearchPlugin())

    cacheControl = provider.promptCacheControl()
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
            explicitReasoning=True,
            plugins=plugins,
            cacheControl=cacheControl,
            sessionId=chat_id if cacheControl else None,
        ),
    )
    effectiveThinkingEnabled = provider.effectiveThinkingEnabled(
        payload.model, payload.thinking_enabled
    )

    modelStream = ModelStream(provider, request, effectiveThinkingEnabled)
    assistant_text = modelStream.textParts
    sources: list[dict[str, str]] = []
    error_text: str | None = None

    try:
        async with aclosing(modelStream.events()) as events:
            async for event in events:
                if event["type"] == "sources":
                    merged = mergeSources(sources, event["value"])
                    if merged != sources:
                        sources = merged
                        yield streamEvent("sources", sources)
                elif event["type"] == "reasoning":
                    yield streamEvent("reasoning", event["value"])
                elif event["type"] == "content":
                    yield streamEvent("content", event["value"])

        if modelStream.errorMessage:
            error_text = modelStream.errorMessage
            assistant_text.append(error_text)
            yield streamEvent("error", error_text)
            return

        await modelStream.fetchFinalUsage(api_key)
        if modelStream.usage:
            yield streamEvent(
                "usage",
                {
                    "generation_id": modelStream.generationId,
                    "model": payload.model,
                    **modelStream.usage,
                },
            )
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)
        fallback = f"RouterChat error: {error_text}"
        assistant_text.append(fallback)
        yield streamEvent("error", fallback)
    finally:
        stream_completed = modelStream.receivedDone or bool(modelStream.finishReason)
        if not (payload.regenerate_message_id and (error_text or not stream_completed)):
            saveAssistantReply(
                chat_id,
                payload,
                assistant_message_id,
                assistant_text,
                modelStream.reasoningParts,
                sources,
                modelStream.finishReason,
                error_text,
                modelStream.generationId,
                modelStream.usage or None,
            )


@router.post("/api/chats/{chat_id}/messages/stream")
async def streamMessage(
    chat_id: str,
    payload: StreamMessageRequest,
) -> StreamingResponse:
    provider = sendingProvider(chat_id)
    provider.requireKey()
    message = payload.message.strip()
    attachmentIds = payload.attachment_ids
    if not message and not attachmentIds:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    now = utcNow()
    user_message_id = payload.regenerate_message_id or str(uuid.uuid4())
    assistant_message_id = str(uuid.uuid4())

    with getDb() as conn:
        chat = requireChat(conn, chat_id)
        checkAttachmentLimits(
            conn,
            attachmentIds,
            provider,
            chatId=chat_id,
            throughMessageId=payload.regenerate_message_id,
            modelId=payload.model,
        )
        has_messages = chatHasMessages(conn, chat_id)
        locked_model = chat["model"] if has_messages else payload.model
        if has_messages and payload.model != locked_model:
            raise HTTPException(
                status_code=409,
                detail=f"This chat is locked to {locked_model}. Start a new chat to use another model.",
            )

        if payload.regenerate_message_id:
            regenerateMessage = requireMessage(conn, chat_id, payload.regenerate_message_id)
            if regenerateMessage["role"] != "user":
                raise HTTPException(
                    status_code=400,
                    detail="Only user prompts can be regenerated.",
                )
            claimAttachments(
                conn,
                attachmentIds,
                chat_id=chat_id,
                message_id=user_message_id,
            )
        else:
            insertUserMessage(
                conn,
                (
                    user_message_id,
                    chat_id,
                    message,
                    payload.model,
                    nextMessageOrder(conn, chat_id),
                    now,
                ),
            )
            claimAttachments(
                conn,
                attachmentIds,
                chat_id=chat_id,
                message_id=user_message_id,
            )

        title = chat["title"]
        #the naming route fills this in once the run is done, so leave the placeholder alone for it
        if title == "New chat" and not bool(readAppSetting("generate_chat_name")):
            title = chatTitleFromMessage(message)
        updateChatAfterSend(
            conn,
            (
                title,
                locked_model,
                provider.id,
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
        streamChatResponse(chat_id, payload, assistant_message_id),
        media_type="application/x-ndjson; charset=utf-8",
        headers={
            "X-User-Message-Id": user_message_id,
            "X-Assistant-Message-Id": assistant_message_id,
        },
    )
