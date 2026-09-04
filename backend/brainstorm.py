import asyncio
import json
import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.lorebook import lorebook_context_line, parse_lorebook_json


OPENROUTER_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)

# Horizontal distance from a parent column to the column of nodes it spawns. Nodes
# are 300px wide, so this leaves enough gap for the edge curves to fan out rather
# than run as one near vertical bundle.
COLUMN_OFFSET_X = 660


@dataclass(frozen=True)
class BrainstormDeps:
    get_db: Callable[[], sqlite3.Connection]
    utc_now: Callable[[], str]
    read_openrouter_key: Callable[[], str | None]
    headers_for_key: Callable[[str], dict[str, str]]
    openrouter_request_model: Callable[[str, bool], str]
    openrouter_provider_options: Callable[[], dict[str, Any] | None]
    effective_thinking_enabled: Callable[[str, bool], bool]
    enabled_reasoning_config: Callable[[str, bool, str], dict[str, Any] | None]
    model_supports_structured_output: Callable[[str], bool]
    openrouter_error_message: Callable[[int, str], str]
    normalize_usage: Callable[[dict[str, Any] | None], dict[str, Any] | None]
    fetch_generation_usage: Callable[[str, str], Any]
    stream_event: Callable[..., bytes]
    stream_message_request: type[BaseModel]
    openrouter_base_url: str


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


class BrainstormNodePatchRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    position_x: float | None = None
    position_y: float | None = None


class BrainstormViewportRequest(BaseModel):
    position_x: float
    position_y: float
    zoom: float = Field(ge=0.1, le=4.0)

class StoryArchiveBrainstormNode(BaseModel):
    id: str = Field(min_length=1)
    story_id: str = Field(min_length=1)
    node_type: str = Field(min_length=1)
    title: str = ""
    content: str = ""
    position_x: float = 0
    position_y: float = 0
    status: str = "complete"
    created_at: str = ""
    updated_at: str = ""


class StoryArchiveBrainstormEdge(BaseModel):
    id: str = Field(min_length=1)
    story_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    created_at: str = ""


class StoryArchiveViewport(BaseModel):
    x: float = 0
    y: float = 0
    zoom: float = Field(default=1, ge=0.1, le=4.0)


class StoryArchiveBrainstorm(BaseModel):
    nodes: list[StoryArchiveBrainstormNode] = Field(default_factory=list)
    edges: list[StoryArchiveBrainstormEdge] = Field(default_factory=list)
    viewport: StoryArchiveViewport = Field(default_factory=StoryArchiveViewport)


def brainstorm_response_format(ideaCount: int) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "brainstorm_ideas",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "ideas": {
                        "type": "array",
                        "minItems": ideaCount,
                        "maxItems": ideaCount,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "title": {"type": "string", "minLength": 1},
                                "content": {"type": "string", "minLength": 1},
                            },
                            "required": ["title", "content"],
                        },
                    },
                },
                "required": ["ideas"],
            },
        },
    }


def parse_brainstorm_ideas(raw_output: str) -> list[dict[str, str]]:
    try:
        parsed = parse_lorebook_json(raw_output)
    except ValueError as exc:
        raise ValueError("Could not parse the brainstorm ideas response.") from exc
    raw_ideas = parsed.get("ideas")
    if not isinstance(raw_ideas, list):
        raise ValueError("Brainstorm output must contain an ideas array.")

    ideas: list[dict[str, str]] = []
    for raw_idea in raw_ideas:
        if not isinstance(raw_idea, dict):
            raise ValueError("Every brainstorm idea must be an object.")
        title = str(raw_idea.get("title") or "").strip()
        content = str(raw_idea.get("content") or "").strip()
        if not title or not content:
            raise ValueError("Every brainstorm idea must include a title and content.")
        ideas.append({"title": title, "content": content})

    if not ideas:
        raise ValueError("Brainstorm output must contain at least one complete idea.")
    return ideas


