import sqlite3
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.attachments.attachmentCleanup import claim_attachments
from backend.chats.chatModels import StreamMessageRequest
from backend.chats.systemPrompts import writeSystemPrompt
from backend.core.database import get_db
from backend.core.utils import utc_now
from backend.lorebook.chapterSummaries import (
    delete_linked_chapter_summaries,
    rename_linked_chapter_summaries,
)
from backend.providers.openrouter.apiKey import read_openrouter_key
from backend.writing.storyGeneration import (
    ChapterStreamingResponse,
    stream_story_generation,
)
from backend.writing.storyModels import (
    ChapterContentRequest,
    ChapterCreateRequest,
    ChapterPatchRequest,
)
from backend.writing.storyRows import (
    next_chapter_order,
    request_updates,
    row_to_chapter,
    row_to_chapter_history_entry,
    word_count,
)

router = APIRouter()


@router.get("/api/stories/{story_id}/chapters")
def list_chapters(story_id: str) -> dict[str, Any]:
    with get_db() as conn:
        story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        rows = conn.execute(
            """
            SELECT * FROM chapters
            WHERE story_id = ?
            ORDER BY order_index ASC, created_at ASC
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
    history_by_chapter: dict[str, list[dict[str, Any]]] = {}
    for row in history_rows:
        history_by_chapter.setdefault(row["chapter_id"], []).append(
            row_to_chapter_history_entry(row)
        )
    chapters = []
    for row in rows:
        chapter = row_to_chapter(row)
        chapter["history"] = history_by_chapter.get(row["id"], [])
        chapters.append(chapter)
    return {"chapters": chapters}


@router.post("/api/stories/{story_id}/chapters")
def create_chapter(story_id: str, payload: ChapterCreateRequest) -> dict[str, Any]:
    now = utc_now()
    chapter_id = str(uuid.uuid4())
    content = payload.content
    with get_db() as conn:
        story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
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
                payload.title.strip() or "New chapter",
                content,
                word_count(content),
                next_chapter_order(conn, story_id),
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
    return {"chapter": row_to_chapter(row)}


@router.patch("/api/stories/{story_id}/chapters/{chapter_id}")
def update_chapter(
    story_id: str, chapter_id: str, payload: ChapterPatchRequest
) -> dict[str, Any]:
    updates = request_updates(payload, reject_null=True)
    base_revision = updates.pop("revision", None)
    if "content" in updates:
        updates["word_count"] = word_count(updates["content"])
    if "title" in updates:
        updates["title"] = str(updates["title"]).strip() or "New chapter"
    if not updates:
        with get_db() as conn:
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
        if not chapter:
            raise HTTPException(status_code=404, detail="Chapter not found.")
        return {"chapter": row_to_chapter(chapter)}
    assignments: list[str] = []
    values: list[Any] = []
    for key, value in updates.items():
        assignments.append(f"{key} = ?")
        values.append(value)
    assignments.append("updated_at = ?")
    now = utc_now()
    values.append(now)
    content_changed = "content" in updates
    with get_db() as conn:
        chapter = conn.execute(
            "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
            (chapter_id, story_id),
        ).fetchone()
        if not chapter:
            raise HTTPException(status_code=404, detail="Chapter not found.")
        if base_revision is None:
            values.extend([chapter_id, story_id])
            conn.execute(
                f"""
                UPDATE chapters
                SET {', '.join(assignments)}, revision = revision + 1
                WHERE id = ? AND story_id = ?
                """,
                values,
            )
        else:
            values.extend([chapter_id, story_id, base_revision])
            result = conn.execute(
                f"""
                UPDATE chapters
                SET {', '.join(assignments)}, revision = revision + 1
                WHERE id = ? AND story_id = ? AND revision = ?
                """,
                values,
            )
            if result.rowcount == 0:
                current = conn.execute(
                    "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                    (chapter_id, story_id),
                ).fetchone()
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "chapter_revision_conflict",
                        "message": "Chapter changed on the server.",
                        "chapter": row_to_chapter(current),
                    },
                )
        if content_changed:
            conn.execute(
                "UPDATE stories SET updated_at = ? WHERE id = ?",
                (now, story_id),
            )
        if "title" in updates:
            rename_linked_chapter_summaries(
                conn, story_id, chapter_id, updates["title"], now
            )
        row = conn.execute(
            "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
            (chapter_id, story_id),
        ).fetchone()
    return {"chapter": row_to_chapter(row)}


@router.patch("/api/stories/{story_id}/chapters/{chapter_id}/content")
def save_chapter_content(
    story_id: str, chapter_id: str, payload: ChapterContentRequest
) -> dict[str, Any]:
    return update_chapter(
        story_id,
        chapter_id,
        ChapterPatchRequest(content=payload.content, revision=payload.revision),
    )


@router.delete("/api/stories/{story_id}/chapters/{chapter_id}")
def delete_chapter(story_id: str, chapter_id: str) -> dict[str, Any]:
    with get_db() as conn:
        result = conn.execute(
            "DELETE FROM chapters WHERE id = ? AND story_id = ?",
            (chapter_id, story_id),
        )
        if result.rowcount:
            delete_linked_chapter_summaries(conn, story_id, chapter_id)
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Chapter not found.")
    return {"ok": True}


@router.post("/api/stories/{story_id}/chapters/{chapter_id}/generate/stream")
async def stream_story_chapter_generation(
    story_id: str,
    chapter_id: str,
    payload: StreamMessageRequest,
) -> StreamingResponse:
    if not read_openrouter_key():
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
    attachmentIds = list(payload.attachment_ids or [])
    if not payload.message.strip() and not attachmentIds:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    with get_db() as conn:
        story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        chapter = conn.execute(
            "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
            (chapter_id, story_id),
        ).fetchone()
        if not chapter:
            raise HTTPException(status_code=404, detail="Chapter not found.")
        base_revision = payload.chapter_revision
        if base_revision is None:
            raise HTTPException(status_code=422, detail="chapter_revision is required.")
        if base_revision != chapter["revision"]:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "chapter_revision_conflict",
                    "message": "Chapter changed on the server.",
                    "chapter": row_to_chapter(chapter),
                },
            )
        lorebook_rows = conn.execute(
            "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY created_at ASC",
            (story_id,),
        ).fetchall()
        orderedChapters = conn.execute(
            "SELECT * FROM chapters WHERE story_id = ? ORDER BY order_index ASC, created_at ASC",
            (story_id,),
        ).fetchall()
        previousChapters: list[sqlite3.Row] = []
        for row in orderedChapters:
            if row["id"] == chapter_id:
                break
            previousChapters.append(row)

        conn.execute(
            """
            UPDATE stories
            SET model = ?, system_prompt = ?, temperature = ?, max_tokens = ?,
                thinking_enabled = ?, reasoning_effort = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                payload.model,
                writeSystemPrompt(payload),
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                utc_now(),
                story_id,
            ),
        )
        claim_attachments(conn, attachmentIds, story_id=story_id)

        generationId = payload.generation_status_id or str(uuid.uuid4())
        try:
            conn.execute(
                """
                INSERT INTO story_generations (
                    id, story_id, chapter_id, prompt, generated_text, model, error, created_at
                ) VALUES (?, ?, ?, ?, '', ?, 'generation_pending', ?)
                """,
                (generationId, story_id, chapter_id, payload.message, payload.model, utc_now()),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="Generation status ID is already in use.") from exc

    def settleUnstartedGeneration():
        with get_db() as conn:
            conn.execute(
                """
                UPDATE story_generations SET settled = 1, error = 'generation_cancelled'
                WHERE id = ? AND error = 'generation_pending' AND settled = 0
                """,
                (generationId,),
            )

    return ChapterStreamingResponse(
        stream_story_generation(
            story_id,
            chapter_id,
            payload,
            story,
            chapter,
            lorebook_rows,
            base_revision,
            generationId,
            previousChapters,
        ),
        onClose=settleUnstartedGeneration,
        media_type="application/x-ndjson; charset=utf-8",
    )
