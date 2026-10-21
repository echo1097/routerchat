from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import HTTPException

from backend.core.database import messageOrderClause


def nextRoleplayMessageOrder(conn: sqlite3.Connection, roleplayId: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(message_order), -1) + 1 AS next_order
        FROM roleplay_messages
        WHERE roleplay_id = ?
        """,
        (roleplayId,),
    ).fetchone()
    return int(row["next_order"])


def getRoleplay(conn: sqlite3.Connection, roleplayId: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM roleplays WHERE id = ?", (roleplayId,)).fetchone()


def requireRoleplay(conn: sqlite3.Connection, roleplayId: str) -> sqlite3.Row:
    roleplay = getRoleplay(conn, roleplayId)
    if not roleplay:
        raise HTTPException(status_code=404, detail="Roleplay not found.")
    return roleplay


def listRoleplays(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM roleplays
        WHERE temporary = 0
        ORDER BY pinned DESC, updated_at DESC, created_at DESC
        """
    ).fetchall()


def listRoleplayIds(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT id FROM roleplays").fetchall()


def getRoleplayTitle(conn: sqlite3.Connection, roleplayId: str) -> sqlite3.Row | None:
    return conn.execute("SELECT title FROM roleplays WHERE id = ?", (roleplayId,)).fetchone()


def getRoleplayTemporary(conn: sqlite3.Connection, roleplayId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT temporary FROM roleplays WHERE id = ?", (roleplayId,)
    ).fetchone()


def insertRoleplay(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO roleplays (
          id, title, model, provider, system_prompt, temperature, max_tokens,
          thinking_enabled, reasoning_effort, web_search_enabled, temporary,
          folder_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def insertImportedRoleplay(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO roleplays (
          id, title, model, provider, system_prompt, temperature, max_tokens,
          thinking_enabled, reasoning_effort, web_search_enabled, pinned,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def updateRoleplayColumns(
    conn: sqlite3.Connection, assignments: list[str], values: list[Any]
) -> None:
    conn.execute(
        f"UPDATE roleplays SET {', '.join(assignments)} WHERE id = ?", values
    )


def updateRoleplayAfterSend(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        UPDATE roleplays
        SET title = ?, model = ?, provider = ?, system_prompt = ?, temperature = ?,
            max_tokens = ?, thinking_enabled = ?, reasoning_effort = ?,
            web_search_enabled = ?, updated_at = ?
        WHERE id = ?
        """,
        values,
    )


def touchRoleplay(conn: sqlite3.Connection, roleplayId: str, now: str) -> None:
    conn.execute("UPDATE roleplays SET updated_at = ? WHERE id = ?", (now, roleplayId))


def setRoleplayTitle(
    conn: sqlite3.Connection, roleplayId: str, title: str, now: str
) -> None:
    conn.execute(
        "UPDATE roleplays SET title = ?, updated_at = ? WHERE id = ?",
        (title, now, roleplayId),
    )


def nameNewRoleplay(conn: sqlite3.Connection, roleplayId: str, title: str) -> None:
    conn.execute(
        "UPDATE roleplays SET title = ? WHERE id = ? AND title = 'New roleplay'",
        (title, roleplayId),
    )


def deleteRoleplay(conn: sqlite3.Connection, roleplayId: str) -> sqlite3.Cursor:
    conn.execute("DELETE FROM roleplay_messages WHERE roleplay_id = ?", (roleplayId,))
    return conn.execute("DELETE FROM roleplays WHERE id = ?", (roleplayId,))


def getRoleplayMessage(
    conn: sqlite3.Connection, roleplayId: str, messageId: str
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM roleplay_messages WHERE id = ? AND roleplay_id = ?",
        (messageId, roleplayId),
    ).fetchone()


def requireRoleplayMessage(
    conn: sqlite3.Connection, roleplayId: str, messageId: str
) -> sqlite3.Row:
    message = getRoleplayMessage(conn, roleplayId, messageId)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found.")
    return message


def getRoleplayUserMessage(
    conn: sqlite3.Connection, roleplayId: str, messageId: str
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM roleplay_messages
        WHERE id = ? AND roleplay_id = ? AND role = 'user'
        """,
        (messageId, roleplayId),
    ).fetchone()


def getFirstUserMessage(conn: sqlite3.Connection, roleplayId: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT content FROM roleplay_messages
        WHERE roleplay_id = ? AND role = 'user'
        ORDER BY message_order ASC, created_at ASC, rowid ASC
        LIMIT 1
        """,
        (roleplayId,),
    ).fetchone()


def getFirstUserMessageForTitle(
    conn: sqlite3.Connection, roleplayId: str
) -> sqlite3.Row | None:
    return conn.execute(
        f"""
        SELECT content FROM roleplay_messages
        WHERE roleplay_id = ? AND role = 'user'
        ORDER BY {messageOrderClause()}
        LIMIT 1
        """,
        (roleplayId,),
    ).fetchone()


def listRoleplayMessages(conn: sqlite3.Connection, roleplayId: str) -> list[sqlite3.Row]:
    return conn.execute(
        f"""
        SELECT * FROM roleplay_messages
        WHERE roleplay_id = ?
        ORDER BY {messageOrderClause()}
        """,
        (roleplayId,),
    ).fetchall()


def listContextMessages(conn: sqlite3.Connection, roleplayId: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT id, role, content FROM roleplay_messages
        WHERE roleplay_id = ? AND error IS NULL
        ORDER BY message_order ASC, created_at ASC, rowid ASC
        """,
        (roleplayId,),
    ).fetchall()


def listRoleplayMessageIds(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT id FROM roleplay_messages").fetchall()


def updateMessageContent(
    conn: sqlite3.Connection, roleplayId: str, messageId: str, content: str
) -> None:
    conn.execute(
        "UPDATE roleplay_messages SET content = ? WHERE id = ? AND roleplay_id = ?",
        (content, messageId, roleplayId),
    )


def deleteMessagesFrom(
    conn: sqlite3.Connection, roleplayId: str, messageOrder: int
) -> None:
    conn.execute(
        """
        DELETE FROM roleplay_messages
        WHERE roleplay_id = ? AND message_order >= ?
        """,
        (roleplayId, messageOrder),
    )


def deleteMessagesAfter(
    conn: sqlite3.Connection, roleplayId: str, messageOrder: int
) -> None:
    conn.execute(
        """
        DELETE FROM roleplay_messages
        WHERE roleplay_id = ? AND message_order > ?
        """,
        (roleplayId, messageOrder),
    )


def insertUserMessage(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO roleplay_messages (
          id, roleplay_id, role, content, reasoning, model, finish_reason,
          error, message_order, created_at
        )
        VALUES (?, ?, 'user', ?, NULL, ?, NULL, NULL, ?, ?)
        """,
        values,
    )


def insertAssistantMessage(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO roleplay_messages (
          id, roleplay_id, role, content, reasoning, sources, model, finish_reason,
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
        INSERT INTO roleplay_messages (
          id, roleplay_id, role, content, reasoning, sources, model, finish_reason,
          error, generation_id, prompt_tokens, completion_tokens,
          reasoning_tokens, cached_tokens, total_tokens, cost, provider_name,
          generation_time, latency, message_order, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def getRoleplayFolder(conn: sqlite3.Connection, folderId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM roleplay_folders WHERE id = ?", (folderId,)
    ).fetchone()


def listRoleplayFolders(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM roleplay_folders ORDER BY created_at ASC"
    ).fetchall()


def countRoleplaysByFolder(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT folder_id, COUNT(*) AS roleplay_count FROM roleplays
        WHERE temporary = 0 AND folder_id IS NOT NULL
        GROUP BY folder_id
        """
    ).fetchall()


def countFolderRoleplays(conn: sqlite3.Connection, folderId: str) -> sqlite3.Row:
    return conn.execute(
        """
        SELECT COUNT(*) AS roleplay_count FROM roleplays
        WHERE folder_id = ? AND temporary = 0
        """,
        (folderId,),
    ).fetchone()


def insertRoleplayFolder(
    conn: sqlite3.Connection, folderId: str, name: str, now: str
) -> None:
    conn.execute(
        """
        INSERT INTO roleplay_folders (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        """,
        (folderId, name, now, now),
    )


def updateRoleplayFolderColumns(
    conn: sqlite3.Connection, assignments: list[str], values: list[Any]
) -> None:
    conn.execute(
        f"UPDATE roleplay_folders SET {', '.join(assignments)} WHERE id = ?", values
    )


def listFolderRoleplayIds(conn: sqlite3.Connection, folderId: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id FROM roleplays WHERE folder_id = ?", (folderId,)
    ).fetchall()


def unsetRoleplayFolder(conn: sqlite3.Connection, folderId: str) -> None:
    conn.execute(
        "UPDATE roleplays SET folder_id = NULL WHERE folder_id = ?", (folderId,)
    )


def deleteRoleplayFolder(conn: sqlite3.Connection, folderId: str) -> None:
    conn.execute("DELETE FROM roleplay_folders WHERE id = ?", (folderId,))
