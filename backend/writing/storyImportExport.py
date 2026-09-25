import json
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.brainstorm.brainstormRows import (
    row_to_brainstorm_edge,
    row_to_brainstorm_node,
)
from backend.core.database import get_db
from backend.core.utils import utc_now
from backend.lorebook.lorebookRows import (
    normalize_lorebook_category,
    row_to_lorebook_entry,
    sanitize_lorebook_aliases,
    sanitize_lorebook_metadata,
)
from backend.lorebook.timeline import normalize_timeline_description
from backend.providers.openrouter.models import default_model_id
from backend.writing.storyModels import StoryImportRequest
from backend.writing.storyRows import (
    row_to_chapter,
    row_to_chapter_history_entry,
    row_to_story,
    word_count,
)

router = APIRouter()


@router.get("/api/stories/{story_id}/export")
def export_story(story_id: str) -> dict[str, Any]:
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
        historyRows = conn.execute(
            """
            SELECT * FROM chapter_history_entries
            WHERE story_id = ?
            ORDER BY chapter_id ASC, entry_order ASC, created_at ASC
            """,
            (story_id,),
        ).fetchall()
        lorebookRows = conn.execute(
            """
            SELECT * FROM lorebook_entries
            WHERE story_id = ?
            ORDER BY created_at ASC
            """,
            (story_id,),
        ).fetchall()
        brainstormNodes = conn.execute(
            """
            SELECT * FROM brainstorm_nodes
            WHERE story_id = ?
            ORDER BY created_at ASC
            """,
            (story_id,),
        ).fetchall()
        brainstormEdges = conn.execute(
            """
            SELECT * FROM brainstorm_edges
            WHERE story_id = ?
            ORDER BY created_at ASC
            """,
            (story_id,),
        ).fetchall()
        viewport = conn.execute(
            "SELECT * FROM brainstorm_viewports WHERE story_id = ?",
            (story_id,),
        ).fetchone()

    storyPayload = row_to_story(story)
    storyPayload.pop("temporary", None)

    historyPayload = []
    for row in historyRows:
        historyEntry = row_to_chapter_history_entry(row)
        historyEntry.pop("cost", None)
        historyPayload.append(historyEntry)

    nodePayload = []
    for row in brainstormNodes:
        node = row_to_brainstorm_node(row)
        node.pop("reasoning", None)
        node.pop("duration_ms", None)
        nodePayload.append(node)

    return {
        "schema": "routerchat.story.v1",
        "exported_at": utc_now(),
        "story": storyPayload,
        "chapters": [row_to_chapter(row) for row in chapters],
        "chapter_history": historyPayload,
        "lorebook": [row_to_lorebook_entry(row) for row in lorebookRows],
        "brainstorm": {
            "nodes": nodePayload,
            "edges": [row_to_brainstorm_edge(row) for row in brainstormEdges],
            "viewport": (
                {
                    "x": viewport["position_x"],
                    "y": viewport["position_y"],
                    "zoom": viewport["zoom"],
                }
                if viewport
                else {"x": 0, "y": 0, "zoom": 1}
            ),
        },
    }


