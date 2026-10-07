import sqlite3

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
