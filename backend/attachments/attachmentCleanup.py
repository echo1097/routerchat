from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


def claim_attachments(
    conn: sqlite3.Connection,
    attachmentIds: list[str],
    chat_id: str | None = None,
    message_id: str | None = None,
    story_id: str | None = None,
) -> None:
    if not attachmentIds:
        return

    for attachmentId in attachmentIds:
        conn.execute(
            """
            UPDATE attachments
            SET chat_id = COALESCE(?, chat_id),
                message_id = COALESCE(?, message_id),
                story_id = COALESCE(?, story_id)
            WHERE id = ?
            """,
            (chat_id, message_id, story_id, attachmentId),
        )


def delete_attachment_files(rows: list[sqlite3.Row]) -> None:
    for row in rows:
        try:
            Path(row["stored_path"]).unlink(missing_ok=True)
        except OSError:
            continue


def delete_attachments_for_chat(conn: sqlite3.Connection, chat_id: str) -> None:
    rows = conn.execute(
        "SELECT * FROM attachments WHERE chat_id = ?", (chat_id,)
    ).fetchall()
    delete_attachment_files(rows)
    conn.execute("DELETE FROM attachments WHERE chat_id = ?", (chat_id,))


def delete_attachments_for_story(conn: sqlite3.Connection, story_id: str) -> None:
    rows = conn.execute(
        "SELECT * FROM attachments WHERE story_id = ?", (story_id,)
    ).fetchall()
    delete_attachment_files(rows)
    conn.execute("DELETE FROM attachments WHERE story_id = ?", (story_id,))


def delete_attachments_for_missing_messages(conn: sqlite3.Connection) -> int:
    rows = conn.execute(
        """
        SELECT * FROM attachments
        WHERE message_id IS NOT NULL
          AND message_id NOT IN (SELECT id FROM messages)
        """
    ).fetchall()
    if not rows:
        return 0

    delete_attachment_files(rows)
    conn.execute(
        """
        DELETE FROM attachments
        WHERE message_id IS NOT NULL
          AND message_id NOT IN (SELECT id FROM messages)
        """
    )

    return len(rows)


def delete_orphaned_attachments(
    conn: sqlite3.Connection, olderThanHours: int = 24
) -> int:
    cutoff = (
        datetime.now(timezone.utc) - timedelta(hours=olderThanHours)
    ).isoformat().replace("+00:00", "Z")

    rows = conn.execute(
        """
        SELECT * FROM attachments
        WHERE message_id IS NULL AND story_id IS NULL AND created_at < ?
        """,
        (cutoff,),
    ).fetchall()
    if not rows:
        return 0

    delete_attachment_files(rows)
    conn.execute(
        """
        DELETE FROM attachments
        WHERE message_id IS NULL AND story_id IS NULL AND created_at < ?
        """,
        (cutoff,),
    )

    return len(rows)
