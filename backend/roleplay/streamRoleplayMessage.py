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
from backend.attachments.attachmentContent import (
    chatHasPdfAttachment,
    pdfParserPlugins,
)
from backend.attachments.attachmentLimits import checkAttachmentLimits
from backend.attachments.attachmentScope import ROLEPLAY_SCOPE
from backend.core.appSettings import globalRoleplaySystemPrompt, readAppSetting
from backend.core.database import getDb
from backend.core.streamEvents import streamEvent
from backend.core.utils import utcNow
from backend.providers.base import ChatOptions
from backend.providers.modelStream import ModelStream
from backend.roleplay.buildRoleplayMessages import buildRoleplayMessages
from backend.roleplay.roleplayMessageRoutes import refreshRoleplayAfterMessageChange
from backend.roleplay.roleplayCharacterRows import openingGreeting
from backend.roleplay.roleplayModels import StreamRoleplayMessageRequest
from backend.roleplay.roleplayQueries import (
    deleteMessagesAfter,
    insertGreetingMessage,
    getFirstUserMessage,
    getRoleplayUserMessage,
    insertAssistantMessage,
    insertUserMessage,
    nextRoleplayMessageOrder,
    requireRoleplay,
    requireRoleplayMessage,
    touchRoleplay,
    updateMessageContent,
    updateRoleplayAfterSend,
)
from backend.roleplay.roleplayRows import (
    roleplayHasMessages,
    roleplayProvider,
    sendingProvider,
)
from backend.roleplay.roleplaySystemPrompts import roleplaySystemPrompt
from backend.roleplay.roleplayTitles import roleplayTitleFromMessage
from backend.usage.recordUsage import recordUsage
from backend.webSearch.sources import (
    mergeSources,
    serializeSources,
    webSearchPlugin,
)

router = APIRouter()


def saveAssistantReply(
    roleplay_id: str,
    payload: StreamRoleplayMessageRequest,
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
            regenerate_message = getRoleplayUserMessage(
                conn, roleplay_id, payload.regenerate_message_id
            )
            if not regenerate_message:
                return
            previous_first_user = getFirstUserMessage(conn, roleplay_id)
            previous_first_user_content = (
                previous_first_user["content"] if previous_first_user else None
            )
            deleteMessagesAfter(conn, roleplay_id, regenerate_message["message_order"])
            deleteAttachmentsForMissingMessages(conn, ROLEPLAY_SCOPE)
            updateMessageContent(
                conn, roleplay_id, payload.regenerate_message_id, payload.message.strip()
            )
            refreshRoleplayAfterMessageChange(
                conn, roleplay_id, previous_first_user_content
            )

        createdAt = utcNow()
        insertAssistantMessage(
            conn,
            (
                assistant_message_id,
                roleplay_id,
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
                nextRoleplayMessageOrder(conn, roleplay_id),
                createdAt,
            ),
        )
        recordUsage(
            "roleplay_message",
            assistant_message_id,
            payload.model,
            usage,
            createdAt,
            generation_id,
            roleplayProvider(conn, roleplay_id).id,
        )
        touchRoleplay(conn, roleplay_id, utcNow())


async def streamRoleplayResponse(
    roleplay_id: str,
    payload: StreamRoleplayMessageRequest,
    assistant_message_id: str,
) -> AsyncIterator[bytes]:
    with getDb() as conn:
        provider = roleplayProvider(conn, roleplay_id)

    api_key = provider.requireKey()

    messages = buildRoleplayMessages(
        roleplay_id,
        globalRoleplaySystemPrompt(),
        payload.regenerate_message_id,
        payload.message.strip(),
    )

    with getDb() as conn:
        needsPdfParser = chatHasPdfAttachment(conn, roleplay_id, ROLEPLAY_SCOPE)

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
            sessionId=roleplay_id if cacheControl else None,
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
                roleplay_id,
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


@router.post("/api/roleplays/{roleplay_id}/messages/stream")
async def streamRoleplayMessage(
    roleplay_id: str,
    payload: StreamRoleplayMessageRequest,
) -> StreamingResponse:
    provider = sendingProvider(roleplay_id)
    provider.requireKey()
    message = payload.message.strip()
    attachmentIds = payload.attachment_ids
    if not message and not attachmentIds:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    now = utcNow()
    user_message_id = payload.regenerate_message_id or str(uuid.uuid4())
    assistant_message_id = str(uuid.uuid4())

    with getDb() as conn:
        roleplay = requireRoleplay(conn, roleplay_id)
        checkAttachmentLimits(
            conn,
            attachmentIds,
            provider,
            chatId=roleplay_id,
            throughMessageId=payload.regenerate_message_id,
            modelId=payload.model,
            scope=ROLEPLAY_SCOPE,
        )
        has_messages = roleplayHasMessages(conn, roleplay_id)
        locked_model = roleplay["model"] if has_messages else payload.model
        if has_messages and payload.model != locked_model:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"This roleplay is locked to {locked_model}. "
                    "Start a new roleplay to use another model."
                ),
            )

        if payload.regenerate_message_id:
            regenerateMessage = requireRoleplayMessage(
                conn, roleplay_id, payload.regenerate_message_id
            )
            if regenerateMessage["role"] != "user":
                raise HTTPException(
                    status_code=400,
                    detail="Only user prompts can be regenerated.",
                )
        else:
            if not has_messages:
                greeting = openingGreeting(conn, roleplay_id)
                if greeting:
                    insertGreetingMessage(
                        conn,
                        (
                            str(uuid.uuid4()),
                            roleplay_id,
                            greeting,
                            nextRoleplayMessageOrder(conn, roleplay_id),
                            now,
                        ),
                    )

            insertUserMessage(
                conn,
                (
                    user_message_id,
                    roleplay_id,
                    message,
                    payload.model,
                    nextRoleplayMessageOrder(conn, roleplay_id),
                    now,
                ),
            )

        claimAttachments(
            conn,
            attachmentIds,
            message_id=user_message_id,
            roleplay_id=roleplay_id,
        )

        title = roleplay["title"]
        #the naming route fills this in once the run is done, so leave the placeholder alone for it
        if title == "New roleplay" and not bool(readAppSetting("generate_chat_name")):
            title = roleplayTitleFromMessage(message)
        updateRoleplayAfterSend(
            conn,
            (
                title,
                locked_model,
                provider.id,
                roleplaySystemPrompt(payload),
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                int(payload.web_search_enabled),
                now,
                roleplay_id,
            ),
        )

    return StreamingResponse(
        streamRoleplayResponse(roleplay_id, payload, assistant_message_id),
        media_type="application/x-ndjson; charset=utf-8",
        headers={
            "X-User-Message-Id": user_message_id,
            "X-Assistant-Message-Id": assistant_message_id,
        },
    )
