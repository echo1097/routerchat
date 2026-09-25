import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.attachments.attachmentCleanup import delete_attachments_for_story
from backend.core.database import get_db
from backend.core.utils import utc_now
from backend.providers.openrouter.models import default_model_id
from backend.writing.storyBundle import get_story_bundle
from backend.writing.storyModels import (
    StoryCreateRequest,
    StoryPatchRequest,
    StoryWithInitialChapterRequest,
)
from backend.writing.storyRows import (
    request_updates,
    row_to_chapter,
    row_to_story,
    word_count,
)

router = APIRouter()


@router.get("/api/stories")
def list_stories() -> dict[str, Any]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM stories WHERE temporary = 0 ORDER BY updated_at DESC, created_at DESC"
        ).fetchall()
    return {"stories": [row_to_story(row) for row in rows]}


@router.post("/api/stories")
def create_story(payload: StoryCreateRequest) -> dict[str, Any]:
    now = utc_now()
    story_id = str(uuid.uuid4())
    model = payload.model or default_model_id()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO stories (
              id, title, author, language, synopsis, model, system_prompt,
              temperature, max_tokens, thinking_enabled, reasoning_effort, temporary,
              lorebook_auto, lorebook_model, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                story_id,
                payload.title.strip() or "New story",
                payload.author,
                payload.language,
                payload.synopsis,
                model,
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
        row = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
    return {"story": row_to_story(row)}


@router.post("/api/stories/with-initial-chapter")
def create_story_with_initial_chapter(
    payload: StoryWithInitialChapterRequest,
) -> dict[str, Any]:
    now = utc_now()
    story_id = str(uuid.uuid4())
    chapter_id = str(uuid.uuid4())
    model = payload.model or default_model_id()
    initial_chapter = payload.initial_chapter
    content = initial_chapter.content

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO stories (
              id, title, author, language, synopsis, model, system_prompt,
              temperature, max_tokens, thinking_enabled, reasoning_effort, temporary,
              lorebook_auto, lorebook_model, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                story_id,
                payload.title.strip() or "New story",
                payload.author,
                payload.language,
                payload.synopsis,
                model,
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
        conn.execute(
            """
            INSERT INTO chapters (
              id, story_id, title, content, word_count, order_index, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
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
        story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        chapter = conn.execute(
            "SELECT * FROM chapters WHERE id = ?", (chapter_id,)
        ).fetchone()

    return {"story": row_to_story(story), "chapter": row_to_chapter(chapter)}


@router.get("/api/stories/{story_id}/chapters/{chapter_id}/generations/{generationId}")
def getGenerationStatus(story_id: str, chapter_id: str, generationId: str) -> dict[str, bool]:
    with get_db() as conn:
        generationRow = conn.execute(
            "SELECT settled FROM story_generations WHERE id = ? AND story_id = ? AND chapter_id = ?",
            (generationId, story_id, chapter_id),
        ).fetchone()
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
        story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        conn.execute(f"UPDATE stories SET {', '.join(assignments)} WHERE id = ?", values)
    return get_story_bundle(story_id)


@router.delete("/api/stories/{story_id}")
def delete_story(story_id: str) -> dict[str, Any]:
    with get_db() as conn:
        delete_attachments_for_story(conn, story_id)
        conn.execute("DELETE FROM brainstorm_generations WHERE story_id = ?", (story_id,))
        conn.execute("DELETE FROM brainstorm_edges WHERE story_id = ?", (story_id,))
        conn.execute("DELETE FROM brainstorm_nodes WHERE story_id = ?", (story_id,))
        conn.execute("DELETE FROM brainstorm_viewports WHERE story_id = ?", (story_id,))
        conn.execute("DELETE FROM lorebook_update_runs WHERE story_id = ?", (story_id,))
        conn.execute("DELETE FROM story_generations WHERE story_id = ?", (story_id,))
        conn.execute("DELETE FROM lorebook_entries WHERE story_id = ?", (story_id,))
        conn.execute("DELETE FROM chapters WHERE story_id = ?", (story_id,))
        result = conn.execute("DELETE FROM stories WHERE id = ?", (story_id,))
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Story not found.")
    return {"ok": True}


@router.post("/api/stories/{story_id}/close")
def close_story(story_id: str) -> dict[str, Any]:
    with get_db() as conn:
        story = conn.execute(
            "SELECT temporary FROM stories WHERE id = ?", (story_id,)
        ).fetchone()
    if not story or not bool(story["temporary"]):
        return {"ok": True}
    return delete_story(story_id)
