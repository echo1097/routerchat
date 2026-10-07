import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import deleteAttachmentsForStory
from backend.core.database import getDb
from backend.core.utils import utcNow
from backend.providers.registry import getActiveProvider
from backend.writing.storyBundle import getStoryBundle
from backend.writing.storyModels import (
    StoryCreateRequest,
    StoryPatchRequest,
    StoryWithInitialChapterRequest,
)
from backend.stories.storyQueries import (
    deleteStory,
    getChapterById,
    getGenerationSettled,
    getStory,
    getStoryTemporary,
    insertChapter,
    insertStory,
    listStories,
    requireStory,
    updateStoryColumns,
)
from backend.stories.storyRows import (
    requestUpdates,
    rowToChapter,
    rowToStory,
    wordCount,
)

router = APIRouter()


@router.get("/api/stories")
def listStoriesRoute() -> dict[str, Any]:
    with getDb() as conn:
        rows = listStories(conn)
    return {"stories": [rowToStory(row) for row in rows]}


@router.post("/api/stories")
def createStory(payload: StoryCreateRequest) -> dict[str, Any]:
    now = utcNow()
    story_id = str(uuid.uuid4())
    provider = getActiveProvider()
    model = payload.model or provider.defaultModelId()
    with getDb() as conn:
        insertStory(
            conn,
            (
                story_id,
                payload.title.strip() or "New story",
                payload.author,
                payload.language,
                payload.synopsis,
                model,
                provider.id,
                payload.system_prompt,
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                int(payload.temporary),
                int(payload.lorebook_auto),
                payload.lorebook_model,
                now,
                now,
            ),
        )
        row = getStory(conn, story_id)
    return {"story": rowToStory(row)}


@router.post("/api/stories/with-initial-chapter")
def createStoryWithInitialChapter(
    payload: StoryWithInitialChapterRequest,
) -> dict[str, Any]:
    now = utcNow()
    story_id = str(uuid.uuid4())
    chapter_id = str(uuid.uuid4())
    provider = getActiveProvider()
    model = payload.model or provider.defaultModelId()
    initial_chapter = payload.initial_chapter
    content = initial_chapter.content

    with getDb() as conn:
        insertStory(
            conn,
            (
                story_id,
                payload.title.strip() or "New story",
                payload.author,
                payload.language,
                payload.synopsis,
                model,
                provider.id,
                payload.system_prompt,
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                int(payload.temporary),
                int(payload.lorebook_auto),
                payload.lorebook_model,
                now,
                now,
            ),
        )
        insertChapter(
            conn,
            (
                chapter_id,
                story_id,
                initial_chapter.title.strip() or "New chapter",
                content,
                wordCount(content),
                0,
                now,
                now,
            ),
        )
        story = getStory(conn, story_id)
        chapter = getChapterById(conn, chapter_id)

    return {"story": rowToStory(story), "chapter": rowToChapter(chapter)}


@router.get("/api/stories/{story_id}/chapters/{chapter_id}/generations/{generationId}")
def getGenerationStatus(story_id: str, chapter_id: str, generationId: str) -> dict[str, bool]:
    with getDb() as conn:
        generationRow = getGenerationSettled(conn, story_id, chapter_id, generationId)
    return {"settled": bool(generationRow and generationRow["settled"])}


@router.get("/api/stories/{story_id}")
def getStoryRoute(story_id: str) -> dict[str, Any]:
    return getStoryBundle(story_id)


@router.patch("/api/stories/{story_id}")
def updateStory(story_id: str, payload: StoryPatchRequest) -> dict[str, Any]:
    updates = requestUpdates(payload, reject_null=True)
    if not updates:
        return getStoryBundle(story_id)
    assignments: list[str] = []
    values: list[Any] = []
    for key, value in updates.items():
        if key in {"thinking_enabled", "lorebook_auto"}:
            value = int(bool(value))
        if key == "title":
            value = str(value).strip() or "New story"
        assignments.append(f"{key} = ?")
        values.append(value)

    #settings, renames and title edits are housekeeping, so they leave updated_at alone
    #and the story keeps its place in the sidebar until someone actually writes in it
    values.append(story_id)
    with getDb() as conn:
        story = requireStory(conn, story_id)
        updateStoryColumns(conn, assignments, values)
    return getStoryBundle(story_id)


@router.delete("/api/stories/{story_id}")
def deleteStoryRoute(story_id: str) -> dict[str, Any]:
    with getDb() as conn:
        deleteAttachmentsForStory(conn, story_id)
        result = deleteStory(conn, story_id)
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Story not found.")
    return {"ok": True}


@router.post("/api/stories/{story_id}/close")
def closeStory(story_id: str) -> dict[str, Any]:
    with getDb() as conn:
        story = getStoryTemporary(conn, story_id)
    if not story or not bool(story["temporary"]):
        return {"ok": True}
    return deleteStoryRoute(story_id)
