from __future__ import annotations

import sqlite3

from backend.core import paths


def get_db() -> sqlite3.Connection:
    paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(paths.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def next_message_order(conn: sqlite3.Connection, chat_id: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(message_order), -1) + 1 AS next_order
        FROM messages
        WHERE chat_id = ?
        """,
        (chat_id,),
    ).fetchone()
    return int(row["next_order"])


def message_order_clause() -> str:
    return "message_order ASC, created_at ASC, rowid ASC"
