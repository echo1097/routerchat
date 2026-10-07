import sqlite3
from typing import Any

from fastapi import HTTPException


def getStory(conn: sqlite3.Connection, storyId: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM stories WHERE id = ?", (storyId,)).fetchone()


def requireStory(conn: sqlite3.Connection, storyId: str) -> sqlite3.Row:
    story = getStory(conn, storyId)
    if not story:
        raise HTTPException(status_code=404, detail="Story not found.")
    return story


def getChapter(conn: sqlite3.Connection, storyId: str, chapterId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
        (chapterId, storyId),
    ).fetchone()


def requireChapter(conn: sqlite3.Connection, storyId: str, chapterId: str) -> sqlite3.Row:
    chapter = getChapter(conn, storyId, chapterId)
    if not chapter:
        raise HTTPException(status_code=404, detail="Chapter not found.")
    return chapter


def listStories(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM stories WHERE temporary = 0 ORDER BY updated_at DESC, created_at DESC"
    ).fetchall()


def insertStory(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO stories (
          id, title, author, language, synopsis, model, provider, system_prompt,
          temperature, max_tokens, thinking_enabled, reasoning_effort, temporary,
          lorebook_auto, lorebook_model, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def updateStoryColumns(conn: sqlite3.Connection, assignments: list[str], values: list[Any]) -> None:
    conn.execute(f"UPDATE stories SET {', '.join(assignments)} WHERE id = ?", values)


def touchStory(conn: sqlite3.Connection, storyId: str, now: str) -> None:
    conn.execute(
        "UPDATE stories SET updated_at = ? WHERE id = ?",
        (now, storyId),
    )


def moveStoryProvider(conn: sqlite3.Connection, storyId: str, providerId: str, modelId: str) -> None:
    conn.execute(
        "UPDATE stories SET provider = ?, model = ?, lorebook_model = '' WHERE id = ?",
        (providerId, modelId, storyId),
    )


def updateStoryWriteSettings(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        UPDATE stories
        SET model = ?, system_prompt = ?, temperature = ?, max_tokens = ?,
            thinking_enabled = ?, reasoning_effort = ?, updated_at = ?
        WHERE id = ?
        """,
        values,
    )


def updateStoryBrainstormSettings(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        UPDATE stories SET model = ?, temperature = ?, max_tokens = ?,
          thinking_enabled = ?, reasoning_effort = ?, updated_at = ?
        WHERE id = ?
        """,
        values,
    )


def getStoryTemporary(conn: sqlite3.Connection, storyId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT temporary FROM stories WHERE id = ?", (storyId,)
    ).fetchone()


def getStoryLorebookAuto(conn: sqlite3.Connection, storyId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT lorebook_auto FROM stories WHERE id = ?", (storyId,)
    ).fetchone()


def deleteStory(conn: sqlite3.Connection, storyId: str) -> sqlite3.Cursor:
    conn.execute("DELETE FROM brainstorm_generations WHERE story_id = ?", (storyId,))
    conn.execute("DELETE FROM brainstorm_edges WHERE story_id = ?", (storyId,))
    conn.execute("DELETE FROM brainstorm_nodes WHERE story_id = ?", (storyId,))
    conn.execute("DELETE FROM brainstorm_viewports WHERE story_id = ?", (storyId,))
    conn.execute("DELETE FROM lorebook_update_runs WHERE story_id = ?", (storyId,))
    conn.execute("DELETE FROM story_generations WHERE story_id = ?", (storyId,))
    conn.execute("DELETE FROM lorebook_entries WHERE story_id = ?", (storyId,))
    conn.execute("DELETE FROM chapters WHERE story_id = ?", (storyId,))
    return conn.execute("DELETE FROM stories WHERE id = ?", (storyId,))


def getChapterById(conn: sqlite3.Connection, chapterId: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM chapters WHERE id = ?", (chapterId,)).fetchone()


def listChapters(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM chapters
        WHERE story_id = ?
        ORDER BY order_index ASC, created_at ASC
        """,
        (storyId,),
    ).fetchall()


def listEnabledChapters(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM chapters WHERE story_id = ? AND disabled = 0 ORDER BY order_index ASC, created_at ASC",
        (storyId,),
    ).fetchall()


def getEnabledChapter(conn: sqlite3.Connection, storyId: str, chapterId: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM chapters
        WHERE id = ? AND story_id = ? AND disabled = 0
        """,
        (chapterId, storyId),
    ).fetchone()


def listHiddenChapterIds(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id FROM chapters WHERE story_id = ? AND disabled = 1",
        (storyId,),
    ).fetchall()


def insertChapter(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO chapters (
          id, story_id, title, content, word_count, order_index, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def insertImportedChapter(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO chapters (
          id, story_id, title, content, word_count, revision, order_index,
          disabled, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def updateChapterColumns(conn: sqlite3.Connection, assignments: list[str], values: list[Any]) -> None:
    conn.execute(
        f"""
        UPDATE chapters
        SET {', '.join(assignments)}, revision = revision + 1
        WHERE id = ? AND story_id = ?
        """,
        values,
    )


def updateChapterColumnsAtRevision(
    conn: sqlite3.Connection, assignments: list[str], values: list[Any]
) -> sqlite3.Cursor:
    return conn.execute(
        f"""
        UPDATE chapters
        SET {', '.join(assignments)}, revision = revision + 1
        WHERE id = ? AND story_id = ? AND revision = ?
        """,
        values,
    )


def deleteChapter(conn: sqlite3.Connection, storyId: str, chapterId: str) -> sqlite3.Cursor:
    return conn.execute(
        "DELETE FROM chapters WHERE id = ? AND story_id = ?",
        (chapterId, storyId),
    )


def listChapterHistory(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM chapter_history_entries
        WHERE story_id = ?
        ORDER BY entry_order ASC, created_at ASC
        """,
        (storyId,),
    ).fetchall()


def listChapterHistoryForExport(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM chapter_history_entries
        WHERE story_id = ?
        ORDER BY chapter_id ASC, entry_order ASC, created_at ASC
        """,
        (storyId,),
    ).fetchall()


def insertChapterHistory(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO chapter_history_entries (
          id, story_id, chapter_id, run_id, label, detail, entry_order,
          kind, words_added, words_removed, cost, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def getGenerationSettled(
    conn: sqlite3.Connection, storyId: str, chapterId: str, generationId: str
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT settled FROM story_generations WHERE id = ? AND story_id = ? AND chapter_id = ?",
        (generationId, storyId, chapterId),
    ).fetchone()


def getLatestStoryGeneration(conn: sqlite3.Connection, storyId: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM story_generations
        WHERE story_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (storyId,),
    ).fetchone()


def insertPendingGeneration(
    conn: sqlite3.Connection,
    generationId: str,
    storyId: str,
    chapterId: str,
    prompt: str,
    model: str,
    createdAt: str,
) -> None:
    conn.execute(
        """
        INSERT INTO story_generations (
            id, story_id, chapter_id, prompt, generated_text, model, error, created_at
        ) VALUES (?, ?, ?, ?, '', ?, 'generation_pending', ?)
        """,
        (generationId, storyId, chapterId, prompt, model, createdAt),
    )


def cancelPendingGeneration(conn: sqlite3.Connection, generationId: str) -> None:
    conn.execute(
        """
        UPDATE story_generations SET settled = 1, error = 'generation_cancelled'
        WHERE id = ? AND error = 'generation_pending' AND settled = 0
        """,
        (generationId,),
    )


def settleGeneration(conn: sqlite3.Connection, generationId: str) -> None:
    conn.execute(
        "UPDATE story_generations SET settled = 1 WHERE id = ?",
        (generationId,),
    )
