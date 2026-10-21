from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import deleteAttachmentsForRoleplay
from backend.attachments.attachmentContent import groupAttachmentsByMessage
from backend.attachments.attachmentScope import ROLEPLAY_SCOPE
from backend.core.database import getDb
from backend.core.utils import patchUpdates, utcNow
from backend.providers.registry import getActiveProvider
from backend.roleplay.roleplayFolderRoutes import roleplayFolderOr404
from backend.roleplay.roleplayModels import RoleplayCreateRequest, RoleplayPatchRequest
from backend.roleplay.roleplayQueries import (
    deleteRoleplay,
    getRoleplay,
    getRoleplayTemporary,
    insertRoleplay,
    listRoleplayMessages,
    listRoleplays,
    requireRoleplay,
    updateRoleplayColumns,
)
from backend.roleplay.roleplayRows import (
    roleplayHasMessages,
    rowToRoleplay,
    rowToRoleplayMessage,
)
from backend.roleplay.roleplaySystemPrompts import roleplaySystemPrompt

router = APIRouter()


@router.get("/api/roleplays")
def listRoleplaysRoute() -> dict[str, Any]:
    with getDb() as conn:
        rows = listRoleplays(conn)
    return {"roleplays": [rowToRoleplay(row) for row in rows]}


@router.post("/api/roleplays")
def createRoleplay(payload: RoleplayCreateRequest) -> dict[str, Any]:
    now = utcNow()
    roleplay_id = str(uuid.uuid4())
    provider = getActiveProvider()
    model = payload.model or provider.defaultModelId()
    folder_id = (payload.folder_id or "").strip() or None

    with getDb() as conn:
        if folder_id:
            roleplayFolderOr404(conn, folder_id)
        insertRoleplay(
            conn,
            (
                roleplay_id,
                payload.title or "New roleplay",
                model,
                provider.id,
                roleplaySystemPrompt(payload),
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                int(payload.web_search_enabled),
                int(payload.temporary),
                folder_id,
                now,
                now,
            ),
        )
        row = getRoleplay(conn, roleplay_id)
    return {"roleplay": rowToRoleplay(row)}


@router.get("/api/roleplays/{roleplay_id}")
def getRoleplayRoute(roleplay_id: str) -> dict[str, Any]:
    with getDb() as conn:
        roleplay = requireRoleplay(conn, roleplay_id)
        messages = listRoleplayMessages(conn, roleplay_id)
        attachmentsByMessage = groupAttachmentsByMessage(
            conn, roleplay_id, ROLEPLAY_SCOPE
        )

    return {
        "roleplay": rowToRoleplay(roleplay),
        "messages": [
            {
                **rowToRoleplayMessage(row),
                "attachments": attachmentsByMessage.get(row["id"], []),
            }
            for row in messages
        ],
    }


@router.patch("/api/roleplays/{roleplay_id}")
def updateRoleplay(roleplay_id: str, payload: RoleplayPatchRequest) -> dict[str, Any]:
    updates = patchUpdates(payload)
    if "roleplay_system_prompt" in updates:
        updates["system_prompt"] = roleplaySystemPrompt(payload)
        updates.pop("roleplay_system_prompt", None)
    if not updates:
        return getRoleplayRoute(roleplay_id)

    assignments: list[str] = []
    values: list[Any] = []
    with getDb() as conn:
        roleplay = requireRoleplay(conn, roleplay_id)
        if (
            "model" in updates
            and updates["model"] != roleplay["model"]
            and roleplayHasMessages(conn, roleplay_id)
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"This roleplay is locked to {roleplay['model']}. "
                    "Start a new roleplay to use another model."
                ),
            )
        if "folder_id" in updates:
            nextFolderId = (updates["folder_id"] or "").strip() or None
            if nextFolderId:
                roleplayFolderOr404(conn, nextFolderId)
            updates["folder_id"] = nextFolderId

        for key, value in updates.items():
            if key in {"thinking_enabled", "web_search_enabled", "pinned"}:
                value = int(bool(value))
            assignments.append(f"{key} = ?")
            values.append(value)

        #settings, renames, pins and folder moves are housekeeping, so they leave updated_at alone
        #and the roleplay keeps its place in the sidebar until someone actually plays in it
        values.append(roleplay_id)
        updateRoleplayColumns(conn, assignments, values)
    return getRoleplayRoute(roleplay_id)


@router.delete("/api/roleplays/{roleplay_id}")
def deleteRoleplayRoute(roleplay_id: str) -> dict[str, Any]:
    with getDb() as conn:
        deleteAttachmentsForRoleplay(conn, roleplay_id)
        result = deleteRoleplay(conn, roleplay_id)
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Roleplay not found.")
    return {"ok": True}


@router.post("/api/roleplays/{roleplay_id}/close")
def closeRoleplay(roleplay_id: str) -> dict[str, Any]:
    with getDb() as conn:
        roleplay = getRoleplayTemporary(conn, roleplay_id)
        if not roleplay:
            return {"ok": True}
        if not bool(roleplay["temporary"]):
            return {"ok": True}
        deleteAttachmentsForRoleplay(conn, roleplay_id)
        deleteRoleplay(conn, roleplay_id)
    return {"ok": True}
