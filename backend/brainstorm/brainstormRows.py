import sqlite3
from typing import Any


def row_to_brainstorm_node(
    row: sqlite3.Row,
    reasoning: str | None = None,
    duration_ms: float | None = None,
) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "node_type": row["node_type"],
        "title": row["title"],
        "content": row["content"],
        "position_x": row["position_x"],
        "position_y": row["position_y"],
        "status": row["status"],
        "reasoning": reasoning,
        "duration_ms": duration_ms,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_brainstorm_edge(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "source_node_id": row["source_node_id"],
        "target_node_id": row["target_node_id"],
        "created_at": row["created_at"],
    }
