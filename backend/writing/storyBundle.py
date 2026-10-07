from typing import Any

from backend.core.database import getDb
from backend.lorebook.lorebookQueries import listEntries
from backend.lorebook.lorebookRows import rowToLorebookEntry
from backend.stories.storyQueries import (
    getLatestStoryGeneration,
    listChapterHistory,
    listChapters,
    requireStory,
)
from backend.stories.storyRows import (
    rowToChapter,
    rowToChapterHistoryEntry,
    rowToStory,
    rowToStoryGeneration,
)


def getStoryBundle(story_id: str) -> dict[str, Any]:
    with getDb() as conn:
        story = requireStory(conn, story_id)
        chapters = listChapters(conn, story_id)
        lorebook = listEntries(conn, story_id)
        history_rows = listChapterHistory(conn, story_id)
        latest_generation = getLatestStoryGeneration(conn, story_id)
    history_by_chapter: dict[str, list[dict[str, Any]]] = {}
    for row in history_rows:
        history_by_chapter.setdefault(row["chapter_id"], []).append(
            rowToChapterHistoryEntry(row)
        )
    chapter_payloads = []
    for row in chapters:
        chapter = rowToChapter(row)
        chapter["history"] = history_by_chapter.get(row["id"], [])
        chapter_payloads.append(chapter)

    return {
        "story": rowToStory(story),
        "chapters": chapter_payloads,
        "lorebook": [rowToLorebookEntry(row) for row in lorebook],
        "latest_generation": (
            rowToStoryGeneration(latest_generation) if latest_generation else None
        ),
    }
