from __future__ import annotations

import sqlite3

CHAT_REVISION_CONFLICT = "chat_revision_conflict"


def ensureChatRevisionColumn(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(chats)")}
    if "message_revision" not in columns:
        conn.execute(
            "ALTER TABLE chats ADD COLUMN message_revision INTEGER NOT NULL DEFAULT 0"
        )


def bumpChatRevision(conn: sqlite3.Connection, chatId: str) -> None:
    conn.execute(
        "UPDATE chats SET message_revision = message_revision + 1 WHERE id = ?",
        (chatId,),
    )


def chatConflictDetail() -> dict[str, str]:
    return {
        "code": CHAT_REVISION_CONFLICT,
        "kind": "chatConflict",
        "title": "Chat changed on another device",
        "message": "This reply wasn't saved because the chat changed. Copy any text you want to keep, then reload the chat before trying again.",
    }
