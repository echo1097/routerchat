import sqlite3
from typing import Any


def listNodes(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM brainstorm_nodes WHERE story_id = ? ORDER BY created_at ASC",
        (storyId,),
    ).fetchall()


def listNodeIds(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id FROM brainstorm_nodes WHERE story_id = ?", (storyId,)
    ).fetchall()


def getNode(conn: sqlite3.Connection, nodeId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM brainstorm_nodes WHERE id = ?", (nodeId,)
    ).fetchone()


def getStoryNode(conn: sqlite3.Connection, storyId: str, nodeId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM brainstorm_nodes WHERE id = ? AND story_id = ?",
        (nodeId, storyId),
    ).fetchone()


def findGeneratingNode(conn: sqlite3.Connection, storyId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT 1 FROM brainstorm_nodes WHERE story_id = ? AND status = 'generating' LIMIT 1",
        (storyId,),
    ).fetchone()


def insertIdeaNode(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO brainstorm_nodes (
          id, story_id, node_type, title, content, position_x,
          position_y, status, created_at, updated_at
        ) VALUES (?, ?, 'idea', ?, ?, ?, ?, 'complete', ?, ?)
        """,
        values,
    )


def insertPromptNode(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO brainstorm_nodes (
          id, story_id, node_type, title, content, position_x,
          position_y, status, created_at, updated_at
        ) VALUES (?, ?, 'prompt', 'Prompt', ?, ?, ?, 'generating', ?, ?)
        """,
        values,
    )


def insertImportedNode(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO brainstorm_nodes (
          id, story_id, node_type, title, content, position_x,
          position_y, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )


def updateNodeColumns(conn: sqlite3.Connection, assignments: list[str], values: list[Any]) -> None:
    conn.execute(
        f"UPDATE brainstorm_nodes SET {', '.join(assignments)} WHERE id = ? AND story_id = ?",
        values,
    )


def updateNodePositions(conn: sqlite3.Connection, rows: list[tuple[Any, ...]]) -> None:
    conn.executemany(
        """
        UPDATE brainstorm_nodes
        SET position_x = ?, position_y = ?
        WHERE id = ? AND story_id = ?
        """,
        rows,
    )


def setNodeStatus(conn: sqlite3.Connection, nodeId: str, status: str, now: str) -> None:
    conn.execute(
        "UPDATE brainstorm_nodes SET status = ?, updated_at = ? WHERE id = ?",
        (status, now, nodeId),
    )


def deleteNodes(conn: sqlite3.Connection, storyId: str, nodeIds: list[str]) -> None:
    placeholders = ",".join("?" for _ in nodeIds)
    conn.execute(
        f"DELETE FROM brainstorm_generations WHERE prompt_node_id IN ({placeholders})",
        nodeIds,
    )
    conn.execute(
        f"DELETE FROM brainstorm_edges WHERE story_id = ? AND (source_node_id IN ({placeholders}) OR target_node_id IN ({placeholders}))",
        [storyId, *nodeIds, *nodeIds],
    )
    conn.execute(
        f"DELETE FROM brainstorm_nodes WHERE story_id = ? AND id IN ({placeholders})",
        [storyId, *nodeIds],
    )


def listEdges(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM brainstorm_edges WHERE story_id = ? ORDER BY created_at ASC",
        (storyId,),
    ).fetchall()


def listEdgeLinks(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT source_node_id, target_node_id FROM brainstorm_edges WHERE story_id = ?",
        (storyId,),
    ).fetchall()


def getEdge(conn: sqlite3.Connection, edgeId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM brainstorm_edges WHERE id = ?", (edgeId,)
    ).fetchone()


def insertEdge(
    conn: sqlite3.Connection,
    edgeId: str,
    storyId: str,
    sourceNodeId: str,
    targetNodeId: str,
    createdAt: str,
) -> None:
    conn.execute(
        """
        INSERT INTO brainstorm_edges (
          id, story_id, source_node_id, target_node_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (edgeId, storyId, sourceNodeId, targetNodeId, createdAt),
    )


def getViewport(conn: sqlite3.Connection, storyId: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM brainstorm_viewports WHERE story_id = ?",
        (storyId,),
    ).fetchone()


def saveViewport(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
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
        values,
    )


def insertViewport(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO brainstorm_viewports (
          story_id, position_x, position_y, zoom, updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        values,
    )


def listGenerationNotes(conn: sqlite3.Connection, storyId: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT prompt_node_id, reasoning, duration_ms
        FROM brainstorm_generations
        WHERE story_id = ?
        ORDER BY created_at ASC
        """,
        (storyId,),
    ).fetchall()


def getLatestGeneration(conn: sqlite3.Connection, storyId: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM brainstorm_generations
        WHERE story_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (storyId,),
    ).fetchone()


def insertGeneration(conn: sqlite3.Connection, values: tuple[Any, ...]) -> None:
    conn.execute(
        """
        INSERT INTO brainstorm_generations (
          id, story_id, prompt_node_id, prompt, reasoning, duration_ms,
          model, finish_reason, error,
          generation_id, prompt_tokens, completion_tokens, reasoning_tokens,
          cached_tokens, total_tokens, cost, provider_name, generation_time,
          latency, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )
