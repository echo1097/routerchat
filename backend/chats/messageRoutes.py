from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import (
    delete_attachments_for_missing_messages,
)
from backend.chats.chatModels import MessageUpdateRequest
from backend.chats.chatRoutes import get_chat
from backend.chats.chatTitles import chat_title_from_message
from backend.core.database import get_db
from backend.core.utils import utc_now

router = APIRouter()


def refresh_chat_after_message_change(
    conn: sqlite3.Connection, chat_id: str, previous_first_user_content: str | None
) -> None:
    chat = conn.execute("SELECT title FROM chats WHERE id = ?", (chat_id,)).fetchone()
    if chat is None:
        return
    previous_auto_title = (
        chat_title_from_message(previous_first_user_content)
        if previous_first_user_content
        else "New chat"
    )
    if chat["title"] != previous_auto_title:
        # The title was customized (renamed, or no longer matches the message it
        # was originally derived from) -- leave it alone.
        conn.execute("UPDATE chats SET updated_at = ? WHERE id = ?", (utc_now(), chat_id))
        return
    first_user = conn.execute(
        """
        SELECT content FROM messages
        WHERE chat_id = ? AND role = 'user'
        ORDER BY message_order ASC, created_at ASC, rowid ASC
        LIMIT 1
        """,
        (chat_id,),
    ).fetchone()
    title = chat_title_from_message(first_user["content"]) if first_user else "New chat"
    conn.execute(
        "UPDATE chats SET title = ?, updated_at = ? WHERE id = ?",
        (title, utc_now(), chat_id),
    )


@router.patch("/api/chats/{chat_id}/messages/{message_id}")
def update_message(
    chat_id: str, message_id: str, payload: MessageUpdateRequest
) -> dict[str, Any]:
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    with get_db() as conn:
        message = conn.execute(
            "SELECT * FROM messages WHERE id = ? AND chat_id = ?",
            (message_id, chat_id),
        ).fetchone()
        if not message:
            raise HTTPException(status_code=404, detail="Message not found.")
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be edited.")
        previous_first_user = conn.execute(
            """
            SELECT content FROM messages
            WHERE chat_id = ? AND role = 'user'
            ORDER BY message_order ASC, created_at ASC, rowid ASC
            LIMIT 1
            """,
            (chat_id,),
        ).fetchone()
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        conn.execute(
            "UPDATE messages SET content = ? WHERE id = ? AND chat_id = ?",
            (content, message_id, chat_id),
        )
        refresh_chat_after_message_change(conn, chat_id, previous_first_user_content)
    return get_chat(chat_id)


@router.delete("/api/chats/{chat_id}/messages/{message_id}")
def delete_message(chat_id: str, message_id: str) -> dict[str, Any]:
    with get_db() as conn:
        message = conn.execute(
            "SELECT * FROM messages WHERE id = ? AND chat_id = ?",
            (message_id, chat_id),
        ).fetchone()
        if not message:
            raise HTTPException(status_code=404, detail="Message not found.")
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be deleted.")
        previous_first_user = conn.execute(
            """
            SELECT content FROM messages
            WHERE chat_id = ? AND role = 'user'
            ORDER BY message_order ASC, created_at ASC, rowid ASC
            LIMIT 1
            """,
            (chat_id,),
        ).fetchone()
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        conn.execute(
            """
            DELETE FROM messages
            WHERE chat_id = ? AND message_order >= ?
            """,
            (chat_id, message["message_order"]),
        )
        delete_attachments_for_missing_messages(conn)
        refresh_chat_after_message_change(conn, chat_id, previous_first_user_content)
    return get_chat(chat_id)