def next_brainstorm_root_position(
    nodes: list[Any],
    edges: list[Any],
    ideaCount: int,
) -> tuple[float, float]:
    rootX = 0.0
    anchorY = 180.0
    ideaGap = 210.0
    nodeHalfHeight = 130.0
    branchClearance = 80.0

    if not nodes:
        return rootX, anchorY

    childIdsBySource: dict[str, list[str]] = {}
    incomingIds: set[str] = set()
    nodesById = {str(node["id"]): node for node in nodes}
    for edge in edges:
        sourceId = str(edge["source_node_id"])
        targetId = str(edge["target_node_id"])
        if sourceId not in nodesById or targetId not in nodesById:
            continue
        childIdsBySource.setdefault(sourceId, []).append(targetId)
        incomingIds.add(targetId)

    occupiedBounds: list[tuple[float, float]] = []
    for rootNode in nodes:
        rootId = str(rootNode["id"])
        if rootId in incomingIds:
            continue

        branchIds = {rootId}
        pendingIds = [rootId]
        while pendingIds:
            currentId = pendingIds.pop()
            for childId in childIdsBySource.get(currentId, []):
                if childId in branchIds:
                    continue
                branchIds.add(childId)
                pendingIds.append(childId)

        branchY = [float(nodesById[nodeId]["position_y"]) for nodeId in branchIds]
        occupiedBounds.append((
            min(branchY) - nodeHalfHeight,
            max(branchY) + nodeHalfHeight,
        ))

    if not occupiedBounds:
        return rootX, anchorY

    newBranchHalfHeight = ((max(1, ideaCount) - 1) * ideaGap / 2) + nodeHalfHeight
    candidateY = {anchorY}
    for lowerBound, upperBound in occupiedBounds:
        candidateY.add(upperBound + branchClearance + newBranchHalfHeight)
        candidateY.add(lowerBound - branchClearance - newBranchHalfHeight)

    def slotIsOpen(centerY: float) -> bool:
        nextLower = centerY - newBranchHalfHeight
        nextUpper = centerY + newBranchHalfHeight
        return all(
            nextUpper + branchClearance <= lowerBound
            or nextLower - branchClearance >= upperBound
            for lowerBound, upperBound in occupiedBounds
        )

    openSlots = [centerY for centerY in candidateY if slotIsOpen(centerY)]
    bestY = min(
        openSlots,
        key=lambda centerY: (
            abs(centerY - anchorY),
            0 if centerY >= anchorY else 1,
            centerY,
        ),
    )
    return rootX, bestY

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


def build_brainstorm_messages(
    story: sqlite3.Row,
    chapters: list[sqlite3.Row],
    lorebook_rows: list[sqlite3.Row],
    branch_nodes: list[sqlite3.Row],
    prompt: str,
    idea_count: int = 3,
) -> list[dict[str, str]]:
    visibleChapters = [chapter for chapter in chapters if not bool(chapter["disabled"])]
    chapterText = "\n\n".join(
        f"chapter {index + 1}: {chapter['title']}\n{chapter['content'] or 'empty chapter'}"
        for index, chapter in enumerate(visibleChapters)
    ) or "no visible chapters yet"
    lorebook_text = "\n".join(
        lorebook_context_line(row)
        for row in lorebook_rows
        if not bool(row["disabled"]) and row["description"].strip()
    ) or "no enabled lorebook entries"
    branch_text = "\n\n".join(
        f"{row['node_type']}: {row['title']}\n{row['content']}"
        for row in branch_nodes
    ) or "this is a new root brainstorm"

    context = (
        f"story title: {story['title']}\n"
        f"author: {story['author'] or 'unknown'}\n"
        f"language: {story['language'] or 'English'}\n"
        f"synopsis: {story['synopsis'] or 'none yet'}\n\n"
        f"all visible chapters:\n{chapterText}\n\n"
        f"lorebook:\n{lorebook_text}\n\n"
        f"selected brainstorm branch:\n{branch_text}"
    )

    messages: list[dict[str, str]] = []
    if story["system_prompt"].strip():
        messages.append({"role": "system", "content": story["system_prompt"].strip()})
    messages.append(
        {
            "role": "system",
            "content": (
                "You are a fiction brainstorming partner. Use the complete story context and the "
                "selected branch to propose distinct, story-specific continuations. Return only one "
                f"JSON object with an ideas array containing exactly {idea_count} objects. Every object must have a "
                "short title and a content field with 2 to 4 concise sentences. Do not write prose "
                "for the chapter and do not wrap the JSON in markdown."
            ),
        }
    )
    messages.append({"role": "user", "content": context})
    messages.append({"role": "user", "content": prompt})
    return messages

