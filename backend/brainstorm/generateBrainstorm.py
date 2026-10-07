import asyncio
import sqlite3
import time
import uuid
from contextlib import aclosing
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.brainstorm.brainstormLayout import (
    brainstormIdeaPositions,
    nextBrainstormBranchPosition,
    nextBrainstormRootPosition,
)
from backend.brainstorm.brainstormMessages import (
    brainstormResponseFormat,
    buildBrainstormMessages,
    parseBrainstormIdeas,
)
from backend.brainstorm.brainstormQueries import (
    getEdge,
    getNode,
    insertEdge,
    insertGeneration,
    insertIdeaNode,
    insertPromptNode,
    listEdges,
    listNodes,
    setNodeStatus,
)
from backend.brainstorm.brainstormRows import (
    rowToBrainstormEdge,
    rowToBrainstormNode,
)
from backend.chats.chatModels import StreamMessageRequest
from backend.core.database import getDb
from backend.core.streamEvents import streamEvent
from backend.core.utils import utcNow
from backend.lorebook.lorebookQueries import listEntriesByUpdated
from backend.providers.base import ChatOptions
from backend.providers.modelStream import ModelStream
from backend.providers.registry import providerForRow
from backend.stories.storyProvider import storyProvider
from backend.usage.recordUsage import recordUsage
from backend.stories.storyQueries import (
    listChapters,
    requireStory,
    updateStoryBrainstormSettings,
)

router = APIRouter()


