from typing import Any

from fastapi import HTTPException

from backend.core.database import get_db
from backend.lorebook.lorebookRows import row_to_lorebook_entry
from backend.writing.storyRows import (
    row_to_chapter,
    row_to_chapter_history_entry,
    row_to_story,
    row_to_story_generation,
)


def get_story_bundle(story_id: str) -> dict[str, Any]:
    with get_db() as conn:
        story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        chapters = conn.execute(
            """
            SELECT * FROM chapters
            WHERE story_id = ?
            ORDER BY order_index ASC, created_at ASC
            """,
            (story_id,),
        ).fetchall()
        lorebook = conn.execute(
            """
            SELECT * FROM lorebook_entries
            WHERE story_id = ?
            ORDER BY updated_at DESC, created_at DESC
            """,
            (story_id,),
        ).fetchall()
        history_rows = conn.execute(
            """
            SELECT * FROM chapter_history_entries
            WHERE story_id = ?
            ORDER BY entry_order ASC, created_at ASC
            """,
            (story_id,),
        ).fetchall()
        latest_generation = conn.execute(
            """
            SELECT * FROM story_generations
            WHERE story_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (story_id,),
        ).fetchone()
    history_by_chapter: dict[str, list[dict[str, Any]]] = {}
    for row in history_rows:
        history_by_chapter.setdefault(row["chapter_id"], []).append(
            row_to_chapter_history_entry(row)
        )
    chapter_payloads = []
    for row in chapters:
        chapter = row_to_chapter(row)
        chapter["history"] = history_by_chapter.get(row["id"], [])
        chapter_payloads.append(chapter)

    return {
        "story": row_to_story(story),
        "chapters": chapter_payloads,
        "lorebook": [row_to_lorebook_entry(row) for row in lorebook],
        "latest_generation": (
            row_to_story_generation(latest_generation) if latest_generation else None
        ),
    }
