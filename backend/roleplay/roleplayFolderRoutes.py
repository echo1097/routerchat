from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import deleteAttachmentsForRoleplay
from backend.core.database import getDb
from backend.core.utils import patchUpdates, utcNow
from backend.roleplay.roleplayModels import (
    RoleplayFolderCreateRequest,
    RoleplayFolderPatchRequest,
)
from backend.roleplay.roleplayQueries import (
    countFolderRoleplays,
    countRoleplaysByFolder,
    deleteRoleplay,
    deleteRoleplayFolder,
    getRoleplayFolder,
    insertRoleplayFolder,
    listFolderRoleplayIds,
    listRoleplayFolders,
    unsetRoleplayFolder,
    updateRoleplayFolderColumns,
)
from backend.roleplay.roleplayRows import rowToRoleplayFolder

router = APIRouter()


def roleplayFolderOr404(conn: sqlite3.Connection, folder_id: str) -> sqlite3.Row:
    folder = getRoleplayFolder(conn, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found.")
    return folder


@router.get("/api/roleplay-folders")
def listRoleplayFoldersRoute() -> dict[str, Any]:
    with getDb() as conn:
        rows = listRoleplayFolders(conn)
        counts = countRoleplaysByFolder(conn)

    roleplay_counts = {row["folder_id"]: row["roleplay_count"] for row in counts}
    folders = []
    for row in rows:
        folder = rowToRoleplayFolder(row)
        folder["roleplay_count"] = roleplay_counts.get(folder["id"], 0)
        folders.append(folder)
    return {"folders": folders}


@router.post("/api/roleplay-folders")
def createRoleplayFolder(payload: RoleplayFolderCreateRequest) -> dict[str, Any]:
    now = utcNow()
    folder_id = str(uuid.uuid4())
    with getDb() as conn:
        insertRoleplayFolder(conn, folder_id, payload.name.strip(), now)
        row = getRoleplayFolder(conn, folder_id)

    folder = rowToRoleplayFolder(row)
    folder["roleplay_count"] = 0
    return {"folder": folder}


@router.patch("/api/roleplay-folders/{folder_id}")
def updateRoleplayFolder(
    folder_id: str, payload: RoleplayFolderPatchRequest
) -> dict[str, Any]:
    updates = patchUpdates(payload)
    with getDb() as conn:
        roleplayFolderOr404(conn, folder_id)
        if updates:
            if "name" in updates:
                updates["name"] = updates["name"].strip()

            assignments = [f"{key} = ?" for key in updates]
            values = list(updates.values())
            assignments.append("updated_at = ?")
            values.append(utcNow())
            values.append(folder_id)
            updateRoleplayFolderColumns(conn, assignments, values)

        row = getRoleplayFolder(conn, folder_id)
        count = countFolderRoleplays(conn, folder_id)

    folder = rowToRoleplayFolder(row)
    folder["roleplay_count"] = count["roleplay_count"]
    return {"folder": folder}


@router.delete("/api/roleplay-folders/{folder_id}")
def deleteRoleplayFolderRoute(
    folder_id: str, delete_roleplays: bool = False
) -> dict[str, Any]:
    with getDb() as conn:
        roleplayFolderOr404(conn, folder_id)
        if delete_roleplays:
            roleplay_ids = [row["id"] for row in listFolderRoleplayIds(conn, folder_id)]
            for roleplay_id in roleplay_ids:
                deleteAttachmentsForRoleplay(conn, roleplay_id)
                deleteRoleplay(conn, roleplay_id)
        else:
            unsetRoleplayFolder(conn, folder_id)
        deleteRoleplayFolder(conn, folder_id)
    return {"ok": True}
