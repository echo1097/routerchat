from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import delete_attachments_for_chat
from backend.chats.chatModels import FolderCreateRequest, FolderPatchRequest
from backend.chats.chatRows import row_to_folder
from backend.core.database import get_db
from backend.core.utils import patch_updates, utc_now

router = APIRouter()


def folder_or_404(conn: sqlite3.Connection, folder_id: str) -> sqlite3.Row:
    folder = conn.execute(
        "SELECT * FROM chat_folders WHERE id = ?", (folder_id,)
    ).fetchone()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found.")
    return folder


@router.get("/api/folders")
def list_folders() -> dict[str, Any]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM chat_folders ORDER BY created_at ASC"
        ).fetchall()
        counts = conn.execute(
            """
            SELECT folder_id, COUNT(*) AS chat_count FROM chats
            WHERE temporary = 0 AND folder_id IS NOT NULL
            GROUP BY folder_id
            """
        ).fetchall()

    chat_counts = {row["folder_id"]: row["chat_count"] for row in counts}
    folders = []
    for row in rows:
        folder = row_to_folder(row)
        folder["chat_count"] = chat_counts.get(folder["id"], 0)
        folders.append(folder)
    return {"folders": folders}


@router.post("/api/folders")
def create_folder(payload: FolderCreateRequest) -> dict[str, Any]:
    now = utc_now()
    folder_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO chat_folders (id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (folder_id, payload.name.strip(), now, now),
        )
        row = conn.execute(
            "SELECT * FROM chat_folders WHERE id = ?", (folder_id,)
        ).fetchone()

    folder = row_to_folder(row)
    folder["chat_count"] = 0
    return {"folder": folder}


@router.patch("/api/folders/{folder_id}")
def update_folder(folder_id: str, payload: FolderPatchRequest) -> dict[str, Any]:
    updates = patch_updates(payload)
    with get_db() as conn:
        folder_or_404(conn, folder_id)
        if updates:
            if "name" in updates:
                updates["name"] = updates["name"].strip()

            assignments = [f"{key} = ?" for key in updates]
            values = list(updates.values())
            assignments.append("updated_at = ?")
            values.append(utc_now())
            values.append(folder_id)
            conn.execute(
                f"UPDATE chat_folders SET {', '.join(assignments)} WHERE id = ?", values
            )

        row = conn.execute(
            "SELECT * FROM chat_folders WHERE id = ?", (folder_id,)
        ).fetchone()
        count = conn.execute(
            "SELECT COUNT(*) AS chat_count FROM chats WHERE folder_id = ? AND temporary = 0",
            (folder_id,),
        ).fetchone()

    folder = row_to_folder(row)
    folder["chat_count"] = count["chat_count"]
    return {"folder": folder}


@router.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: str, delete_chats: bool = False) -> dict[str, Any]:
    with get_db() as conn:
        folder_or_404(conn, folder_id)
        if delete_chats:
            chat_ids = [
                row["id"]
                for row in conn.execute(
                    "SELECT id FROM chats WHERE folder_id = ?", (folder_id,)
                ).fetchall()
            ]
            for chat_id in chat_ids:
                delete_attachments_for_chat(conn, chat_id)
                conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
                conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
        else:
            conn.execute(
                "UPDATE chats SET folder_id = NULL WHERE folder_id = ?", (folder_id,)
            )
        conn.execute("DELETE FROM chat_folders WHERE id = ?", (folder_id,))
    return {"ok": True}
