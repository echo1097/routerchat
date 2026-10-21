from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend.attachments.attachmentScope import CHAT_SCOPE, AttachmentScope


def claimAttachments(
    conn: sqlite3.Connection,
    attachmentIds: list[str],
    chat_id: str | None = None,
    message_id: str | None = None,
    story_id: str | None = None,
    roleplay_id: str | None = None,
) -> None:
    if not attachmentIds:
        return

    for attachmentId in attachmentIds:
        conn.execute(
            """
            UPDATE attachments
            SET chat_id = COALESCE(?, chat_id),
                message_id = COALESCE(?, message_id),
                story_id = COALESCE(?, story_id),
                roleplay_id = COALESCE(?, roleplay_id)
            WHERE id = ?
            """,
            (chat_id, message_id, story_id, roleplay_id, attachmentId),
        )


def deleteAttachmentFiles(rows: list[sqlite3.Row]) -> None:
    for row in rows:
        try:
            Path(row["stored_path"]).unlink(missing_ok=True)
        except OSError:
            continue


def deleteAttachmentsForChat(conn: sqlite3.Connection, chat_id: str) -> None:
    rows = conn.execute(
        "SELECT * FROM attachments WHERE chat_id = ?", (chat_id,)
    ).fetchall()
    deleteAttachmentFiles(rows)
    conn.execute("DELETE FROM attachments WHERE chat_id = ?", (chat_id,))


def deleteAttachmentsForStory(conn: sqlite3.Connection, story_id: str) -> None:
    rows = conn.execute(
        "SELECT * FROM attachments WHERE story_id = ?", (story_id,)
    ).fetchall()
    deleteAttachmentFiles(rows)
    conn.execute("DELETE FROM attachments WHERE story_id = ?", (story_id,))


def deleteAttachmentsForRoleplay(conn: sqlite3.Connection, roleplay_id: str) -> None:
    rows = conn.execute(
        "SELECT * FROM attachments WHERE roleplay_id = ?", (roleplay_id,)
    ).fetchall()
    deleteAttachmentFiles(rows)
    conn.execute("DELETE FROM attachments WHERE roleplay_id = ?", (roleplay_id,))


def deleteAttachmentsForMissingMessages(
    conn: sqlite3.Connection, scope: AttachmentScope = CHAT_SCOPE
) -> int:
    #the other mode's attachments point at rows this table has never heard of, so they are skipped
    #rather than treated as orphans
    condition = f"""
        message_id IS NOT NULL
          AND {scope.conversationColumn} IS NOT NULL
          AND message_id NOT IN (SELECT id FROM {scope.messagesTable})
    """

    rows = conn.execute(f"SELECT * FROM attachments WHERE {condition}").fetchall()
    if not rows:
        return 0

    deleteAttachmentFiles(rows)
    conn.execute(f"DELETE FROM attachments WHERE {condition}")

    return len(rows)


def deleteOrphanedAttachments(
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

    deleteAttachmentFiles(rows)
    conn.execute(
        """
        DELETE FROM attachments
        WHERE message_id IS NULL AND story_id IS NULL AND created_at < ?
        """,
        (cutoff,),
    )

    return len(rows)
