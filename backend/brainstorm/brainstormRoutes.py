from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.brainstorm.brainstormModels import (
    BrainstormNodePatchRequest,
    BrainstormViewportRequest,
)
from backend.brainstorm.brainstormQueries import (
    deleteNodes,
    findGeneratingNode,
    getLatestGeneration,
    getNode,
    getStoryNode,
    getViewport,
    listEdgeLinks,
    listEdges,
    listGenerationNotes,
    listNodeIds,
    listNodes,
    saveViewport,
    updateNodeColumns,
    updateNodePositions,
)
from backend.brainstorm.brainstormRows import (
    rowToBrainstormEdge,
    rowToBrainstormNode,
)
from backend.brainstorm.tidyBrainstorm import tidyBrainstormPositions
from backend.core.database import getDb
from backend.core.utils import utcNow
from backend.stories.storyQueries import requireStory


def requestUpdates(payload: BaseModel, reject_null: bool = False) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        updates = payload.model_dump(exclude_unset=True)
    else:
        updates = payload.dict(exclude_unset=True)
    if reject_null:
        nullFields = [key for key, value in updates.items() if value is None]
        if nullFields:
            raise HTTPException(
                status_code=422,
                detail=f"Fields cannot be null: {', '.join(sorted(nullFields))}.",
            )
    return updates


router = APIRouter()


@router.get("/api/stories/{story_id}/brainstorm")
def getBrainstorm(story_id: str) -> dict[str, Any]:
    with getDb() as conn:
        story = requireStory(conn, story_id)
        nodes = listNodes(conn, story_id)
        edges = listEdges(conn, story_id)
        viewport = getViewport(conn, story_id)
        generation_rows = listGenerationNotes(conn, story_id)
        latest_generation = getLatestGeneration(conn, story_id)

    reasoningByPromptId = {
        row["prompt_node_id"]: row["reasoning"]
        for row in generation_rows
        if row["reasoning"]
    }
    durationByPromptId = {
        row["prompt_node_id"]: row["duration_ms"]
        for row in generation_rows
        if row["duration_ms"] is not None
    }
    usage = None
    if latest_generation:
        usage = {
            "generation_id": latest_generation["generation_id"],
            "model": latest_generation["model"],
            "prompt_tokens": latest_generation["prompt_tokens"],
            "completion_tokens": latest_generation["completion_tokens"],
            "reasoning_tokens": latest_generation["reasoning_tokens"],
            "total_tokens": latest_generation["total_tokens"],
            "cost": latest_generation["cost"],
            "provider_name": latest_generation["provider_name"],
            "generation_time": latest_generation["generation_time"],
            "latency": latest_generation["latency"],
        }
    return {
        "nodes": [
            rowToBrainstormNode(
                row,
                reasoningByPromptId.get(row["id"]),
                durationByPromptId.get(row["id"]),
            )
            for row in nodes
        ],
        "edges": [rowToBrainstormEdge(row) for row in edges],
        "viewport": (
            {
                "x": viewport["position_x"],
                "y": viewport["position_y"],
                "zoom": viewport["zoom"],
            }
            if viewport
            else {"x": 0, "y": 0, "zoom": 1}
        ),
        "latest_generation": usage,
    }


@router.patch("/api/stories/{story_id}/brainstorm/nodes/{node_id}")
def updateBrainstormNode(
    story_id: str,
    node_id: str,
    payload: BrainstormNodePatchRequest,
) -> dict[str, Any]:
    updates = requestUpdates(payload, reject_null=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No node changes provided.")

    with getDb() as conn:
        node = getStoryNode(conn, story_id, node_id)
        if not node:
            raise HTTPException(status_code=404, detail="Brainstorm node not found.")
        if node["node_type"] != "idea" and ({"title", "content"} & updates.keys()):
            raise HTTPException(status_code=400, detail="Prompt text cannot be edited.")

        assignments: list[str] = []
        values: list[Any] = []
        for key, value in updates.items():
            if key in {"title", "content"}:
                value = str(value or "").strip()
                if not value:
                    raise HTTPException(status_code=400, detail=f"Node {key} cannot be empty.")
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        values.append(utcNow())
        values.extend([node_id, story_id])
        updateNodeColumns(conn, assignments, values)
        updated = getNode(conn, node_id)
    return {"node": rowToBrainstormNode(updated)}


@router.post("/api/stories/{story_id}/brainstorm/tidy")
def tidyBrainstorm(story_id: str) -> dict[str, Any]:
    with getDb() as conn:
        story = requireStory(conn, story_id)
        generating = findGeneratingNode(conn, story_id)
        if generating:
            raise HTTPException(
                status_code=409,
                detail="Wait for the current brainstorm to finish before tidying.",
            )
        nodes = listNodes(conn, story_id)
        edges = listEdges(conn, story_id)

        positions = tidyBrainstormPositions(nodes, edges)
        updateNodePositions(
            conn,
            [
                (x, y, nodeId, story_id)
                for nodeId, (x, y) in positions.items()
            ],
        )

    return {
        "positions": [
            {"id": nodeId, "position_x": x, "position_y": y}
            for nodeId, (x, y) in positions.items()
        ],
    }


@router.patch("/api/stories/{story_id}/brainstorm/viewport")
def updateBrainstormViewport(
    story_id: str,
    payload: BrainstormViewportRequest,
) -> dict[str, Any]:
    now = utcNow()
    with getDb() as conn:
        story = requireStory(conn, story_id)
        saveViewport(conn, (story_id, payload.position_x, payload.position_y, payload.zoom, now))
    return {"viewport": {"x": payload.position_x, "y": payload.position_y, "zoom": payload.zoom}}


@router.delete("/api/stories/{story_id}/brainstorm/nodes/{node_id}")
def deleteBrainstormNode(
    story_id: str,
    node_id: str,
    cascade: bool = False,
) -> dict[str, Any]:
    with getDb() as conn:
        nodes = listNodeIds(conn, story_id)
        node_ids = {row["id"] for row in nodes}
        if node_id not in node_ids:
            raise HTTPException(status_code=404, detail="Brainstorm node not found.")
        edges = listEdgeLinks(conn, story_id)
        children_by_source: dict[str, list[str]] = {}
        for edge in edges:
            children_by_source.setdefault(edge["source_node_id"], []).append(
                edge["target_node_id"]
            )

        delete_ids = {node_id}
        pending = [node_id]
        while pending:
            current_id = pending.pop()
            for child_id in children_by_source.get(current_id, []):
                if child_id not in delete_ids:
                    delete_ids.add(child_id)
                    pending.append(child_id)

        if len(delete_ids) > 1 and not cascade:
            raise HTTPException(
                status_code=409,
                detail="This node has descendants. Confirm branch deletion first.",
            )
        values = list(delete_ids)
        deleteNodes(conn, story_id, values)
    return {"deleted_node_ids": values}
