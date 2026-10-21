from __future__ import annotations

import sqlite3
from typing import Any

CHARACTER_ORDER_CLAUSE = "character_order ASC, created_at ASC, rowid ASC"


def listCharacters(conn: sqlite3.Connection, roleplayId: str) -> list[sqlite3.Row]:
    return conn.execute(
        f"""
        SELECT * FROM roleplay_characters
        WHERE roleplay_id = ?
        ORDER BY {CHARACTER_ORDER_CLAUSE}
        """,
        (roleplayId,),
    ).fetchall()


def listActiveCharacters(conn: sqlite3.Connection, roleplayId: str) -> list[sqlite3.Row]:
    return conn.execute(
        f"""
        SELECT * FROM roleplay_characters
        WHERE roleplay_id = ? AND disabled = 0
        ORDER BY {CHARACTER_ORDER_CLAUSE}
        """,
        (roleplayId,),
    ).fetchall()


def getCharacter(conn: sqlite3.Connection, characterId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM roleplay_characters WHERE id = ?", (characterId,)
    ).fetchone()


def getRoleplayCharacter(
    conn: sqlite3.Connection, roleplayId: str, characterId: str
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM roleplay_characters WHERE roleplay_id = ? AND id = ?",
        (roleplayId, characterId),
    ).fetchone()


def nextCharacterOrder(conn: sqlite3.Connection, roleplayId: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(character_order), -1) + 1 AS next_order
        FROM roleplay_characters
        WHERE roleplay_id = ?
        """,
        (roleplayId,),
    ).fetchone()
    return int(row["next_order"])


def insertCharacter(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO roleplay_characters (
          id, roleplay_id, name, kind, description, appearance, personality,
          speech_style, greeting, example_dialogue, color, disabled,
          character_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def updateCharacter(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        UPDATE roleplay_characters
        SET name = ?, kind = ?, description = ?, appearance = ?, personality = ?,
            speech_style = ?, greeting = ?, example_dialogue = ?, color = ?,
            disabled = ?, updated_at = ?
        WHERE roleplay_id = ? AND id = ?
        """,
        values,
    )


def deleteCharacter(
    conn: sqlite3.Connection, roleplayId: str, characterId: str
) -> sqlite3.Cursor:
    return conn.execute(
        "DELETE FROM roleplay_characters WHERE roleplay_id = ? AND id = ?",
        (roleplayId, characterId),
    )


def demoteOtherUserCharacters(
    conn: sqlite3.Connection, roleplayId: str, characterId: str, now: str
) -> None:
    conn.execute(
        """
        UPDATE roleplay_characters
        SET kind = 'cast', updated_at = ?
        WHERE roleplay_id = ? AND id != ? AND kind = 'user'
        """,
        (now, roleplayId, characterId),
    )
