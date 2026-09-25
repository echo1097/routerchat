from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import delete_attachments_for_chat
from backend.attachments.attachmentContent import attachments_by_message
from backend.chats.chatModels import ChatCreateRequest, ChatPatchRequest
from backend.chats.chatRows import chat_has_messages, row_to_chat, row_to_message
from backend.chats.folderRoutes import folder_or_404
from backend.chats.systemPrompts import chatSystemPrompt
from backend.core.database import get_db, message_order_clause
from backend.core.utils import patch_updates, utc_now
from backend.providers.openrouter.models import default_model_id

router = APIRouter()


@router.get("/api/chats")
def list_chats() -> dict[str, Any]:
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM chats
            WHERE temporary = 0
            ORDER BY pinned DESC, updated_at DESC, created_at DESC
            """
        ).fetchall()
    return {"chats": [row_to_chat(row) for row in rows]}


@router.post("/api/chats")
def create_chat(payload: ChatCreateRequest) -> dict[str, Any]:
    now = utc_now()
    chat_id = str(uuid.uuid4())
    model = payload.model or default_model_id()
    folder_id = (payload.folder_id or "").strip() or None
    with get_db() as conn:
        if folder_id:
            folder_or_404(conn, folder_id)
        conn.execute(
            """
            INSERT INTO chats (
              id, title, model, system_prompt, temperature, max_tokens,
              thinking_enabled, reasoning_effort, web_search_enabled, temporary,
              folder_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                chat_id,
                payload.title or "New chat",
                model,
                chatSystemPrompt(payload),
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
        row = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
    return {"chat": row_to_chat(row)}


@router.get("/api/chats/{chat_id}")
def get_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        chat = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found.")
        messages = conn.execute(
            f"SELECT * FROM messages WHERE chat_id = ? ORDER BY {message_order_clause()}",
            (chat_id,),
        ).fetchall()
        attachmentsByMessage = attachments_by_message(conn, chat_id)

    return {
        "chat": row_to_chat(chat),
        "messages": [
            {
                **row_to_message(row),
                "attachments": attachmentsByMessage.get(row["id"], []),
            }
            for row in messages
        ],
    }


@router.patch("/api/chats/{chat_id}")
def update_chat(chat_id: str, payload: ChatPatchRequest) -> dict[str, Any]:
    updates = patch_updates(payload)
    if "chat_system_prompt" in updates:
        updates["system_prompt"] = chatSystemPrompt(payload)
        updates.pop("chat_system_prompt", None)
    updates.pop("write_system_prompt", None)
    if not updates:
        return get_chat(chat_id)
    assignments: list[str] = []
    values: list[Any] = []
    with get_db() as conn:
        chat = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found.")
        if (
            "model" in updates
            and updates["model"] != chat["model"]
            and chat_has_messages(conn, chat_id)
        ):
            raise HTTPException(
                status_code=409,
                detail=f"This chat is locked to {chat['model']}. Start a new chat to use another model.",
            )
        if "folder_id" in updates:
            nextFolderId = (updates["folder_id"] or "").strip() or None
            if nextFolderId:
                folder_or_404(conn, nextFolderId)
            updates["folder_id"] = nextFolderId

        for key, value in updates.items():
            if key in {"thinking_enabled", "web_search_enabled", "pinned"}:
                value = int(bool(value))
            assignments.append(f"{key} = ?")
            values.append(value)

        #settings, renames, pins and folder moves are housekeeping, so they leave updated_at alone
        #and the chat keeps its place in the sidebar until someone actually talks in it
        values.append(chat_id)
        conn.execute(
            f"UPDATE chats SET {', '.join(assignments)} WHERE id = ?", values
        )
    return get_chat(chat_id)


@router.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        delete_attachments_for_chat(conn, chat_id)
        conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        result = conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Chat not found.")
    return {"ok": True}


@router.post("/api/chats/{chat_id}/close")
def close_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        chat = conn.execute(
            "SELECT temporary FROM chats WHERE id = ?", (chat_id,)
        ).fetchone()
        if not chat:
            return {"ok": True}
        if not bool(chat["temporary"]):
            return {"ok": True}
        delete_attachments_for_chat(conn, chat_id)
        conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    return {"ok": True}
