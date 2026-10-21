from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import deleteAttachmentsForMissingMessages
from backend.attachments.attachmentScope import ROLEPLAY_SCOPE
from backend.core.database import getDb
from backend.core.utils import utcNow
from backend.roleplay.roleplayModels import RoleplayMessageUpdateRequest
from backend.roleplay.roleplayQueries import (
    deleteMessagesFrom,
    getFirstUserMessage,
    getRoleplayTitle,
    requireRoleplayMessage,
    setRoleplayTitle,
    touchRoleplay,
    updateMessageContent,
)
from backend.roleplay.roleplayRoutes import getRoleplayRoute
from backend.roleplay.roleplayTitles import roleplayTitleFromMessage

router = APIRouter()


def refreshRoleplayAfterMessageChange(
    conn: sqlite3.Connection,
    roleplay_id: str,
    previous_first_user_content: str | None,
) -> None:
    roleplay = getRoleplayTitle(conn, roleplay_id)
    if roleplay is None:
        return
    previous_auto_title = (
        roleplayTitleFromMessage(previous_first_user_content)
        if previous_first_user_content
        else "New roleplay"
    )
    if roleplay["title"] != previous_auto_title:
        #the title was customized, so leave it alone
        touchRoleplay(conn, roleplay_id, utcNow())
        return
    first_user = getFirstUserMessage(conn, roleplay_id)
    title = (
        roleplayTitleFromMessage(first_user["content"]) if first_user else "New roleplay"
    )
    setRoleplayTitle(conn, roleplay_id, title, utcNow())


@router.patch("/api/roleplays/{roleplay_id}/messages/{message_id}")
def updateRoleplayMessage(
    roleplay_id: str, message_id: str, payload: RoleplayMessageUpdateRequest
) -> dict[str, Any]:
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    with getDb() as conn:
        message = requireRoleplayMessage(conn, roleplay_id, message_id)
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be edited.")
        previous_first_user = getFirstUserMessage(conn, roleplay_id)
        previous_first_user_content = (
            previous_first_user["content"] if previous_first_user else None
        )
        updateMessageContent(conn, roleplay_id, message_id, content)
        refreshRoleplayAfterMessageChange(conn, roleplay_id, previous_first_user_content)
    return getRoleplayRoute(roleplay_id)


@router.delete("/api/roleplays/{roleplay_id}/messages/{message_id}")
def deleteRoleplayMessage(roleplay_id: str, message_id: str) -> dict[str, Any]:
    with getDb() as conn:
        message = requireRoleplayMessage(conn, roleplay_id, message_id)
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be deleted.")
        previous_first_user = getFirstUserMessage(conn, roleplay_id)
        previous_first_user_content = (
            previous_first_user["content"] if previous_first_user else None
        )
        deleteMessagesFrom(conn, roleplay_id, message["message_order"])
        deleteAttachmentsForMissingMessages(conn, ROLEPLAY_SCOPE)
        refreshRoleplayAfterMessageChange(conn, roleplay_id, previous_first_user_content)
    return getRoleplayRoute(roleplay_id)
