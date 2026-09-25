import asyncio
import json
import sqlite3
import time
import uuid
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.brainstorm.brainstormLayout import (
    COLUMN_OFFSET_X,
    next_brainstorm_root_position,
)
from backend.brainstorm.brainstormMessages import (
    brainstorm_response_format,
    build_brainstorm_messages,
    parse_brainstorm_ideas,
)
from backend.brainstorm.brainstormRows import (
    row_to_brainstorm_edge,
    row_to_brainstorm_node,
)
from backend.chats.chatModels import StreamMessageRequest
from backend.core.database import get_db
from backend.core.streamEvents import stream_event
from backend.core.utils import utc_now
from backend.providers.openrouter.apiKey import read_openrouter_key
from backend.providers.openrouter.client import OPENROUTER_BASE_URL, headers_for_key
from backend.providers.openrouter.errors import openrouter_error_message
from backend.providers.openrouter.models import model_supports_structured_output
from backend.providers.openrouter.requestOptions import (
    effective_thinking_enabled,
    enabled_reasoning_config,
    openrouter_provider_options,
    openrouter_request_model,
)
from backend.providers.openrouter.usage import fetch_generation_usage, normalize_usage

router = APIRouter()
OPENROUTER_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)


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
    api_key = read_openrouter_key()
    if not api_key:
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

    prompt_node_id = prompt_node["id"]
    generation_row_id = str(uuid.uuid4())
    messages = build_brainstorm_messages(
        story, chapters, lorebook_rows, branch_nodes, payload.message, payload.brainstorm_idea_count
    )
    body: dict[str, Any] = {
        "model": openrouter_request_model(payload.model, payload.nitro_mode),
        "messages": messages,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "stream": True,
    }
    providerOptions = openrouter_provider_options()
    if providerOptions:
        body["provider"] = providerOptions

    effectiveThinkingEnabled = effective_thinking_enabled(
        payload.model, payload.thinking_enabled
    )
    reasoningConfig = enabled_reasoning_config(
        payload.model, payload.thinking_enabled, payload.reasoning_effort
    )
    if reasoningConfig:
        body["reasoning"] = reasoningConfig
    if model_supports_structured_output(payload.model):
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
        with get_db() as conn:
            conn.execute(
                "UPDATE brainstorm_nodes SET status = ?, updated_at = ? WHERE id = ?",
                (status, utc_now(), prompt_node_id),
            )
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
                    usage.get("cached_tokens"),
                    usage.get("total_tokens"),
                    usage.get("cost"),
                    usage.get("provider_name"),
                    usage.get("generation_time"),
                    usage.get("latency"),
                    utc_now(),
                ),
            )

    try:
        promptNodeValue = row_to_brainstorm_node(prompt_node)
        promptNodeValue["generation_phase"] = "waiting"
        yield stream_event(
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
                f"{OPENROUTER_BASE_URL}/chat/completions",
                headers={**headers_for_key(api_key), "Content-Type": "application/json"},
                json=body,
            ) as response:
                if response.status_code >= 400:
                    raw_error = (await response.aread()).decode("utf-8", errors="replace")
                    error = openrouter_error_message(response.status_code, raw_error)
                    save_generation("failed", error)
                    yield stream_event("error", error)
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
                    next_usage = normalize_usage(chunk.get("usage"))
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
                        yield stream_event("reasoning", reasoningValue)
                    content = delta.get("content")
                    if content:
                        if not working_started:
                            working_started = True
                            yield stream_event("working", None)
                        generated_text.append(str(content))

        if generation_id:
            generation_usage = await fetch_generation_usage(api_key, generation_id)
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
        now = utc_now()
        created_nodes: list[dict[str, Any]] = []
        created_edges: list[dict[str, Any]] = []
        with get_db() as conn:
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
        yield stream_event(
            "ideas",
            {
                "nodes": created_nodes,
                "edges": created_edges,
                "duration_ms": duration_ms,
            },
        )
        if usage:
            yield stream_event(
                "usage", {"generation_id": generation_id, "model": payload.model, **usage}
            )
    except asyncio.CancelledError:
        save_generation("cancelled", "Generation cancelled.")
        raise
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
        save_generation("failed", error)
        yield stream_event("error", error)


@router.post("/api/stories/{story_id}/brainstorm/generate/stream")
async def generate_brainstorm(
    story_id: str,
    payload: StreamMessageRequest,
) -> StreamingResponse:
    if not read_openrouter_key():
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
    if not payload.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    selected_ids = list(dict.fromkeys(payload.selected_idea_ids))
    now = utc_now()
    prompt_node_id = str(uuid.uuid4())
    prompt_edges: list[sqlite3.Row] = []
    with get_db() as conn:
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
