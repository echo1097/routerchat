import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import delete_attachments_for_story
from backend.core.database import get_db
from backend.core.utils import utc_now
from backend.providers.registry import getActiveProvider
from backend.writing.storyBundle import get_story_bundle
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
    request_updates,
    row_to_chapter,
    row_to_story,
    word_count,
)

router = APIRouter()


@router.get("/api/stories")
def list_stories() -> dict[str, Any]:
    with get_db() as conn:
        rows = listStories(conn)
    return {"stories": [row_to_story(row) for row in rows]}


@router.post("/api/stories")
def create_story(payload: StoryCreateRequest) -> dict[str, Any]:
    now = utc_now()
    story_id = str(uuid.uuid4())
    provider = getActiveProvider()
    model = payload.model or provider.defaultModelId()
    with get_db() as conn:
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
    return {"story": row_to_story(row)}


@router.post("/api/stories/with-initial-chapter")
def create_story_with_initial_chapter(
    payload: StoryWithInitialChapterRequest,
) -> dict[str, Any]:
    now = utc_now()
    story_id = str(uuid.uuid4())
    chapter_id = str(uuid.uuid4())
    provider = getActiveProvider()
    model = payload.model or provider.defaultModelId()
    initial_chapter = payload.initial_chapter
    content = initial_chapter.content

    with get_db() as conn:
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
                word_count(content),
                0,
                now,
                now,
            ),
        )
        story = getStory(conn, story_id)
        chapter = getChapterById(conn, chapter_id)

    return {"story": row_to_story(story), "chapter": row_to_chapter(chapter)}


@router.get("/api/stories/{story_id}/chapters/{chapter_id}/generations/{generationId}")
def getGenerationStatus(story_id: str, chapter_id: str, generationId: str) -> dict[str, bool]:
    with get_db() as conn:
        generationRow = getGenerationSettled(conn, story_id, chapter_id, generationId)
    return {"settled": bool(generationRow and generationRow["settled"])}


@router.get("/api/stories/{story_id}")
def get_story(story_id: str) -> dict[str, Any]:
    return get_story_bundle(story_id)


@router.patch("/api/stories/{story_id}")
def update_story(story_id: str, payload: StoryPatchRequest) -> dict[str, Any]:
    updates = request_updates(payload, reject_null=True)
    if not updates:
        return get_story_bundle(story_id)
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
    with get_db() as conn:
        story = requireStory(conn, story_id)
        updateStoryColumns(conn, assignments, values)
    return get_story_bundle(story_id)


@router.delete("/api/stories/{story_id}")
def delete_story(story_id: str) -> dict[str, Any]:
    with get_db() as conn:
        delete_attachments_for_story(conn, story_id)
        result = deleteStory(conn, story_id)
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Story not found.")
    return {"ok": True}


@router.post("/api/stories/{story_id}/close")
def close_story(story_id: str) -> dict[str, Any]:
    with get_db() as conn:
        story = getStoryTemporary(conn, story_id)
    if not story or not bool(story["temporary"]):
        return {"ok": True}
    return delete_story(story_id)
