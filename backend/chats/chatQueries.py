from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import HTTPException

from backend.core.database import message_order_clause


def getChat(conn: sqlite3.Connection, chatId: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM chats WHERE id = ?", (chatId,)).fetchone()


def requireChat(conn: sqlite3.Connection, chatId: str) -> sqlite3.Row:
    chat = getChat(conn, chatId)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found.")
    return chat


def listChats(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM chats
        WHERE temporary = 0
        ORDER BY pinned DESC, updated_at DESC, created_at DESC
        """
    ).fetchall()


def listChatIds(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT id FROM chats").fetchall()


def getChatTitle(conn: sqlite3.Connection, chatId: str) -> sqlite3.Row | None:
    return conn.execute("SELECT title FROM chats WHERE id = ?", (chatId,)).fetchone()


def getChatTemporary(conn: sqlite3.Connection, chatId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT temporary FROM chats WHERE id = ?", (chatId,)
    ).fetchone()


def insertChat(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO chats (
          id, title, model, provider, system_prompt, temperature, max_tokens,
          thinking_enabled, reasoning_effort, web_search_enabled, temporary,
          folder_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def insertImportedChat(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO chats (
          id, title, model, provider, system_prompt, temperature, max_tokens,
          thinking_enabled, reasoning_effort, web_search_enabled, pinned,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def updateChatColumns(conn: sqlite3.Connection, assignments: list[str], values: list[Any]) -> None:
    conn.execute(
        f"UPDATE chats SET {', '.join(assignments)} WHERE id = ?", values
    )


def updateChatAfterSend(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        UPDATE chats
        SET title = ?, model = ?, provider = ?, system_prompt = ?, temperature = ?,
            max_tokens = ?, thinking_enabled = ?, reasoning_effort = ?,
            web_search_enabled = ?, updated_at = ?
        WHERE id = ?
        """,
        values,
    )


def touchChat(conn: sqlite3.Connection, chatId: str, now: str) -> None:
    conn.execute("UPDATE chats SET updated_at = ? WHERE id = ?", (now, chatId))


def setChatTitle(conn: sqlite3.Connection, chatId: str, title: str, now: str) -> None:
    conn.execute(
        "UPDATE chats SET title = ?, updated_at = ? WHERE id = ?",
        (title, now, chatId),
    )


def nameNewChat(conn: sqlite3.Connection, chatId: str, title: str) -> None:
    conn.execute(
        "UPDATE chats SET title = ? WHERE id = ? AND title = 'New chat'",
        (title, chatId),
    )


def deleteChat(conn: sqlite3.Connection, chatId: str) -> sqlite3.Cursor:
    conn.execute("DELETE FROM messages WHERE chat_id = ?", (chatId,))
    return conn.execute("DELETE FROM chats WHERE id = ?", (chatId,))


def getMessage(conn: sqlite3.Connection, chatId: str, messageId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM messages WHERE id = ? AND chat_id = ?",
        (messageId, chatId),
    ).fetchone()


def requireMessage(conn: sqlite3.Connection, chatId: str, messageId: str) -> sqlite3.Row:
    message = getMessage(conn, chatId, messageId)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found.")
    return message


def getUserMessage(conn: sqlite3.Connection, chatId: str, messageId: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM messages
        WHERE id = ? AND chat_id = ? AND role = 'user'
        """,
        (messageId, chatId),
    ).fetchone()


def getFirstUserMessage(conn: sqlite3.Connection, chatId: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT content FROM messages
        WHERE chat_id = ? AND role = 'user'
        ORDER BY message_order ASC, created_at ASC, rowid ASC
        LIMIT 1
        """,
        (chatId,),
    ).fetchone()


def getFirstUserMessageForTitle(conn: sqlite3.Connection, chatId: str) -> sqlite3.Row | None:
    return conn.execute(
        f"""
        SELECT content FROM messages
        WHERE chat_id = ? AND role = 'user'
        ORDER BY {message_order_clause()}
        LIMIT 1
        """,
        (chatId,),
    ).fetchone()


def listMessages(conn: sqlite3.Connection, chatId: str) -> list[sqlite3.Row]:
    return conn.execute(
        f"SELECT * FROM messages WHERE chat_id = ? ORDER BY {message_order_clause()}",
        (chatId,),
    ).fetchall()


def listContextMessages(conn: sqlite3.Connection, chatId: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT id, role, content FROM messages
        WHERE chat_id = ? AND error IS NULL
        ORDER BY message_order ASC, created_at ASC, rowid ASC
        """,
        (chatId,),
    ).fetchall()


def listMessageIds(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT id FROM messages").fetchall()


def updateMessageContent(conn: sqlite3.Connection, chatId: str, messageId: str, content: str) -> None:
    conn.execute(
        "UPDATE messages SET content = ? WHERE id = ? AND chat_id = ?",
        (content, messageId, chatId),
    )


def deleteMessagesFrom(conn: sqlite3.Connection, chatId: str, messageOrder: int) -> None:
    conn.execute(
        """
        DELETE FROM messages
        WHERE chat_id = ? AND message_order >= ?
        """,
        (chatId, messageOrder),
    )


def deleteMessagesAfter(conn: sqlite3.Connection, chatId: str, messageOrder: int) -> None:
    conn.execute(
        """
        DELETE FROM messages
        WHERE chat_id = ? AND message_order > ?
        """,
        (chatId, messageOrder),
    )


def insertUserMessage(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO messages (
          id, chat_id, role, content, reasoning, model, finish_reason,
          error, message_order, created_at
        )
        VALUES (?, ?, 'user', ?, NULL, ?, NULL, NULL, ?, ?)
        """,
        values,
    )


def insertAssistantMessage(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO messages (
          id, chat_id, role, content, reasoning, sources, model, finish_reason,
          error, generation_id, prompt_tokens, completion_tokens,
          reasoning_tokens, cached_tokens, total_tokens, cost, provider_name,
          generation_time, latency, message_order, created_at
        )
        VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def insertImportedMessage(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO messages (
          id, chat_id, role, content, reasoning, sources, model, finish_reason,
          error, generation_id, prompt_tokens, completion_tokens,
          reasoning_tokens, cached_tokens, total_tokens, cost, provider_name,
          generation_time, latency, message_order, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def getFolder(conn: sqlite3.Connection, folderId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM chat_folders WHERE id = ?", (folderId,)
    ).fetchone()


def listFolders(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM chat_folders ORDER BY created_at ASC"
    ).fetchall()


def countChatsByFolder(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT folder_id, COUNT(*) AS chat_count FROM chats
        WHERE temporary = 0 AND folder_id IS NOT NULL
        GROUP BY folder_id
        """
    ).fetchall()


def countFolderChats(conn: sqlite3.Connection, folderId: str) -> sqlite3.Row:
    return conn.execute(
        "SELECT COUNT(*) AS chat_count FROM chats WHERE folder_id = ? AND temporary = 0",
        (folderId,),
    ).fetchone()


def insertFolder(conn: sqlite3.Connection, folderId: str, name: str, now: str) -> None:
    conn.execute(
        """
        INSERT INTO chat_folders (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        """,
        (folderId, name, now, now),
    )


def updateFolderColumns(conn: sqlite3.Connection, assignments: list[str], values: list[Any]) -> None:
    conn.execute(
        f"UPDATE chat_folders SET {', '.join(assignments)} WHERE id = ?", values
    )


def listFolderChatIds(conn: sqlite3.Connection, folderId: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id FROM chats WHERE folder_id = ?", (folderId,)
    ).fetchall()


def unsetFolder(conn: sqlite3.Connection, folderId: str) -> None:
    conn.execute(
        "UPDATE chats SET folder_id = NULL WHERE folder_id = ?", (folderId,)
    )


def deleteFolder(conn: sqlite3.Connection, folderId: str) -> None:
    conn.execute("DELETE FROM chat_folders WHERE id = ?", (folderId,))
