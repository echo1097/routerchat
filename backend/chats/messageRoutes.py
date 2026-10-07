from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import (
    delete_attachments_for_missing_messages,
)
from backend.chats.chatModels import MessageUpdateRequest
from backend.chats.chatQueries import (
    deleteMessagesFrom,
    getChatTitle,
    getFirstUserMessage,
    requireMessage,
    setChatTitle,
    touchChat,
    updateMessageContent,
)
from backend.chats.chatRoutes import get_chat
from backend.chats.chatTitles import chat_title_from_message
from backend.core.database import get_db
from backend.core.utils import utc_now

router = APIRouter()


def refresh_chat_after_message_change(
    conn: sqlite3.Connection, chat_id: str, previous_first_user_content: str | None
) -> None:
    chat = getChatTitle(conn, chat_id)
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
        touchChat(conn, chat_id, utc_now())
        return
    first_user = getFirstUserMessage(conn, chat_id)
    title = chat_title_from_message(first_user["content"]) if first_user else "New chat"
    setChatTitle(conn, chat_id, title, utc_now())


@router.patch("/api/chats/{chat_id}/messages/{message_id}")
def update_message(
    chat_id: str, message_id: str, payload: MessageUpdateRequest
) -> dict[str, Any]:
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    with get_db() as conn:
        message = requireMessage(conn, chat_id, message_id)
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be edited.")
        previous_first_user = getFirstUserMessage(conn, chat_id)
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        updateMessageContent(conn, chat_id, message_id, content)
        refresh_chat_after_message_change(conn, chat_id, previous_first_user_content)
    return get_chat(chat_id)


@router.delete("/api/chats/{chat_id}/messages/{message_id}")
def delete_message(chat_id: str, message_id: str) -> dict[str, Any]:
    with get_db() as conn:
        message = requireMessage(conn, chat_id, message_id)
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be deleted.")
        previous_first_user = getFirstUserMessage(conn, chat_id)
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        deleteMessagesFrom(conn, chat_id, message["message_order"])
        delete_attachments_for_missing_messages(conn)
        refresh_chat_after_message_change(conn, chat_id, previous_first_user_content)
    return get_chat(chat_id)
