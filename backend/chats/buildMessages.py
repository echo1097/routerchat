from __future__ import annotations

from typing import Any

from backend.attachments.attachmentContent import (
    attachments_by_message,
    user_content_with_attachments,
)
from backend.chats.chatQueries import listContextMessages
from backend.core.database import get_db


def build_messages(
    chat_id: str,
    system_prompt: str,
    regenerate_message_id: str | None = None,
    replacement_content: str | None = None,
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    with get_db() as conn:
        rows = listContextMessages(conn, chat_id)
        attachmentsByMessage = attachments_by_message(conn, chat_id)

        for row in rows:
            isRegenerated = bool(regenerate_message_id) and row["id"] == regenerate_message_id
            if not isRegenerated and row["role"] not in {"user", "assistant"}:
                continue

            content = replacement_content or row["content"] if isRegenerated else row["content"]
            role = "user" if isRegenerated else row["role"]
            attachmentIds = [
                attachment["id"] for attachment in attachmentsByMessage.get(row["id"], [])
            ]

            if role == "user" and attachmentIds:
                content = user_content_with_attachments(conn, attachmentIds, content)

            messages.append({"role": role, "content": content})

            if isRegenerated:
                break

    return messages