async def streamBrainstormGeneration(
    story_id: str,
    payload: StreamMessageRequest,
    story: sqlite3.Row,
    chapters: list[sqlite3.Row],
    lorebook_rows: list[sqlite3.Row],
    branch_nodes: list[sqlite3.Row],
    prompt_node: sqlite3.Row,
    prompt_edges: list[sqlite3.Row],
) -> AsyncIterator[bytes]:
    provider = providerForRow(story)
    api_key = provider.requireKey()

    prompt_node_id = prompt_node["id"]
    generation_row_id = str(uuid.uuid4())
    messages = buildBrainstormMessages(
        story, chapters, lorebook_rows, branch_nodes, payload.message, payload.brainstorm_idea_count
    )

    responseFormat = None
    if provider.supportsStructuredOutput(payload.model):
        responseFormat = brainstormResponseFormat(payload.brainstorm_idea_count)

    request = provider.buildRequest(
        messages,
        payload.model,
        ChatOptions(
            apiKey=api_key,
            temperature=payload.temperature,
            maxTokens=payload.max_tokens,
            nitro=payload.nitro_mode,
            thinkingEnabled=payload.thinking_enabled,
            reasoningEffort=payload.reasoning_effort,
            responseFormat=responseFormat,
        ),
    )
    effectiveThinkingEnabled = provider.effectiveThinkingEnabled(
        payload.model, payload.thinking_enabled
    )

    modelStream = ModelStream(provider, request, effectiveThinkingEnabled)
    generation_started_at = time.perf_counter()
    duration_ms: float | None = None
    saved_generation = False

    def saveGeneration(
        status: str,
        error: str | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        nonlocal duration_ms, saved_generation
        if saved_generation:
            return
        duration_ms = (time.perf_counter() - generation_started_at) * 1000
        if conn is not None:
            writeGeneration(conn, status, error)
        else:
            with getDb() as ownConn:
                writeGeneration(ownConn, status, error)
        saved_generation = True

    def writeGeneration(
        conn: sqlite3.Connection,
        status: str,
        error: str | None,
    ) -> None:
        setNodeStatus(conn, prompt_node_id, status, utcNow())
        createdAt = utcNow()
        insertGeneration(
            conn,
            (
                generation_row_id,
                story_id,
                prompt_node_id,
                payload.message,
                "".join(modelStream.reasoningParts) or None,
                duration_ms,
                payload.model,
                modelStream.finishReason,
                error,
                modelStream.generationId,
                modelStream.usage.get("prompt_tokens"),
                modelStream.usage.get("completion_tokens"),
                modelStream.usage.get("reasoning_tokens"),
                modelStream.usage.get("cached_tokens"),
                modelStream.usage.get("total_tokens"),
                modelStream.usage.get("cost"),
                modelStream.usage.get("provider_name"),
                modelStream.usage.get("generation_time"),
                modelStream.usage.get("latency"),
                createdAt,
            ),
        )
        recordUsage(
            "brainstorm",
            generation_row_id,
            payload.model,
            modelStream.usage,
            createdAt,
            modelStream.generationId,
            provider.id,
        )

    try:
        promptNodeValue = rowToBrainstormNode(prompt_node)
        promptNodeValue["generation_phase"] = "waiting"
        yield streamEvent(
            "prompt",
            {
                "node": promptNodeValue,
                "edges": [rowToBrainstormEdge(edge) for edge in prompt_edges],
            },
        )
        async with aclosing(modelStream.events()) as events:
            async for event in events:
                if event["type"] == "reasoning":
                    yield streamEvent("reasoning", event["value"])
                elif event["type"] == "contentStart":
                    yield streamEvent("working", None)

        if modelStream.errorMessage:
            saveGeneration("failed", modelStream.errorMessage)
            yield streamEvent("error", modelStream.errorMessage)
            return

        await modelStream.fetchFinalUsage(api_key)

        if modelStream.finishReason == "length":
            raise ValueError(
                "Brainstorm generation hit the model token limit before it finished."
            )
        if not modelStream.receivedDone:
            raise ValueError(
                "Brainstorm generation ended before the provider completed the stream."
            )

        ideas = parseBrainstormIdeas(modelStream.text)
        if len(ideas) != payload.brainstorm_idea_count:
            raise ValueError(
                f"Brainstorm output returned {len(ideas)} ideas instead of "
                f"{payload.brainstorm_idea_count}."
            )
        prompt_x = float(prompt_node["position_x"])
        prompt_y = float(prompt_node["position_y"])
        idea_positions = brainstormIdeaPositions(prompt_x, prompt_y, len(ideas))
        now = utcNow()
        created_nodes: list[dict[str, Any]] = []
        created_edges: list[dict[str, Any]] = []
        with getDb() as conn:
            for index, idea in enumerate(ideas):
                idea_id = str(uuid.uuid4())
                edge_id = str(uuid.uuid4())
                insertIdeaNode(
                    conn,
                    (
                        idea_id,
                        story_id,
                        idea["title"],
                        idea["content"],
                        idea_positions[index][0],
                        idea_positions[index][1],
                        now,
                        now,
                    ),
                )
                insertEdge(conn, edge_id, story_id, prompt_node_id, idea_id, now)
                node_row = getNode(conn, idea_id)
                edge_row = getEdge(conn, edge_id)
                created_nodes.append(rowToBrainstormNode(node_row))
                created_edges.append(rowToBrainstormEdge(edge_row))
            saveGeneration("complete", conn=conn)
        yield streamEvent(
            "ideas",
            {
                "nodes": created_nodes,
                "edges": created_edges,
                "duration_ms": duration_ms,
            },
        )
        if modelStream.usage:
            yield streamEvent(
                "usage",
                {
                    "generation_id": modelStream.generationId,
                    "model": payload.model,
                    **modelStream.usage,
                },
            )
    except asyncio.CancelledError:
        saveGeneration("cancelled", "Generation cancelled.")
        raise
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
        saveGeneration("failed", error)
        yield streamEvent("error", error)
    finally:
        if not saved_generation:
            saveGeneration("cancelled", "Generation cancelled.")


@router.post("/api/stories/{story_id}/brainstorm/generate/stream")
async def generateBrainstorm(
    story_id: str,
    payload: StreamMessageRequest,
) -> StreamingResponse:
    provider = storyProvider(story_id)
    provider.requireKey()
    if not payload.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    selected_ids = list(dict.fromkeys(payload.selected_idea_ids))
    now = utcNow()
    prompt_node_id = str(uuid.uuid4())
    prompt_edges: list[sqlite3.Row] = []
    with getDb() as conn:
        story = requireStory(conn, story_id)
        chapters = listChapters(conn, story_id)
        lorebook_rows = listEntriesByUpdated(conn, story_id)
        all_nodes = listNodes(conn, story_id)
        all_edges = listEdges(conn, story_id)
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
            prompt_x, prompt_y = nextBrainstormBranchPosition(
                all_nodes,
                [nodes_by_id[node_id] for node_id in selected_ids],
                payload.brainstorm_idea_count,
            )
        else:
            prompt_x, prompt_y = nextBrainstormRootPosition(
                all_nodes,
                payload.brainstorm_idea_count,
            )

        insertPromptNode(
            conn,
            (prompt_node_id, story_id, payload.message.strip(), prompt_x, prompt_y, now, now),
        )
        for selected_id in selected_ids:
            edge_id = str(uuid.uuid4())
            insertEdge(conn, edge_id, story_id, selected_id, prompt_node_id, now)
            prompt_edges.append(getEdge(conn, edge_id))
        updateStoryBrainstormSettings(
            conn,
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
        prompt_node = getNode(conn, prompt_node_id)

    return StreamingResponse(
        streamBrainstormGeneration(
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
