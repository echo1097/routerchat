from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter

from backend.chats.chatQueries import (
    insertImportedChat,
    insertImportedMessage,
    listChatIds,
    listMessageIds,
    listMessages,
    requireChat,
)
from backend.chats.chatModels import ChatImportRequest
from backend.chats.chatRows import rowToChat, rowToMessage
from backend.core.database import getDb, nextMessageOrder
from backend.core.reasoningEffort import coerceReasoningEffort
from backend.core.utils import coerceBoolInt, floatOrNone, intOrNone, utcNow
from backend.providers.base import DEFAULT_MAX_TOKENS
from backend.providers.registry import getActiveProvider, providerIdForImport
from backend.webSearch.sources import normalizeSources, serializeSources

router = APIRouter()


@router.get("/api/chats/{chat_id}/export")
def exportChat(chat_id: str) -> dict[str, Any]:
    with getDb() as conn:
        chat = requireChat(conn, chat_id)
        message_rows = listMessages(conn, chat_id)
    return {
        "schema": "routerchat.chats.v1",
        "exported_at": utcNow(),
        "chats": [rowToChat(chat)],
        "messages": [rowToMessage(row) for row in message_rows],
    }


@router.post("/api/chats/import")
def importChats(payload: ChatImportRequest) -> dict[str, Any]:
    now = utcNow()
    chat_id_map: dict[str, str] = {}
    imported_chat_ids: set[str] = set()
    imported_messages = 0
    nextMessageOrders: dict[str, int] = {}

    with getDb() as conn:
        existing_chat_ids = {
            row["id"] for row in listChatIds(conn)
        }
        existing_message_ids = {
            row["id"] for row in listMessageIds(conn)
        }

        for item in payload.chats:
            source_id = str(item.get("id") or uuid.uuid4())
            chat_id = source_id
            if chat_id in existing_chat_ids or chat_id in imported_chat_ids:
                chat_id = str(uuid.uuid4())
            chat_id_map[source_id] = chat_id
            imported_chat_ids.add(chat_id)
            imported_temperature = floatOrNone(item.get("temperature"))
            importedModel = str(item.get("model") or "")
            importedProvider = providerIdForImport(item.get("provider"), importedModel)
            if not importedModel:
                importedModel = getActiveProvider().defaultModelId()
                importedProvider = getActiveProvider().id

            insertImportedChat(
                conn,
                (
                    chat_id,
                    str(item.get("title") or "Imported chat")[:120],
                    importedModel,
                    importedProvider,
                    str(item.get("system_prompt") or ""),
                    0.7 if imported_temperature is None else imported_temperature,
                    intOrNone(item.get("max_tokens")) or DEFAULT_MAX_TOKENS,
                    coerceBoolInt(item.get("thinking_enabled")),
                    coerceReasoningEffort(item.get("reasoning_effort")),
                    coerceBoolInt(item.get("web_search_enabled")),
                    coerceBoolInt(item.get("pinned")),
                    str(item.get("created_at") or now),
                    str(item.get("updated_at") or now),
                ),
            )

        for item in payload.messages:
            source_chat_id = str(item.get("chat_id") or "")
            chat_id = chat_id_map.get(source_chat_id)
            if not chat_id:
                continue
            message_id = str(item.get("id") or uuid.uuid4())
            if message_id in existing_message_ids:
                message_id = str(uuid.uuid4())
            existing_message_ids.add(message_id)
            if chat_id not in nextMessageOrders:
                nextMessageOrders[chat_id] = nextMessageOrder(conn, chat_id)
            messageOrder = nextMessageOrders[chat_id]
            nextMessageOrders[chat_id] += 1

            insertImportedMessage(
                conn,
                (
                    message_id,
                    chat_id,
                    str(item.get("role") or "user"),
                    str(item.get("content") or ""),
                    item.get("reasoning"),
                    serializeSources(normalizeSources(item.get("sources"))),
                    item.get("model"),
                    item.get("finish_reason"),
                    item.get("error"),
                    item.get("generation_id"),
                    intOrNone(item.get("prompt_tokens")),
                    intOrNone(item.get("completion_tokens")),
                    intOrNone(item.get("reasoning_tokens")),
                    intOrNone(item.get("cached_tokens")),
                    intOrNone(item.get("total_tokens")),
                    floatOrNone(item.get("cost")),
                    item.get("provider_name"),
                    floatOrNone(item.get("generation_time")),
                    floatOrNone(item.get("latency")),
                    messageOrder,
                    str(item.get("created_at") or now),
                ),
            )
            imported_messages += 1

    return {
        "ok": True,
        "imported_chats": len(imported_chat_ids),
        "imported_messages": imported_messages,
    }
