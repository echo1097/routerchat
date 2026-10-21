from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AttachmentScope:
    #chats and roleplays keep their rows in separate tables, so every attachment query needs to know
    #which conversation column to match and which message table to join against
    conversationColumn: str
    messagesTable: str
    conversationLabel: str


CHAT_SCOPE = AttachmentScope(
    conversationColumn="chat_id",
    messagesTable="messages",
    conversationLabel="chat",
)

ROLEPLAY_SCOPE = AttachmentScope(
    conversationColumn="roleplay_id",
    messagesTable="roleplay_messages",
    conversationLabel="roleplay",
)
