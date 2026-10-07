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
from backend.chats.chatRows import row_to_chat, row_to_message
from backend.core.database import get_db, next_message_order
from backend.core.reasoningEffort import coerce_reasoning_effort
from backend.core.utils import coerce_bool_int, float_or_none, int_or_none, utc_now
from backend.providers.base import DEFAULT_MAX_TOKENS
from backend.providers.registry import getActiveProvider, providerIdForImport
from backend.webSearch.sources import normalize_sources, serialize_sources

router = APIRouter()


@router.get("/api/chats/{chat_id}/export")
def export_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        chat = requireChat(conn, chat_id)
        message_rows = listMessages(conn, chat_id)
    return {
        "schema": "routerchat.chats.v1",
        "exported_at": utc_now(),
        "chats": [row_to_chat(chat)],
        "messages": [row_to_message(row) for row in message_rows],
    }


@router.post("/api/chats/import")
def import_chats(payload: ChatImportRequest) -> dict[str, Any]:
    now = utc_now()
    chat_id_map: dict[str, str] = {}
    imported_chat_ids: set[str] = set()
    imported_messages = 0
    nextMessageOrders: dict[str, int] = {}

    with get_db() as conn:
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
            imported_temperature = float_or_none(item.get("temperature"))
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
                    int_or_none(item.get("max_tokens")) or DEFAULT_MAX_TOKENS,
                    coerce_bool_int(item.get("thinking_enabled")),
                    coerce_reasoning_effort(item.get("reasoning_effort")),
                    coerce_bool_int(item.get("web_search_enabled")),
                    coerce_bool_int(item.get("pinned")),
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
                nextMessageOrders[chat_id] = next_message_order(conn, chat_id)
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
                    serialize_sources(normalize_sources(item.get("sources"))),
                    item.get("model"),
                    item.get("finish_reason"),
                    item.get("error"),
                    item.get("generation_id"),
                    int_or_none(item.get("prompt_tokens")),
                    int_or_none(item.get("completion_tokens")),
                    int_or_none(item.get("reasoning_tokens")),
                    int_or_none(item.get("cached_tokens")),
                    int_or_none(item.get("total_tokens")),
                    float_or_none(item.get("cost")),
                    item.get("provider_name"),
                    float_or_none(item.get("generation_time")),
                    float_or_none(item.get("latency")),
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
