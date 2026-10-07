from typing import Any

from backend.core.database import get_db
from backend.lorebook.lorebookQueries import listEntries
from backend.lorebook.lorebookRows import row_to_lorebook_entry
from backend.stories.storyQueries import (
    getLatestStoryGeneration,
    listChapterHistory,
    listChapters,
    requireStory,
)
from backend.stories.storyRows import (
    row_to_chapter,
    row_to_chapter_history_entry,
    row_to_story,
    row_to_story_generation,
)


def get_story_bundle(story_id: str) -> dict[str, Any]:
    with get_db() as conn:
        story = requireStory(conn, story_id)
        chapters = listChapters(conn, story_id)
        lorebook = listEntries(conn, story_id)
        history_rows = listChapterHistory(conn, story_id)
        latest_generation = getLatestStoryGeneration(conn, story_id)
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