def create_brainstorm_router(deps: BrainstormDeps) -> APIRouter:
    router = APIRouter()
    StreamMessageRequest = deps.stream_message_request

    @router.get("/api/stories/{story_id}/brainstorm")
    def get_brainstorm(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
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

        with deps.get_db() as conn:
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
            values.append(deps.utc_now())
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
        now = deps.utc_now()
        with deps.get_db() as conn:
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
        with deps.get_db() as conn:
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

    async def stream_brainstorm_generation(
        story_id: str,
        payload: StreamMessageRequest,
        story: sqlite3.Row,
        chapters: list[sqlite3.Row],
        lorebook_rows: list[sqlite3.Row],
        branch_nodes: list[sqlite3.Row],
        prompt_node: sqlite3.Row,
        prompt_edges: list[sqlite3.Row],
    ) -> AsyncIterator[bytes]:
        api_key = deps.read_openrouter_key()
        prompt_node_id = prompt_node["id"]
        generation_row_id = str(uuid.uuid4())
        messages = build_brainstorm_messages(
            story, chapters, lorebook_rows, branch_nodes, payload.message, payload.brainstorm_idea_count
        )
        body: dict[str, Any] = {
            "model": deps.openrouter_request_model(payload.model, payload.nitro_mode),
            "messages": messages,
            "temperature": payload.temperature,
            "max_tokens": payload.max_tokens,
            "stream": True,
        }
        providerOptions = deps.openrouter_provider_options()
        if providerOptions:
            body["provider"] = providerOptions

        effectiveThinkingEnabled = deps.effective_thinking_enabled(
            payload.model, payload.thinking_enabled
        )
        reasoningConfig = deps.enabled_reasoning_config(
            payload.model, payload.thinking_enabled, payload.reasoning_effort
        )
        if reasoningConfig:
            body["reasoning"] = reasoningConfig
        if deps.model_supports_structured_output(payload.model):
            body["response_format"] = brainstorm_response_format(
                payload.brainstorm_idea_count
            )

        generated_text: list[str] = []
        reasoning_text: list[str] = []
        generation_started_at = time.perf_counter()
        duration_ms: float | None = None
        generation_id: str | None = None
        finish_reason: str | None = None
        usage: dict[str, Any] = {}
        receivedDone = False
        saved_generation = False

        def save_generation(status: str, error: str | None = None) -> None:
            nonlocal duration_ms, saved_generation
            if saved_generation:
                return
            saved_generation = True
            duration_ms = (time.perf_counter() - generation_started_at) * 1000
            with deps.get_db() as conn:
                conn.execute(
                    "UPDATE brainstorm_nodes SET status = ?, updated_at = ? WHERE id = ?",
                    (status, deps.utc_now(), prompt_node_id),
                )
                conn.execute(
                    """
                    INSERT INTO brainstorm_generations (
                      id, story_id, prompt_node_id, prompt, reasoning, duration_ms,
                      model, finish_reason, error,
                      generation_id, prompt_tokens, completion_tokens, reasoning_tokens,
                      total_tokens, cost, provider_name, generation_time, latency, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        generation_row_id,
                        story_id,
                        prompt_node_id,
                        payload.message,
                        "".join(reasoning_text) or None,
                        duration_ms,
                        payload.model,
                        finish_reason,
                        error,
                        generation_id,
                        usage.get("prompt_tokens"),
                        usage.get("completion_tokens"),
                        usage.get("reasoning_tokens"),
                        usage.get("total_tokens"),
                        usage.get("cost"),
                        usage.get("provider_name"),
                        usage.get("generation_time"),
                        usage.get("latency"),
                        deps.utc_now(),
                    ),
                )

        try:
            promptNodeValue = row_to_brainstorm_node(prompt_node)
            promptNodeValue["generation_phase"] = (
                "thinking" if effectiveThinkingEnabled else "working"
            )
            yield deps.stream_event(
                "prompt",
                {
                    "node": promptNodeValue,
                    "edges": [row_to_brainstorm_edge(edge) for edge in prompt_edges],
                },
            )
            working_started = False
            async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    f"{deps.openrouter_base_url}/chat/completions",
                    headers={**deps.headers_for_key(api_key), "Content-Type": "application/json"},
                    json=body,
                ) as response:
                    if response.status_code >= 400:
                        raw_error = (await response.aread()).decode("utf-8", errors="replace")
                        error = deps.openrouter_error_message(response.status_code, raw_error)
                        save_generation("failed", error)
                        yield deps.stream_event("error", error)
                        return
                    generation_id = response.headers.get("X-Generation-Id")

                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            receivedDone = True
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        generation_id = generation_id or chunk.get("id")
                        next_usage = deps.normalize_usage(chunk.get("usage"))
                        if next_usage:
                            usage.update(next_usage)
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finish_reason = choice.get("finish_reason") or finish_reason
                        delta = choice.get("delta") or {}
                        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                        if reasoning and effectiveThinkingEnabled:
                            reasoningValue = str(reasoning)
                            reasoning_text.append(reasoningValue)
                            yield deps.stream_event("reasoning", reasoningValue)
                        content = delta.get("content")
                        if content:
                            if not working_started:
                                working_started = True
                                yield deps.stream_event("working", None)
                            generated_text.append(str(content))

            if generation_id:
                generation_usage = await deps.fetch_generation_usage(api_key, generation_id)
                if generation_usage:
                    usage.update(generation_usage)

            if finish_reason == "length":
                raise ValueError(
                    "Brainstorm generation hit the model token limit before it finished."
                )
            if not receivedDone:
                raise ValueError(
                    "Brainstorm generation ended before the provider completed the stream."
                )

            ideas = parse_brainstorm_ideas("".join(generated_text))
            if len(ideas) != payload.brainstorm_idea_count:
                raise ValueError(
                    f"Brainstorm output returned {len(ideas)} ideas instead of "
                    f"{payload.brainstorm_idea_count}."
                )
            prompt_x = float(prompt_node["position_x"])
            prompt_y = float(prompt_node["position_y"])
            child_x = prompt_x + COLUMN_OFFSET_X
            child_gap = 210
            first_y = prompt_y - ((len(ideas) - 1) * child_gap / 2)
            now = deps.utc_now()
            created_nodes: list[dict[str, Any]] = []
            created_edges: list[dict[str, Any]] = []
            with deps.get_db() as conn:
                for index, idea in enumerate(ideas):
                    idea_id = str(uuid.uuid4())
                    edge_id = str(uuid.uuid4())
                    conn.execute(
                        """
                        INSERT INTO brainstorm_nodes (
                          id, story_id, node_type, title, content, position_x,
                          position_y, status, created_at, updated_at
                        ) VALUES (?, ?, 'idea', ?, ?, ?, ?, 'complete', ?, ?)
                        """,
                        (
                            idea_id,
                            story_id,
                            idea["title"],
                            idea["content"],
                            child_x,
                            first_y + index * child_gap,
                            now,
                            now,
                        ),
                    )
                    conn.execute(
                        """
                        INSERT INTO brainstorm_edges (
                          id, story_id, source_node_id, target_node_id, created_at
                        ) VALUES (?, ?, ?, ?, ?)
                        """,
                        (edge_id, story_id, prompt_node_id, idea_id, now),
                    )
                    node_row = conn.execute(
                        "SELECT * FROM brainstorm_nodes WHERE id = ?", (idea_id,)
                    ).fetchone()
                    edge_row = conn.execute(
                        "SELECT * FROM brainstorm_edges WHERE id = ?", (edge_id,)
                    ).fetchone()
                    created_nodes.append(row_to_brainstorm_node(node_row))
                    created_edges.append(row_to_brainstorm_edge(edge_row))
            save_generation("complete")
            yield deps.stream_event(
                "ideas",
                {
                    "nodes": created_nodes,
                    "edges": created_edges,
                    "duration_ms": duration_ms,
                },
            )
            if usage:
                yield deps.stream_event(
                    "usage", {"generation_id": generation_id, "model": payload.model, **usage}
                )
        except asyncio.CancelledError:
            save_generation("cancelled", "Generation cancelled.")
            raise
        except Exception as exc:  # noqa: BLE001
            error = str(exc)
            save_generation("failed", error)
            yield deps.stream_event("error", error)

    @router.post("/api/stories/{story_id}/brainstorm/generate/stream")
    async def generate_brainstorm(
        story_id: str,
        payload: StreamMessageRequest,
    ) -> StreamingResponse:
        if not deps.read_openrouter_key():
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
        if not payload.message.strip():
            raise HTTPException(status_code=400, detail="Message cannot be empty.")

        selected_ids = list(dict.fromkeys(payload.selected_idea_ids))
        now = deps.utc_now()
        prompt_node_id = str(uuid.uuid4())
        prompt_edges: list[sqlite3.Row] = []
        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            chapters = conn.execute(
                "SELECT * FROM chapters WHERE story_id = ? ORDER BY order_index ASC, created_at ASC",
                (story_id,),
            ).fetchall()
            lorebook_rows = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY updated_at DESC",
                (story_id,),
            ).fetchall()
            all_nodes = conn.execute(
                "SELECT * FROM brainstorm_nodes WHERE story_id = ? ORDER BY created_at ASC",
                (story_id,),
            ).fetchall()
            all_edges = conn.execute(
                "SELECT * FROM brainstorm_edges WHERE story_id = ? ORDER BY created_at ASC",
                (story_id,),
            ).fetchall()
            nodes_by_id = {row["id"]: row for row in all_nodes}
            if any(
                selected_id not in nodes_by_id
                or nodes_by_id[selected_id]["node_type"] != "idea"
                for selected_id in selected_ids
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Every selected brainstorm node must be an idea from this story.",
                )

            parent_by_target: dict[str, list[str]] = {}
            for edge in all_edges:
                parent_by_target.setdefault(edge["target_node_id"], []).append(
                    edge["source_node_id"]
                )
            branch_ids = set(selected_ids)
            pending = list(selected_ids)
            while pending:
                current_id = pending.pop()
                for parent_id in parent_by_target.get(current_id, []):
                    if parent_id not in branch_ids:
                        branch_ids.add(parent_id)
                        pending.append(parent_id)
            branch_nodes = [row for row in all_nodes if row["id"] in branch_ids]

            if selected_ids:
                prompt_x = max(float(nodes_by_id[node_id]["position_x"]) for node_id in selected_ids) + COLUMN_OFFSET_X
                prompt_y = sum(
                    float(nodes_by_id[node_id]["position_y"]) for node_id in selected_ids
                ) / len(selected_ids)
            else:
                prompt_x, prompt_y = next_brainstorm_root_position(
                    all_nodes,
                    all_edges,
                    payload.brainstorm_idea_count,
                )

            conn.execute(
                """
                INSERT INTO brainstorm_nodes (
                  id, story_id, node_type, title, content, position_x,
                  position_y, status, created_at, updated_at
                ) VALUES (?, ?, 'prompt', 'Prompt', ?, ?, ?, 'generating', ?, ?)
                """,
                (prompt_node_id, story_id, payload.message.strip(), prompt_x, prompt_y, now, now),
            )
            for selected_id in selected_ids:
                edge_id = str(uuid.uuid4())
                conn.execute(
                    """
                    INSERT INTO brainstorm_edges (
                      id, story_id, source_node_id, target_node_id, created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (edge_id, story_id, selected_id, prompt_node_id, now),
                )
                prompt_edges.append(
                    conn.execute(
                        "SELECT * FROM brainstorm_edges WHERE id = ?", (edge_id,)
                    ).fetchone()
                )
            conn.execute(
                """
                UPDATE stories SET model = ?, temperature = ?, max_tokens = ?,
                  thinking_enabled = ?, reasoning_effort = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.model,
                    payload.temperature,
                    payload.max_tokens,
                    int(payload.thinking_enabled),
                    payload.reasoning_effort,
                    now,
                    story_id,
                ),
            )
            prompt_node = conn.execute(
                "SELECT * FROM brainstorm_nodes WHERE id = ?", (prompt_node_id,)
            ).fetchone()

        return StreamingResponse(
            stream_brainstorm_generation(
                story_id,
                payload,
                story,
                chapters,
                lorebook_rows,
                branch_nodes,
                prompt_node,
                prompt_edges,
            ),
            media_type="application/x-ndjson; charset=utf-8",
        )

    return router