@router.post("/api/stories/import")
def import_story(payload: StoryImportRequest) -> dict[str, Any]:
    if payload.format_schema != "routerchat.story.v1":
        raise HTTPException(status_code=422, detail="Unsupported RouterChat story format.")

    sourceStoryId = payload.story.id

    def requireUniqueIds(items: list[Any], label: str) -> None:
        itemIds = [item.id for item in items]
        if len(itemIds) != len(set(itemIds)):
            raise HTTPException(status_code=422, detail=f"Story archive has duplicate {label} IDs.")

    requireUniqueIds(payload.chapters, "chapter")
    requireUniqueIds(payload.chapter_history, "chapter history")
    requireUniqueIds(payload.lorebook, "lorebook")
    requireUniqueIds(payload.brainstorm.nodes, "brainstorm node")
    requireUniqueIds(payload.brainstorm.edges, "brainstorm edge")

    storyChildren = [
        *payload.chapters,
        *payload.chapter_history,
        *payload.lorebook,
        *payload.brainstorm.nodes,
        *payload.brainstorm.edges,
    ]
    if any(item.story_id != sourceStoryId for item in storyChildren):
        raise HTTPException(status_code=422, detail="Story archive contains a mismatched story reference.")

    sourceChapterIds = {chapter.id for chapter in payload.chapters}
    if any(entry.chapter_id not in sourceChapterIds for entry in payload.chapter_history):
        raise HTTPException(status_code=422, detail="Story archive history references a missing chapter.")

    sourceNodeIds = {node.id for node in payload.brainstorm.nodes}
    if any(
        edge.source_node_id not in sourceNodeIds or edge.target_node_id not in sourceNodeIds
        for edge in payload.brainstorm.edges
    ):
        raise HTTPException(status_code=422, detail="Story archive contains an orphaned brainstorm edge.")

    now = utc_now()
    storyId = str(uuid.uuid4())
    chapterIdMap = {chapter.id: str(uuid.uuid4()) for chapter in payload.chapters}
    nodeIdMap = {node.id: str(uuid.uuid4()) for node in payload.brainstorm.nodes}
    runIdMap = {
        entry.run_id: str(uuid.uuid4())
        for entry in payload.chapter_history
    }
    orderedChapters = sorted(
        payload.chapters,
        key=lambda chapter: (chapter.order_index, chapter.created_at, chapter.id),
    )

    with get_db() as conn:
        story = payload.story
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
                storyId,
                story.title.strip() or "New story",
                story.author,
                story.language,
                story.synopsis,
                story.model or default_model_id(),
                story.system_prompt,
                story.temperature,
                story.max_tokens,
                int(story.thinking_enabled),
                story.reasoning_effort,
                0,
                int(story.lorebook_auto),
                story.lorebook_model,
                story.created_at or now,
                now,
            ),
        )

        for chapter in orderedChapters:
            chapterId = chapterIdMap[chapter.id]
            conn.execute(
                """
                INSERT INTO chapters (
                  id, story_id, title, content, word_count, revision, order_index,
                  disabled, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chapterId,
                    storyId,
                    chapter.title.strip() or "New chapter",
                    chapter.content,
                    word_count(chapter.content),
                    chapter.revision,
                    chapter.order_index,
                    int(chapter.disabled),
                    chapter.created_at or now,
                    chapter.updated_at or now,
                ),
            )

        for entry in payload.chapter_history:
            conn.execute(
                """
                INSERT INTO chapter_history_entries (
                  id, story_id, chapter_id, run_id, label, detail, entry_order,
                  kind, words_added, words_removed, cost, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    storyId,
                    chapterIdMap[entry.chapter_id],
                    runIdMap[entry.run_id],
                    entry.label,
                    entry.detail,
                    entry.entry_order,
                    entry.kind,
                    entry.words_added,
                    entry.words_removed,
                    None,
                    entry.created_at or now,
                ),
            )

        for entry in payload.lorebook:
            category = normalize_lorebook_category(entry.category)
            name = entry.name.strip()
            description = (
                normalize_timeline_description(entry.description)
                if category == "timeline"
                else entry.description
            )
            conn.execute(
                """
                INSERT INTO lorebook_entries (
                  id, story_id, name, category, description, aliases_json,
                  tags_json, metadata_json, revision, disabled, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    storyId,
                    name,
                    category,
                    description,
                    json.dumps(sanitize_lorebook_aliases(category, entry.aliases, name)),
                    json.dumps(entry.tags),
                    json.dumps(sanitize_lorebook_metadata(category, entry.metadata)),
                    entry.revision,
                    int(entry.disabled),
                    entry.created_at or now,
                    entry.updated_at or now,
                ),
            )

        for node in payload.brainstorm.nodes:
            conn.execute(
                """
                INSERT INTO brainstorm_nodes (
                  id, story_id, node_type, title, content, position_x,
                  position_y, status, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    nodeIdMap[node.id],
                    storyId,
                    node.node_type,
                    node.title,
                    node.content,
                    node.position_x,
                    node.position_y,
                    node.status,
                    node.created_at or now,
                    node.updated_at or now,
                ),
            )

        for edge in payload.brainstorm.edges:
            conn.execute(
                """
                INSERT INTO brainstorm_edges (
                  id, story_id, source_node_id, target_node_id, created_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    storyId,
                    nodeIdMap[edge.source_node_id],
                    nodeIdMap[edge.target_node_id],
                    edge.created_at or now,
                ),
            )

        viewport = payload.brainstorm.viewport
        conn.execute(
            """
            INSERT INTO brainstorm_viewports (
              story_id, position_x, position_y, zoom, updated_at
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (storyId, viewport.x, viewport.y, viewport.zoom, now),
        )

    return {
        "story_id": storyId,
        "first_chapter_id": (
            chapterIdMap[orderedChapters[0].id] if orderedChapters else None
        ),
    }
