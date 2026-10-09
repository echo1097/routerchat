import json
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.brainstorm.brainstormQueries import (
    getViewport,
    insertEdge,
    insertImportedNode,
    insertViewport,
    listEdges,
    listNodes,
)
from backend.brainstorm.brainstormRows import (
    rowToBrainstormEdge,
    rowToBrainstormNode,
)
from backend.core.database import getDb
from backend.core.utils import utcNow
from backend.lorebook.lorebookQueries import insertImportedEntry, listEntriesByCreated
from backend.lorebook.lorebookRows import (
    normalizeLorebookCategory,
    rowToLorebookEntry,
    sanitizeLorebookAliases,
    sanitizeLorebookMetadata,
)
from backend.lorebook.timeline import normalizeTimelineDescription
from backend.providers.registry import getActiveProvider, providerIdForImport
from backend.writing.storyModels import StoryImportRequest
from backend.stories.storyQueries import (
    insertChapterHistory,
    insertImportedChapter,
    insertStory,
    listChapterHistoryForExport,
    listChapters,
    requireStory,
)
from backend.stories.storyRows import (
    rowToChapter,
    rowToChapterHistoryEntry,
    rowToStory,
    wordCount,
)

router = APIRouter()


@router.get("/api/stories/{story_id}/export")
def exportStory(story_id: str) -> dict[str, Any]:
    with getDb() as conn:
        story = requireStory(conn, story_id)

        chapters = listChapters(conn, story_id)
        historyRows = listChapterHistoryForExport(conn, story_id)
        lorebookRows = listEntriesByCreated(conn, story_id)
        brainstormNodes = listNodes(conn, story_id)
        brainstormEdges = listEdges(conn, story_id)
        viewport = getViewport(conn, story_id)

    storyPayload = rowToStory(story)
    storyPayload.pop("temporary", None)

    historyPayload = []
    for row in historyRows:
        historyEntry = rowToChapterHistoryEntry(row)
        historyEntry.pop("cost", None)
        historyPayload.append(historyEntry)

    nodePayload = []
    for row in brainstormNodes:
        node = rowToBrainstormNode(row)
        node.pop("reasoning", None)
        node.pop("duration_ms", None)
        nodePayload.append(node)

    return {
        "schema": "routerchat.story.v1",
        "exported_at": utcNow(),
        "story": storyPayload,
        "chapters": [rowToChapter(row) for row in chapters],
        "chapter_history": historyPayload,
        "lorebook": [rowToLorebookEntry(row) for row in lorebookRows],
        "brainstorm": {
            "nodes": nodePayload,
            "edges": [rowToBrainstormEdge(row) for row in brainstormEdges],
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
def importStory(payload: StoryImportRequest) -> dict[str, Any]:
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

    now = utcNow()
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

    with getDb() as conn:
        story = payload.story
        storyModel = story.model or ""
        storyProvider = providerIdForImport(story.provider, storyModel)
        if not storyModel:
            storyModel = getActiveProvider().defaultModelId()
            storyProvider = getActiveProvider().id

        insertStory(
            conn,
            (
                storyId,
                story.title.strip() or "New story",
                story.author,
                story.language,
                story.synopsis,
                storyModel,
                storyProvider,
                story.system_prompt,
                story.temperature,
                story.max_tokens,
                int(story.thinking_enabled),
                story.reasoning_effort,
                0,
                int(story.lorebook_auto),
                story.lorebook_model,
                int(story.lorebook_retry),
                story.created_at or now,
                now,
            ),
        )

        for chapter in orderedChapters:
            chapterId = chapterIdMap[chapter.id]
            insertImportedChapter(
                conn,
                (
                    chapterId,
                    storyId,
                    chapter.title.strip() or "New chapter",
                    chapter.content,
                    wordCount(chapter.content),
                    chapter.revision,
                    chapter.order_index,
                    int(chapter.disabled),
                    chapter.created_at or now,
                    chapter.updated_at or now,
                ),
            )

        for entry in payload.chapter_history:
            insertChapterHistory(
                conn,
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
            category = normalizeLorebookCategory(entry.category)
            name = entry.name.strip()
            description = (
                normalizeTimelineDescription(entry.description)
                if category == "timeline"
                else entry.description
            )
            insertImportedEntry(
                conn,
                (
                    str(uuid.uuid4()),
                    storyId,
                    name,
                    category,
                    description,
                    json.dumps(sanitizeLorebookAliases(category, entry.aliases, name)),
                    json.dumps(entry.tags),
                    json.dumps(sanitizeLorebookMetadata(category, entry.metadata)),
                    entry.revision,
                    int(entry.disabled),
                    entry.created_at or now,
                    entry.updated_at or now,
                ),
            )

        for node in payload.brainstorm.nodes:
            insertImportedNode(
                conn,
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
            insertEdge(
                conn,
                str(uuid.uuid4()),
                storyId,
                nodeIdMap[edge.source_node_id],
                nodeIdMap[edge.target_node_id],
                edge.created_at or now,
            )

        viewport = payload.brainstorm.viewport
        insertViewport(conn, (storyId, viewport.x, viewport.y, viewport.zoom, now))

    return {
        "story_id": storyId,
        "first_chapter_id": (
            chapterIdMap[orderedChapters[0].id] if orderedChapters else None
        ),
    }
