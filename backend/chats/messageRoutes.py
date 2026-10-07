from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import (
    deleteAttachmentsForMissingMessages,
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
from backend.chats.chatRoutes import getChatRoute
from backend.chats.chatTitles import chatTitleFromMessage
from backend.core.database import getDb
from backend.core.utils import utcNow

router = APIRouter()


def refreshChatAfterMessageChange(
    conn: sqlite3.Connection, chat_id: str, previous_first_user_content: str | None
) -> None:
    chat = getChatTitle(conn, chat_id)
    if chat is None:
        return
    previous_auto_title = (
        chatTitleFromMessage(previous_first_user_content)
        if previous_first_user_content
        else "New chat"
    )
    if chat["title"] != previous_auto_title:
        # The title was customized (renamed, or no longer matches the message it
        # was originally derived from) -- leave it alone.
        touchChat(conn, chat_id, utcNow())
        return
    first_user = getFirstUserMessage(conn, chat_id)
    title = chatTitleFromMessage(first_user["content"]) if first_user else "New chat"
    setChatTitle(conn, chat_id, title, utcNow())


@router.patch("/api/chats/{chat_id}/messages/{message_id}")
def updateMessage(
    chat_id: str, message_id: str, payload: MessageUpdateRequest
) -> dict[str, Any]:
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    with getDb() as conn:
        message = requireMessage(conn, chat_id, message_id)
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be edited.")
        previous_first_user = getFirstUserMessage(conn, chat_id)
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        updateMessageContent(conn, chat_id, message_id, content)
        refreshChatAfterMessageChange(conn, chat_id, previous_first_user_content)
    return getChatRoute(chat_id)


@router.delete("/api/chats/{chat_id}/messages/{message_id}")
def deleteMessage(chat_id: str, message_id: str) -> dict[str, Any]:
    with getDb() as conn:
        message = requireMessage(conn, chat_id, message_id)
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be deleted.")
        previous_first_user = getFirstUserMessage(conn, chat_id)
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        deleteMessagesFrom(conn, chat_id, message["message_order"])
        deleteAttachmentsForMissingMessages(conn)
        refreshChatAfterMessageChange(conn, chat_id, previous_first_user_content)
    return getChatRoute(chat_id)
