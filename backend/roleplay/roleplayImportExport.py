from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter

from backend.core.database import getDb
from backend.core.reasoningEffort import coerceReasoningEffort
from backend.core.utils import coerceBoolInt, floatOrNone, intOrNone, utcNow
from backend.providers.base import DEFAULT_MAX_TOKENS
from backend.providers.registry import getActiveProvider, providerIdForImport
from backend.roleplay.roleplayModels import RoleplayImportRequest
from backend.roleplay.roleplayQueries import (
    insertImportedMessage,
    insertImportedRoleplay,
    listRoleplayIds,
    listRoleplayMessageIds,
    listRoleplayMessages,
    nextRoleplayMessageOrder,
    requireRoleplay,
)
from backend.roleplay.roleplayRows import rowToRoleplay, rowToRoleplayMessage
from backend.webSearch.sources import normalizeSources, serializeSources

router = APIRouter()


@router.get("/api/roleplays/{roleplay_id}/export")
def exportRoleplay(roleplay_id: str) -> dict[str, Any]:
    with getDb() as conn:
        roleplay = requireRoleplay(conn, roleplay_id)
        message_rows = listRoleplayMessages(conn, roleplay_id)
    return {
        "schema": "routerchat.roleplays.v1",
        "exported_at": utcNow(),
        "roleplays": [rowToRoleplay(roleplay)],
        "messages": [rowToRoleplayMessage(row) for row in message_rows],
    }


@router.post("/api/roleplays/import")
def importRoleplays(payload: RoleplayImportRequest) -> dict[str, Any]:
    now = utcNow()
    roleplay_id_map: dict[str, str] = {}
    imported_roleplay_ids: set[str] = set()
    imported_messages = 0
    nextMessageOrders: dict[str, int] = {}

    with getDb() as conn:
        existing_roleplay_ids = {row["id"] for row in listRoleplayIds(conn)}
        existing_message_ids = {row["id"] for row in listRoleplayMessageIds(conn)}

        for item in payload.roleplays:
            source_id = str(item.get("id") or uuid.uuid4())
            roleplay_id = source_id
            if roleplay_id in existing_roleplay_ids or roleplay_id in imported_roleplay_ids:
                roleplay_id = str(uuid.uuid4())
            roleplay_id_map[source_id] = roleplay_id
            imported_roleplay_ids.add(roleplay_id)
            imported_temperature = floatOrNone(item.get("temperature"))
            importedModel = str(item.get("model") or "")
            importedProvider = providerIdForImport(item.get("provider"), importedModel)
            if not importedModel:
                importedModel = getActiveProvider().defaultModelId()
                importedProvider = getActiveProvider().id

            insertImportedRoleplay(
                conn,
                (
                    roleplay_id,
                    str(item.get("title") or "Imported roleplay")[:120],
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
            source_roleplay_id = str(item.get("roleplay_id") or item.get("chat_id") or "")
            roleplay_id = roleplay_id_map.get(source_roleplay_id)
            if not roleplay_id:
                continue
            message_id = str(item.get("id") or uuid.uuid4())
            if message_id in existing_message_ids:
                message_id = str(uuid.uuid4())
            existing_message_ids.add(message_id)
            if roleplay_id not in nextMessageOrders:
                nextMessageOrders[roleplay_id] = nextRoleplayMessageOrder(conn, roleplay_id)
            messageOrder = nextMessageOrders[roleplay_id]
            nextMessageOrders[roleplay_id] += 1

            insertImportedMessage(
                conn,
                (
                    message_id,
                    roleplay_id,
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
        "imported_roleplays": len(imported_roleplay_ids),
        "imported_messages": imported_messages,
    }
