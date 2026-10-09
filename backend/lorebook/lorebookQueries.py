import sqlite3
from typing import Any


def listEntries(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM lorebook_entries
        WHERE story_id = ?
        ORDER BY updated_at DESC, created_at DESC
        """,
        (storyId,),
    ).fetchall()


def listEntriesByUpdated(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY updated_at DESC",
        (storyId,),
    ).fetchall()


def listEntriesByCreated(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY created_at ASC",
        (storyId,),
    ).fetchall()


def listEnabledEntries(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM lorebook_entries
        WHERE story_id = ? AND disabled = 0
        ORDER BY updated_at DESC, created_at DESC
        """,
        (storyId,),
    ).fetchall()


def getTimelineEntry(conn: sqlite3.Connection, storyId: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM lorebook_entries
        WHERE story_id = ?
          AND disabled = 0
          AND (category = 'timeline' OR lower(name) = lower('Timeline'))
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
        """,
        (storyId,),
    ).fetchone()


def getEntry(conn: sqlite3.Connection, entryId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM lorebook_entries WHERE id = ?",
        (entryId,),
    ).fetchone()


def getStoryEntry(conn: sqlite3.Connection, storyId: str, entryId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM lorebook_entries WHERE id = ? AND story_id = ?",
        (entryId, storyId),
    ).fetchone()


def insertEntry(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO lorebook_entries (
          id, story_id, name, category, description, aliases_json,
          tags_json, metadata_json, disabled, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def insertImportedEntry(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO lorebook_entries (
          id, story_id, name, category, description, aliases_json,
          tags_json, metadata_json, revision, disabled, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def refreshSummaryEntry(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        UPDATE lorebook_entries
        SET name = ?, description = ?, aliases_json = '[]', tags_json = '[]',
            metadata_json = ?, disabled = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
        """,
        values,
    )


def updateEntryAtRevision(conn: sqlite3.Connection, values: tuple[Any, ...]) -> sqlite3.Cursor:
    return conn.execute(
        """
        UPDATE lorebook_entries
        SET name = ?, category = ?, description = ?, aliases_json = ?,
            tags_json = ?, metadata_json = ?, disabled = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND story_id = ? AND (? IS NULL OR revision = ?)
        """,
        values,
    )


def deleteStoryEntry(conn: sqlite3.Connection, storyId: str, entryId: str) -> sqlite3.Cursor:
    return conn.execute(
        "DELETE FROM lorebook_entries WHERE id = ? AND story_id = ?",
        (entryId, storyId),
    )


def insertUpdateRun(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO lorebook_update_runs (
          id, story_id, chapter_id, generation_id, openrouter_generation_id,
          raw_output, applied_updates_json, rejected_updates_json, cost, error, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def getChapterSnapshot(conn: sqlite3.Connection, chapterId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM lorebook_chapter_snapshots WHERE chapter_id = ?",
        (chapterId,),
    ).fetchone()


def saveChapterSnapshot(
    conn: sqlite3.Connection,
    storyId: str,
    chapterId: str,
    content: str,
    chapterRevision: int,
    now: str,
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO lorebook_chapter_snapshots (
          chapter_id, story_id, content, chapter_revision, updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        (chapterId, storyId, content, chapterRevision, now),
    )


def deleteStorySnapshots(conn: sqlite3.Connection, storyId: str) -> None:
    conn.execute("DELETE FROM lorebook_chapter_snapshots WHERE story_id = ?", (storyId,))
