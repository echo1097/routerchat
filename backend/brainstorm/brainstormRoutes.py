from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.brainstorm.brainstormModels import (
    BrainstormNodePatchRequest,
    BrainstormViewportRequest,
)
from backend.brainstorm.brainstormRows import (
    row_to_brainstorm_edge,
    row_to_brainstorm_node,
)
from backend.core.database import get_db
from backend.core.utils import utc_now


def request_updates(payload: BaseModel, reject_null: bool = False) -> dict[str, Any]:
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
def get_brainstorm(story_id: str) -> dict[str, Any]:
    with get_db() as conn:
        story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        nodes = conn.execute(
            "SELECT * FROM brainstorm_nodes WHERE story_id = ? ORDER BY created_at ASC",
            (story_id,),
        ).fetchall()
        edges = conn.execute(
            "SELECT * FROM brainstorm_edges WHERE story_id = ? ORDER BY created_at ASC",
            (story_id,),
        ).fetchall()
        viewport = conn.execute(
            "SELECT * FROM brainstorm_viewports WHERE story_id = ?",
            (story_id,),
        ).fetchone()
        generation_rows = conn.execute(
            """
            SELECT prompt_node_id, reasoning, duration_ms
            FROM brainstorm_generations
            WHERE story_id = ?
            ORDER BY created_at ASC
            """,
            (story_id,),
        ).fetchall()
        latest_generation = conn.execute(
            """
            SELECT * FROM brainstorm_generations
            WHERE story_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (story_id,),
        ).fetchone()

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
            row_to_brainstorm_node(
                row,
                reasoningByPromptId.get(row["id"]),
                durationByPromptId.get(row["id"]),
            )
            for row in nodes
        ],
        "edges": [row_to_brainstorm_edge(row) for row in edges],
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
def update_brainstorm_node(
    story_id: str,
    node_id: str,
    payload: BrainstormNodePatchRequest,
) -> dict[str, Any]:
    updates = request_updates(payload, reject_null=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No node changes provided.")

    with get_db() as conn:
        node = conn.execute(
            "SELECT * FROM brainstorm_nodes WHERE id = ? AND story_id = ?",
            (node_id, story_id),
        ).fetchone()
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
        values.append(utc_now())
        values.extend([node_id, story_id])
        conn.execute(
            f"UPDATE brainstorm_nodes SET {', '.join(assignments)} WHERE id = ? AND story_id = ?",
            values,
        )
        updated = conn.execute(
            "SELECT * FROM brainstorm_nodes WHERE id = ?", (node_id,)
        ).fetchone()
    return {"node": row_to_brainstorm_node(updated)}


@router.patch("/api/stories/{story_id}/brainstorm/viewport")
def update_brainstorm_viewport(
    story_id: str,
    payload: BrainstormViewportRequest,
) -> dict[str, Any]:
    now = utc_now()
    with get_db() as conn:
        story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")
        conn.execute(
            """
            INSERT INTO brainstorm_viewports (
              story_id, position_x, position_y, zoom, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(story_id) DO UPDATE SET
              position_x = excluded.position_x,
              position_y = excluded.position_y,
              zoom = excluded.zoom,
              updated_at = excluded.updated_at
            """,
            (story_id, payload.position_x, payload.position_y, payload.zoom, now),
        )
    return {"viewport": {"x": payload.position_x, "y": payload.position_y, "zoom": payload.zoom}}


@router.delete("/api/stories/{story_id}/brainstorm/nodes/{node_id}")
def delete_brainstorm_node(
    story_id: str,
    node_id: str,
    cascade: bool = False,
) -> dict[str, Any]:
    with get_db() as conn:
        nodes = conn.execute(
            "SELECT id FROM brainstorm_nodes WHERE story_id = ?", (story_id,)
        ).fetchall()
        node_ids = {row["id"] for row in nodes}
        if node_id not in node_ids:
            raise HTTPException(status_code=404, detail="Brainstorm node not found.")
        edges = conn.execute(
            "SELECT source_node_id, target_node_id FROM brainstorm_edges WHERE story_id = ?",
            (story_id,),
        ).fetchall()
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
        placeholders = ",".join("?" for _ in delete_ids)
        values = list(delete_ids)
        conn.execute(
            f"DELETE FROM brainstorm_generations WHERE prompt_node_id IN ({placeholders})",
            values,
        )
        conn.execute(
            f"DELETE FROM brainstorm_edges WHERE story_id = ? AND (source_node_id IN ({placeholders}) OR target_node_id IN ({placeholders}))",
            [story_id, *values, *values],
        )
        conn.execute(
            f"DELETE FROM brainstorm_nodes WHERE story_id = ? AND id IN ({placeholders})",
            [story_id, *values],
        )
    return {"deleted_node_ids": values}
