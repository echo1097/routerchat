from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import deleteAttachmentsForChat
from backend.chats.chatModels import FolderCreateRequest, FolderPatchRequest
from backend.chats.chatQueries import (
    countChatsByFolder,
    countFolderChats,
    deleteChat,
    deleteFolder,
    getFolder,
    insertFolder,
    listFolderChatIds,
    listFolders,
    unsetFolder,
    updateFolderColumns,
)
from backend.chats.chatRows import rowToFolder
from backend.core.database import getDb
from backend.core.utils import patchUpdates, utcNow

router = APIRouter()


def folderOr404(conn: sqlite3.Connection, folder_id: str) -> sqlite3.Row:
    folder = getFolder(conn, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found.")
    return folder


@router.get("/api/folders")
def listFoldersRoute() -> dict[str, Any]:
    with getDb() as conn:
        rows = listFolders(conn)
        counts = countChatsByFolder(conn)

    chat_counts = {row["folder_id"]: row["chat_count"] for row in counts}
    folders = []
    for row in rows:
        folder = rowToFolder(row)
        folder["chat_count"] = chat_counts.get(folder["id"], 0)
        folders.append(folder)
    return {"folders": folders}


@router.post("/api/folders")
def createFolder(payload: FolderCreateRequest) -> dict[str, Any]:
    now = utcNow()
    folder_id = str(uuid.uuid4())
    with getDb() as conn:
        insertFolder(conn, folder_id, payload.name.strip(), now)
        row = getFolder(conn, folder_id)

    folder = rowToFolder(row)
    folder["chat_count"] = 0
    return {"folder": folder}


@router.patch("/api/folders/{folder_id}")
def updateFolder(folder_id: str, payload: FolderPatchRequest) -> dict[str, Any]:
    updates = patchUpdates(payload)
    with getDb() as conn:
        folderOr404(conn, folder_id)
        if updates:
            if "name" in updates:
                updates["name"] = updates["name"].strip()

            assignments = [f"{key} = ?" for key in updates]
            values = list(updates.values())
            assignments.append("updated_at = ?")
            values.append(utcNow())
            values.append(folder_id)
            updateFolderColumns(conn, assignments, values)

        row = getFolder(conn, folder_id)
        count = countFolderChats(conn, folder_id)

    folder = rowToFolder(row)
    folder["chat_count"] = count["chat_count"]
    return {"folder": folder}


@router.delete("/api/folders/{folder_id}")
def deleteFolderRoute(folder_id: str, delete_chats: bool = False) -> dict[str, Any]:
    with getDb() as conn:
        folderOr404(conn, folder_id)
        if delete_chats:
            chat_ids = [
                row["id"]
                for row in listFolderChatIds(conn, folder_id)
            ]
            for chat_id in chat_ids:
                deleteAttachmentsForChat(conn, chat_id)
                deleteChat(conn, chat_id)
        else:
            unsetFolder(conn, folder_id)
        deleteFolder(conn, folder_id)
    return {"ok": True}
