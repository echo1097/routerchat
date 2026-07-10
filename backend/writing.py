import asyncio
import json
import hashlib
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


DEFAULT_MAX_TOKENS = 30000
OPENROUTER_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
LOREBOOK_CATEGORIES = {
    "character",
    "location",
    "item",
    "event",
    "note",
    "synopsis",
    "timeline",
}


class StoryCreateRequest(BaseModel):
    title: str = Field(default="New story", min_length=1)
    author: str = ""
    language: str = "English"
    synopsis: str = ""
    model: str | None = None
    system_prompt: str = ""
    temperature: float = 0.7
    max_tokens: int = DEFAULT_MAX_TOKENS
    thinking_enabled: bool = False
    reasoning_effort: str = "medium"


class StoryPatchRequest(BaseModel):
    title: str | None = None
    author: str | None = None
    language: str | None = None
    synopsis: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    thinking_enabled: bool | None = None
    reasoning_effort: str | None = None


class ChapterCreateRequest(BaseModel):
    title: str = Field(default="New chapter", min_length=1)
    content: str = ""


class ChapterPatchRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    order_index: int | None = None


class ChapterContentRequest(BaseModel):
    content: str = ""


class LorebookEntryRequest(BaseModel):
    name: str = Field(min_length=1)
    category: str = "note"
    description: str = ""
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    disabled: bool = False


class BrainstormNodePatchRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    position_x: float | None = None
    position_y: float | None = None


class BrainstormViewportRequest(BaseModel):
    position_x: float
    position_y: float
    zoom: float = Field(ge=0.1, le=4.0)


@dataclass(frozen=True)
class WritingDeps:
    get_db: Callable[[], sqlite3.Connection]
    utc_now: Callable[[], str]
    default_model_id: Callable[[], str]
    read_openrouter_key: Callable[[], str | None]
    headers_for_key: Callable[[str], dict[str, str]]
    write_system_prompt: Callable[[Any], str]
    openrouter_request_model: Callable[[str, bool], str]
    model_supports_reasoning: Callable[[str], bool]
    openrouter_error_message: Callable[[int, str], str]
    normalize_usage: Callable[[dict[str, Any] | None], dict[str, Any] | None]
    fetch_generation_usage: Callable[[str, str], Any]
    stream_event: Callable[[str, Any], bytes]
    stream_message_request: type[BaseModel]
    openrouter_base_url: str


def json_list(value: str) -> list[Any]:
    try:
        parsed = json.loads(value or "[]")
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def json_dict(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def word_count(value: str) -> int:
    return len(value.split())


def text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def format_duration(ms: float) -> str:
    seconds = max(1, round(ms / 1000))
    return f"{seconds} {'second' if seconds == 1 else 'seconds'}"


def display_model_name(model: str) -> str:
    name = str(model or "Model").split("/")[-1]
    name = name.replace(":free", "").replace("-", " ").replace("_", " ")
    return " ".join(part[:1].upper() + part[1:] for part in name.split())


def lorebook_history_label(model_label: str, update: dict[str, Any]) -> str:
    name = str(update.get("name") or "entry").strip() or "entry"
    if name.casefold() == "timeline":
        return f"{model_label} updated Timeline"

    action = "added" if update.get("action") == "create" else "updated"
    destination = "in" if action == "updated" else "to"
    return f"{model_label} {action} {name} {destination} Lorebook"


def normalize_lorebook_category(category: str | None) -> str:
    value = str(category or "note").strip().lower()
    if value in {"characters", "character"}:
        return "character"
    if value in {"locations", "location"}:
        return "location"
    if value in {"items", "item"}:
        return "item"
    if value in {"events", "event"}:
        return "event"
    if value == "starting scenario":
        return "note"
    return value if value in LOREBOOK_CATEGORIES else "note"


def normalize_timeline_description(description: str) -> str:
    lines = []
    for line in str(description or "").splitlines():
        value = line.strip()
        if not value:
            continue
        if value.startswith("- "):
            lines.append(value)
            continue
        lines.append(f"- {value.removeprefix('-').removeprefix('*').strip()}")
    return "\n".join(lines)


def sanitize_lorebook_aliases(category: str, aliases: Any, fallback_name: str = "") -> list[Any]:
    if category in {"note", "synopsis"}:
        return []
    if isinstance(aliases, list):
        return aliases
    return [fallback_name] if fallback_name else []


def sanitize_lorebook_metadata(category: str, metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    if category == "character":
        blocked_keys = {"age", "physicalAppearance", "personality", "background"}
        return {key: value for key, value in metadata.items() if key not in blocked_keys}
    if category in {"note", "synopsis"}:
        return {}
    return metadata


def strip_json_fence(value: str) -> str:
    text = value.strip()
    if not text.startswith("```"):
        return text

    lines = text.splitlines()
    if len(lines) < 2:
        return text
    if lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return "\n".join(lines[1:]).strip()


def first_json_object(value: str) -> str:
    start = value.find("{")
    if start < 0:
        raise ValueError("No JSON object found in lorebook output.")

    depth = 0
    inString = False
    escapeNext = False
    for index, char in enumerate(value[start:], start):
        if escapeNext:
            escapeNext = False
            continue
        if char == "\\" and inString:
            escapeNext = True
            continue
        if char == "\"":
            inString = not inString
            continue
        if inString:
            continue
        if char == "{":
            depth += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                return value[start:index + 1]

    raise ValueError("Unclosed JSON object in lorebook output.")


def is_scene_break(value: str) -> bool:
    text = value.strip()
    if text in {"***", "---", "# # #"}:
        return True
    return bool(re.fullmatch(r"[*_\-]{3,}", text))


def chapter_blocks(content: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    paragraph_index = 0
    scene_index = 0

    for match in re.finditer(r"\S(?:.*?)(?=\n\s*\n|\Z)", content or "", re.DOTALL):
        text = match.group(0).strip()
        if not text:
            continue

        if is_scene_break(text):
            scene_index += 1
            block_type = "sceneBreak"
            block_id = f"s_{scene_index:03d}"
            block_index: int | None = scene_index
        else:
            paragraph_index += 1
            block_type = "paragraph"
            block_id = f"p_{paragraph_index:03d}"
            block_index = paragraph_index

        blocks.append(
            {
                "blockId": block_id,
                "type": block_type,
                "index": block_index,
                "text": text,
                "preview": text[:140],
                "startChar": match.start(),
                "endChar": match.start() + len(match.group(0).rstrip()),
                "textHash": text_hash(text),
            }
        )

    return blocks


def block_map_for_prompt(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "blockId": block["blockId"],
            "type": block["type"],
            "index": block["index"],
            "preview": block["preview"],
            "startChar": block["startChar"],
            "endChar": block["endChar"],
            "textHash": block["textHash"],
        }
        for block in blocks
    ]


def parse_chapter_operation(raw_output: str) -> dict[str, Any]:
    candidates = [raw_output.strip(), strip_json_fence(raw_output)]
    try:
        candidates.append(first_json_object(candidates[-1]))
    except ValueError:
        pass

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed

    raise ValueError("model did not return a valid chapter edit operation")


def clean_insert_text(value: Any) -> str:
    return str(value or "").strip()


def operation_text(operation: dict[str, Any]) -> str:
    if "newText" in operation:
        return clean_insert_text(operation.get("newText"))

    new_blocks = operation.get("newBlocks")
    if isinstance(new_blocks, list):
        parts = []
        for block in new_blocks:
            if isinstance(block, dict):
                text = clean_insert_text(block.get("text"))
            else:
                text = clean_insert_text(block)
            if text:
                parts.append(text)
        return "\n\n".join(parts)

    return clean_insert_text(operation.get("text"))


def expected_hash_for(operation: dict[str, Any], block_id: str) -> str:
    expected_hashes = operation.get("expectedTextHashes")
    if isinstance(expected_hashes, dict):
        return str(expected_hashes.get(block_id) or "")
    return str(operation.get("expectedTextHash") or "")


def require_matching_block(
    blocks_by_id: dict[str, dict[str, Any]], operation: dict[str, Any], block_id: str
) -> dict[str, Any]:
    block = blocks_by_id.get(block_id)
    if not block:
        raise ValueError(f"unknown block id: {block_id}")

    expected_hash = expected_hash_for(operation, block_id)
    if not expected_hash:
        raise ValueError(f"missing expectedTextHash for {block_id}")
    if expected_hash != block["textHash"]:
        raise ValueError(f"text hash mismatch for {block_id}")

    return block


def insert_with_spacing(content: str, position: int, text: str, placement: str) -> str:
    insert_text = clean_insert_text(text)
    if not insert_text:
        raise ValueError("new text cannot be empty")
    if not content.strip():
        return insert_text
    if placement == "before":
        if position <= 0:
            return f"{insert_text}\n\n{content}"
        return f"{content[:position]}{insert_text}\n\n{content[position:]}"
    if position >= len(content):
        return f"{content.rstrip()}\n\n{insert_text}"
    return f"{content[:position].rstrip()}\n\n{insert_text}\n\n{content[position:].lstrip()}"


def apply_chapter_operation(content: str, operation: dict[str, Any]) -> dict[str, Any]:
    blocks = chapter_blocks(content)
    blocks_by_id = {block["blockId"]: block for block in blocks}
    operation_type = str(operation.get("operation") or operation.get("type") or "").strip()

    if operation_type == "appendToChapter":
        new_text = operation_text(operation)
        next_content = insert_with_spacing(content, len(content), new_text, "after")
        return {
            "content": next_content,
            "operation": operation_type,
            "deletedBlockIds": [],
            "insertedBlockIds": [],
            "appliedText": new_text,
        }

    if operation_type in {"insertBeforeBlock", "insertAfterBlock"}:
        block_id = str(operation.get("blockId") or "").strip()
        block = require_matching_block(blocks_by_id, operation, block_id)
        new_text = operation_text(operation)
        position = block["startChar"] if operation_type == "insertBeforeBlock" else block["endChar"]
        next_content = insert_with_spacing(
            content,
            position,
            new_text,
            "before" if operation_type == "insertBeforeBlock" else "after",
        )
        return {
            "content": next_content,
            "operation": operation_type,
            "deletedBlockIds": [],
            "insertedBlockIds": [],
            "appliedText": new_text,
        }

    if operation_type == "replaceBlock":
        block_id = str(operation.get("blockId") or "").strip()
        block = require_matching_block(blocks_by_id, operation, block_id)
        new_text = operation_text(operation)
        if not new_text:
            raise ValueError("new text cannot be empty")
        next_content = f"{content[:block['startChar']]}{new_text}{content[block['endChar']:]}"
        return {
            "content": next_content,
            "operation": operation_type,
            "deletedBlockIds": [block_id],
            "insertedBlockIds": [block_id],
            "appliedText": new_text,
        }

    if operation_type == "replaceBlocks":
        block_ids = operation.get("blockIds")
        if not isinstance(block_ids, list) or not block_ids:
            raise ValueError("replaceBlocks needs blockIds")

        selected = [
            require_matching_block(blocks_by_id, operation, str(block_id).strip())
            for block_id in block_ids
        ]
        selected.sort(key=lambda block: block["startChar"])
        selected_ids = [block["blockId"] for block in selected]
        expected_ids = [str(block_id).strip() for block_id in block_ids]
        if selected_ids != expected_ids:
            raise ValueError("replaceBlocks blockIds must be in chapter order")

        block_positions = {block["blockId"]: index for index, block in enumerate(blocks)}
        for left, right in zip(selected, selected[1:]):
            if block_positions[right["blockId"]] != block_positions[left["blockId"]] + 1:
                raise ValueError("replaceBlocks blockIds must be contiguous")

        new_text = operation_text(operation)
        if not new_text:
            raise ValueError("new text cannot be empty")
        start = selected[0]["startChar"]
        end = selected[-1]["endChar"]
        next_content = f"{content[:start]}{new_text}{content[end:]}"
        return {
            "content": next_content,
            "operation": operation_type,
            "deletedBlockIds": selected_ids,
            "insertedBlockIds": selected_ids,
            "appliedText": new_text,
        }

    raise ValueError(f"unsupported chapter operation: {operation_type or 'missing'}")


def append_chapter_text(content: str, text: str) -> dict[str, Any]:
    new_text = clean_insert_text(text)
    next_content = insert_with_spacing(content, len(content), new_text, "after")
    return {
        "content": next_content,
        "operation": "appendToChapter",
        "deletedBlockIds": [],
        "insertedBlockIds": [],
        "appliedText": new_text,
    }


def effective_generation_mode(requested_mode: str | None, chapter_content: str) -> str:
    mode = str(requested_mode or "new").lower()
    if mode not in {"edit", "new"}:
        mode = "new"
    if mode == "edit" and not chapter_content.strip():
        return "new"
    return mode


def parse_lorebook_json(raw_output: str) -> dict[str, Any]:
    parse_errors: list[str] = []
    candidates = [raw_output.strip(), strip_json_fence(raw_output)]

    try:
        candidates.append(first_json_object(candidates[-1]))
    except ValueError as exc:
        parse_errors.append(str(exc))

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError as exc:
            parse_errors.append(str(exc))
            continue
        if isinstance(parsed, dict):
            return parsed
        parse_errors.append("Lorebook output JSON was not an object.")

    raise ValueError("; ".join(parse_errors) or "Could not parse lorebook JSON.")


def parse_brainstorm_ideas(raw_output: str) -> list[dict[str, str]]:
    try:
        parsed = parse_lorebook_json(raw_output)
    except ValueError as exc:
        raise ValueError("Could not parse the brainstorm ideas response.") from exc
    raw_ideas = parsed.get("ideas")
    if not isinstance(raw_ideas, list):
        raise ValueError("Brainstorm output must contain an ideas array.")

    ideas: list[dict[str, str]] = []
    for raw_idea in raw_ideas[:5]:
        if not isinstance(raw_idea, dict):
            continue
        title = str(raw_idea.get("title") or "").strip()
        content = str(raw_idea.get("content") or "").strip()
        if title and content:
            ideas.append({"title": title, "content": content})

    if not ideas:
        raise ValueError("Brainstorm output must contain at least one complete idea.")
    return ideas


def request_updates(payload: BaseModel, reject_null: bool = False) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        updates = payload.model_dump(exclude_unset=True)
    else:
        updates = payload.dict(exclude_unset=True)

    if reject_null:
        null_fields = [key for key, value in updates.items() if value is None]
        if null_fields:
            raise HTTPException(
                status_code=422,
                detail=f"Fields cannot be null: {', '.join(null_fields)}.",
            )
    return updates


def row_to_story(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "author": row["author"],
        "language": row["language"],
        "synopsis": row["synopsis"],
        "model": row["model"],
        "system_prompt": row["system_prompt"],
        "temperature": row["temperature"],
        "max_tokens": row["max_tokens"],
        "thinking_enabled": bool(row["thinking_enabled"]),
        "reasoning_effort": row["reasoning_effort"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_chapter(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "title": row["title"],
        "content": row["content"],
        "word_count": row["word_count"],
        "order_index": row["order_index"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_chapter_history_entry(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "chapter_id": row["chapter_id"],
        "run_id": row["run_id"],
        "label": row["label"],
        "detail": row["detail"],
        "entry_order": row["entry_order"],
        "created_at": row["created_at"],
    }


def row_to_lorebook_entry(row: sqlite3.Row) -> dict[str, Any]:
    category = normalize_lorebook_category(row["category"])
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "name": row["name"],
        "category": category,
        "description": row["description"],
        "aliases": sanitize_lorebook_aliases(category, json_list(row["aliases_json"]), row["name"]),
        "tags": json_list(row["tags_json"]),
        "metadata": sanitize_lorebook_metadata(category, json_dict(row["metadata_json"])),
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_story_generation(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "chapter_id": row["chapter_id"],
        "model": row["model"],
        "generation_id": row["generation_id"],
        "prompt_tokens": row["prompt_tokens"],
        "completion_tokens": row["completion_tokens"],
        "reasoning_tokens": row["reasoning_tokens"],
        "total_tokens": row["total_tokens"],
        "cost": row["cost"],
        "provider_name": row["provider_name"],
        "generation_time": row["generation_time"],
        "latency": row["latency"],
        "created_at": row["created_at"],
    }


def row_to_brainstorm_node(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "node_type": row["node_type"],
        "title": row["title"],
        "content": row["content"],
        "position_x": row["position_x"],
        "position_y": row["position_y"],
        "status": row["status"],
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
    chapter_text = "\n\n".join(
        f"chapter {index + 1}: {chapter['title']}\n{chapter['content'] or 'empty chapter'}"
        for index, chapter in enumerate(chapters)
    ) or "no chapters yet"
    lorebook_text = "\n".join(
        f"- {row['name']} ({row['category']}): {row['description']}"
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
        f"all chapters:\n{chapter_text}\n\n"
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


def next_chapter_order(conn: sqlite3.Connection, story_id: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order
        FROM chapters
        WHERE story_id = ?
        """,
        (story_id,),
    ).fetchone()
    return int(row["next_order"])


def next_chapter_history_order(conn: sqlite3.Connection, chapter_id: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(entry_order), -1) + 1 AS next_order
        FROM chapter_history_entries
        WHERE chapter_id = ?
        """,
        (chapter_id,),
    ).fetchone()
    return int(row["next_order"])


def insert_chapter_history_entry(
    conn: sqlite3.Connection,
    *,
    story_id: str,
    chapter_id: str,
    run_id: str,
    label: str,
    detail: str,
    now: str,
) -> dict[str, Any]:
    entry_id = str(uuid.uuid4())
    entry_order = next_chapter_history_order(conn, chapter_id)
    conn.execute(
        """
        INSERT INTO chapter_history_entries (
          id, story_id, chapter_id, run_id, label, detail, entry_order, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (entry_id, story_id, chapter_id, run_id, label, detail, entry_order, now),
    )
    return {
        "id": entry_id,
        "story_id": story_id,
        "chapter_id": chapter_id,
        "run_id": run_id,
        "label": label,
        "detail": detail,
        "entry_order": entry_order,
        "created_at": now,
    }


def build_story_messages(
    story: sqlite3.Row,
    chapter: sqlite3.Row,
    lorebook_rows: list[sqlite3.Row],
    prompt: str,
    system_prompt: str,
    generation_mode: str = "new",
    blocks: list[dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    lorebook_text = "\n".join(
        f"- {row['name']} ({row['category']}): {row['description']}"
        for row in lorebook_rows
        if not bool(row["disabled"]) and row["description"].strip()
    )
    context_parts = [
        f"story title: {story['title']}",
        f"author: {story['author'] or 'unknown'}",
        f"language: {story['language'] or 'English'}",
        f"synopsis: {story['synopsis'] or 'none yet'}",
        f"chapter title: {chapter['title']}",
        f"current chapter draft:\n{chapter['content'] or 'empty chapter'}",
    ]
    if generation_mode == "edit":
        context_parts.append(
            "chapter block map:\n"
            + json.dumps(block_map_for_prompt(blocks or []), ensure_ascii=False, indent=2)
        )
    if lorebook_text:
        context_parts.append(f"lorebook:\n{lorebook_text}")

    messages: list[dict[str, str]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    if generation_mode == "edit":
        messages.append(
            {
                "role": "system",
                "content": (
                    "You are editing the active chapter using a JSON operation. Return only one "
                    "JSON object and no analysis or wrapper text. Supported operations are "
                    "replaceBlock, replaceBlocks, insertBeforeBlock, insertAfterBlock, and "
                    "appendToChapter. For replaceBlock include operation, blockId, "
                    "expectedTextHash, and newText. For replaceBlocks include operation, blockIds, "
                    "expectedTextHashes, and either newText or newBlocks. For inserts include "
                    "operation, blockId, expectedTextHash, and newText. For appendToChapter include "
                    "operation and newText. Replacement operations delete the targeted text first "
                    "and insert the replacement in the same position. Do not preserve, duplicate, "
                    "append beside, or restate replaced text unless the user explicitly asks for it. "
                    "Use the block map to resolve references like 4th paragraph; paragraph indexes "
                    "are 1-based."
                ),
            }
        )
    else:
        messages.append(
            {
                "role": "system",
                "content": (
                    "You are writing prose for the active chapter. Return only the prose "
                    "to insert into the chapter, with no analysis or wrapper text."
                ),
            }
        )
    messages.append({"role": "user", "content": "\n\n".join(context_parts)})
    messages.append({"role": "user", "content": prompt})
    return messages


def apply_lorebook_updates(
    conn: sqlite3.Connection, story_id: str, updates: list[dict[str, Any]], now: str
) -> list[dict[str, Any]]:
    applied: list[dict[str, Any]] = []
    for update in updates:
        action = str(update.get("action") or "create").lower()
        name = str(update.get("name") or "").strip()
        category = normalize_lorebook_category(update.get("category"))
        if category == "timeline":
            name = "Timeline"
            action = "update"
        if not name:
            continue
        description = str(update.get("description") or "").strip()
        if category == "timeline":
            description = normalize_timeline_description(description)
        aliases = sanitize_lorebook_aliases(category, update.get("aliases"), name)
        tags = update.get("tags") if isinstance(update.get("tags"), list) else []
        metadata = sanitize_lorebook_metadata(category, update.get("metadata"))

        if category == "timeline":
            existing = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ? AND lower(name) = lower('Timeline')
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()
        else:
            existing = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ? AND lower(name) = lower(?)
                LIMIT 1
                """,
                (story_id, name),
            ).fetchone()

        if action == "update" and existing:
            next_description = description or existing["description"]
            conn.execute(
                """
                UPDATE lorebook_entries
                SET category = ?, description = ?, aliases_json = ?, tags_json = ?,
                    metadata_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    category,
                    next_description,
                    json.dumps(aliases),
                    json.dumps(tags),
                    json.dumps(metadata),
                    now,
                    existing["id"],
                ),
            )
            applied.append({"action": "update", "id": existing["id"], "name": name})
            continue

        if existing:
            continue

        entry_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO lorebook_entries (
              id, story_id, name, category, description, aliases_json,
              tags_json, metadata_json, disabled, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?,  ?, 0, ?, ?)
            """,
            (
                entry_id,
                story_id,
                name,
                category,
                description,
                json.dumps(aliases),
                json.dumps(tags),
                json.dumps(metadata),
                now,
                now,
            ),
        )
        applied.append({"action": "create", "id": entry_id, "name": name})
    return applied


def create_writing_router(deps: WritingDeps) -> APIRouter:
    router = APIRouter()
    StreamMessageRequest = deps.stream_message_request

    def get_story_bundle(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
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
            lorebook = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ?
                ORDER BY updated_at DESC, created_at DESC
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
            latest_generation = conn.execute(
                """
                SELECT * FROM story_generations
                WHERE story_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()
        history_by_chapter: dict[str, list[dict[str, Any]]] = {}
        for row in history_rows:
            history_by_chapter.setdefault(row["chapter_id"], []).append(
                row_to_chapter_history_entry(row)
            )
        chapter_payloads = []
        for row in chapters:
            chapter = row_to_chapter(row)
            chapter["history"] = history_by_chapter.get(row["id"], [])
            chapter_payloads.append(chapter)

        return {
            "story": row_to_story(story),
            "chapters": chapter_payloads,
            "lorebook": [row_to_lorebook_entry(row) for row in lorebook],
            "latest_generation": (
                row_to_story_generation(latest_generation) if latest_generation else None
            ),
        }

    async def update_lorebook_after_generation(
        story_id: str,
        chapter_id: str,
        generation_row_id: str,
        model: str,
        max_tokens: int,
        generated_text: str,
    ) -> dict[str, Any]:
        api_key = deps.read_openrouter_key()
        if not api_key or not generated_text.strip():
            return {"applied": []}

        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
            lorebook = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY updated_at DESC",
                (story_id,),
            ).fetchall()

        current_lore = "\n".join(
            f"- {row['name']} ({row['category']}): {row['description']}"
            for row in lorebook
            if not bool(row["disabled"])
        )
        prompt = {
            "story": row_to_story(story),
            "chapter": {"title": chapter["title"]},
            "existing_lorebook": current_lore,
            "new_prose": generated_text,
        }
        messages = [
            {
                "role": "system",
                "content": (
                    "Extract important durable lore from new prose. Return strict JSON only: "
                    "{\"updates\":[{\"action\":\"create|update\",\"name\":\"\","
                    "\"category\":\"character|location|item|event|note|synopsis|timeline\","
                    "\"description\":\"\",\"aliases\":[],\"tags\":[],\"metadata\":{}}]}. "
                    "The aliases array is only for nicknames, shortened names, titles used as "
                    "names, or alternate names explicitly used in the story to refer to this "
                    "entry. Do not put jobs, roles, species, traits, descriptions, "
                    "relationships, or categories in aliases. For note and synopsis entries, "
                    "aliases must be empty. Put character details like age, detailed physical "
                    "appearance, personality, and background into description instead of "
                    "metadata fields. "
                    "For story chronology, create or update exactly one timeline entry named "
                    "\"Timeline\" with category \"timeline\". Its description must be a "
                    "chronological Markdown bullet list. Merge new events into the existing "
                    "timeline instead of duplicating bullets. Keep each entry concise and "
                    "information-dense. Do not copy prose style from the story. Prefer short "
                    "factual summaries over long paragraphs. Preserve important concrete "
                    "details, but omit transient action, mood, and wording that does not "
                    "matter for continuity. Timeline bullets should be brief, one event per "
                    "bullet. Add only new durable events or necessary corrections."
                ),
            },
            {"role": "user", "content": json.dumps(prompt)},
        ]
        raw_output = ""
        error_text: str | None = None
        applied: list[dict[str, Any]] = []
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(
                    f"{deps.openrouter_base_url}/chat/completions",
                    headers={**deps.headers_for_key(api_key), "Content-Type": "application/json"},
                    json={
                        "model": deps.openrouter_request_model(model, False),
                        "messages": messages,
                        "temperature": 0.1,
                        "max_tokens": max_tokens,
                    },
                )
            if response.status_code >= 400:
                error_text = deps.openrouter_error_message(response.status_code, response.text)
            else:
                raw_output = (
                    response.json()
                    .get("choices", [{}])[0]
                    .get("message", {})
                    .get("content")
                    or ""
                )
                parsed = parse_lorebook_json(raw_output)
                updates = parsed.get("updates") if isinstance(parsed, dict) else []
                if not isinstance(updates, list):
                    updates = []
                with deps.get_db() as conn:
                    applied = apply_lorebook_updates(conn, story_id, updates, deps.utc_now())
        except Exception as exc:  # noqa: BLE001
            error_text = str(exc)

        with deps.get_db() as conn:
            conn.execute(
                """
                INSERT INTO lorebook_update_runs (
                  id, story_id, chapter_id, generation_id, raw_output,
                  applied_updates_json, error, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    story_id,
                    chapter_id,
                    generation_row_id,
                    raw_output or "",
                    json.dumps(applied),
                    error_text,
                    deps.utc_now(),
                ),
            )
        return {"applied": applied, "error": error_text}

    async def stream_story_generation(
        story_id: str,
        chapter_id: str,
        payload: StreamMessageRequest,
        story: sqlite3.Row,
        chapter: sqlite3.Row,
        lorebook_rows: list[sqlite3.Row],
    ) -> AsyncIterator[bytes]:
        api_key = deps.read_openrouter_key()
        if not api_key:
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

        generation_mode = effective_generation_mode(
            getattr(payload, "write_generation_mode", None),
            chapter["content"] or "",
        )
        starting_blocks = chapter_blocks(chapter["content"] or "") if generation_mode == "edit" else []

        messages = build_story_messages(
            story,
            chapter,
            lorebook_rows,
            payload.message,
            deps.write_system_prompt(payload),
            generation_mode,
            starting_blocks,
        )
        body: dict[str, Any] = {
            "model": deps.openrouter_request_model(payload.model, payload.nitro_mode),
            "messages": messages,
            "temperature": payload.temperature,
            "max_tokens": payload.max_tokens,
            "stream": True,
        }
        if deps.model_supports_reasoning(payload.model) and payload.thinking_enabled:
            body["reasoning"] = {
                "enabled": True,
                "exclude": False,
                "effort": payload.reasoning_effort,
            }

        generated_text: list[str] = []
        reasoning_text: list[str] = []
        finish_reason: str | None = None
        error_text: str | None = None
        generation_id: str | None = None
        usage: dict[str, Any] | None = None
        story_generation_id = str(uuid.uuid4())
        history_run_id = str(uuid.uuid4())
        model_label = display_model_name(payload.model)
        reasoning_started_at: float | None = None
        content_started_at: float | None = None

        def save_history(label: str, detail: str = "") -> dict[str, Any]:
            with deps.get_db() as conn:
                return insert_chapter_history_entry(
                    conn,
                    story_id=story_id,
                    chapter_id=chapter_id,
                    run_id=history_run_id,
                    label=label,
                    detail=detail,
                    now=deps.utc_now(),
                )

        try:
            yield deps.stream_event(
                "history",
                save_history("User prompt", " ".join(payload.message.split())),
            )
            async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    f"{deps.openrouter_base_url}/chat/completions",
                    headers={**deps.headers_for_key(api_key), "Content-Type": "application/json"},
                    json=body,
                ) as response:
                    if response.status_code >= 400:
                        raw_error = (await response.aread()).decode("utf-8", errors="replace")
                        error_text = deps.openrouter_error_message(response.status_code, raw_error)
                        yield deps.stream_event("error", error_text)
                        return
                    generation_id = response.headers.get("X-Generation-Id") or generation_id

                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        generation_id = generation_id or chunk.get("id")
                        next_usage = deps.normalize_usage(chunk.get("usage"))
                        if next_usage:
                            usage = next_usage
                            continue
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finish_reason = choice.get("finish_reason") or finish_reason
                        delta = choice.get("delta") or {}
                        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                        if reasoning and payload.thinking_enabled:
                            if reasoning_started_at is None:
                                reasoning_started_at = time.perf_counter()
                            value = str(reasoning)
                            reasoning_text.append(value)
                            yield deps.stream_event("reasoning", value)
                        content = delta.get("content")
                        if content:
                            if reasoning_started_at is not None:
                                duration_ms = (time.perf_counter() - reasoning_started_at) * 1000
                                yield deps.stream_event(
                                    "history",
                                    save_history(
                                        f"{model_label} thought for {format_duration(duration_ms)}"
                                    ),
                                )
                                reasoning_started_at = None
                            if content_started_at is None:
                                content_started_at = time.perf_counter()
                            value = str(content)
                            generated_text.append(value)
                            yield deps.stream_event("content", value)

                    if generation_id:
                        generation_usage = await deps.fetch_generation_usage(api_key, generation_id)
                        if generation_usage:
                            usage = {**(usage or {}), **generation_usage}
                    if usage:
                        yield deps.stream_event(
                            "usage",
                            {"generation_id": generation_id, "model": payload.model, **usage},
                        )
        except Exception as exc:  # noqa: BLE001
            error_text = str(exc)
            yield deps.stream_event("error", f"RouterChat error: {error_text}")
        finally:
            content = "".join(generated_text)
            now = deps.utc_now()
            content_for_lorebook = content
            chapter_update_event: dict[str, Any] | None = None
            with deps.get_db() as conn:
                current = conn.execute(
                    "SELECT content FROM chapters WHERE id = ? AND story_id = ?",
                    (chapter_id, story_id),
                ).fetchone()
                current_content = current["content"] if current else ""
                if content:
                    if generation_mode == "edit":
                        try:
                            try:
                                operation = parse_chapter_operation(content)
                            except ValueError:
                                operation = {"operation": "appendToChapter", "newText": content}
                            operation_result = apply_chapter_operation(current_content, operation)
                            next_content = operation_result["content"]
                            content_for_lorebook = operation_result.get("appliedText") or content
                            chapter_update_event = {
                                "content": next_content,
                                "operation": operation_result["operation"],
                                "deletedBlockIds": operation_result["deletedBlockIds"],
                                "insertedBlockIds": operation_result["insertedBlockIds"],
                            }
                            conn.execute(
                                """
                                UPDATE chapters
                                SET content = ?, word_count = ?, updated_at = ?
                                WHERE id = ? AND story_id = ?
                                """,
                                (
                                    next_content,
                                    word_count(next_content),
                                    now,
                                    chapter_id,
                                    story_id,
                                ),
                            )
                        except ValueError as exc:
                            error_text = str(exc)
                            content_for_lorebook = ""
                            yield deps.stream_event("error", f"Chapter edit skipped: {error_text}")
                    else:
                        operation_result = append_chapter_text(current_content, content)
                        next_content = operation_result["content"]
                        conn.execute(
                            """
                            UPDATE chapters
                            SET content = ?, word_count = ?, updated_at = ?
                            WHERE id = ? AND story_id = ?
                            """,
                            (next_content, word_count(next_content), now, chapter_id, story_id),
                        )
                        chapter_update_event = {
                            "content": next_content,
                            "operation": operation_result["operation"],
                            "deletedBlockIds": operation_result["deletedBlockIds"],
                            "insertedBlockIds": operation_result["insertedBlockIds"],
                        }
                conn.execute(
                    """
                    INSERT INTO story_generations (
                      id, story_id, chapter_id, prompt, generated_text, model,
                      finish_reason, error, generation_id, prompt_tokens,
                      completion_tokens, reasoning_tokens, total_tokens, cost,
                      provider_name, generation_time, latency, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        story_generation_id,
                        story_id,
                        chapter_id,
                        payload.message,
                        content,
                        payload.model,
                        finish_reason,
                        error_text,
                        generation_id,
                        usage.get("prompt_tokens") if usage else None,
                        usage.get("completion_tokens") if usage else None,
                        usage.get("reasoning_tokens") if usage else None,
                        usage.get("total_tokens") if usage else None,
                        usage.get("cost") if usage else None,
                        usage.get("provider_name") if usage else None,
                        usage.get("generation_time") if usage else None,
                        usage.get("latency") if usage else None,
                        now,
                    ),
                )
                conn.execute(
                    "UPDATE stories SET updated_at = ? WHERE id = ?",
                    (now, story_id),
                )
            if content:
                if chapter_update_event is not None:
                    yield deps.stream_event("chapter_updated", chapter_update_event)
                if content_started_at is not None:
                    duration_ms = (time.perf_counter() - content_started_at) * 1000
                    yield deps.stream_event(
                        "history",
                        save_history(f"{model_label} wrote for {format_duration(duration_ms)}"),
                    )
                    content_started_at = None
                lorebook_started_at = time.perf_counter()
                yield deps.stream_event("lorebook_start", {"generation_id": story_generation_id})
            else:
                lorebook_started_at = None
            lorebook_result = await update_lorebook_after_generation(
                story_id,
                chapter_id,
                story_generation_id,
                payload.model,
                payload.max_tokens,
                content_for_lorebook,
            )
            for update in lorebook_result.get("applied") or []:
                yield deps.stream_event(
                    "history",
                    save_history(lorebook_history_label(model_label, update)),
                )
            if lorebook_started_at is not None:
                duration_ms = (time.perf_counter() - lorebook_started_at) * 1000
                yield deps.stream_event(
                    "history",
                    save_history(
                        f"{model_label} finished editing Lorebook after {format_duration(duration_ms)}"
                    ),
                )
            yield deps.stream_event("lorebook", lorebook_result)

    @router.get("/api/stories")
    def list_stories() -> dict[str, Any]:
        with deps.get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM stories ORDER BY updated_at DESC, created_at DESC"
            ).fetchall()
        return {"stories": [row_to_story(row) for row in rows]}

    @router.post("/api/stories")
    def create_story(payload: StoryCreateRequest) -> dict[str, Any]:
        now = deps.utc_now()
        story_id = str(uuid.uuid4())
        model = payload.model or deps.default_model_id()
        with deps.get_db() as conn:
            conn.execute(
                """
                INSERT INTO stories (
                  id, title, author, language, synopsis, model, system_prompt,
                  temperature, max_tokens, thinking_enabled, reasoning_effort,
                  created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    story_id,
                    payload.title.strip() or "New story",
                    payload.author,
                    payload.language,
                    payload.synopsis,
                    model,
                    payload.system_prompt,
                    payload.temperature,
                    payload.max_tokens,
                    int(payload.thinking_enabled),
                    payload.reasoning_effort,
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        return {"story": row_to_story(row)}

    @router.get("/api/stories/{story_id}")
    def get_story(story_id: str) -> dict[str, Any]:
        return get_story_bundle(story_id)

    @router.patch("/api/stories/{story_id}")
    def update_story(story_id: str, payload: StoryPatchRequest) -> dict[str, Any]:
        updates = request_updates(payload, reject_null=True)
        if not updates:
            return get_story_bundle(story_id)
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in updates.items():
            if key == "thinking_enabled":
                value = int(bool(value))
            if key == "title":
                value = str(value).strip() or "New story"
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        values.append(deps.utc_now())
        values.append(story_id)
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            conn.execute(f"UPDATE stories SET {', '.join(assignments)} WHERE id = ?", values)
        return get_story_bundle(story_id)

    @router.delete("/api/stories/{story_id}")
    def delete_story(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            conn.execute("DELETE FROM brainstorm_generations WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM brainstorm_edges WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM brainstorm_nodes WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM brainstorm_viewports WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM lorebook_update_runs WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM story_generations WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM lorebook_entries WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM chapters WHERE story_id = ?", (story_id,))
            result = conn.execute("DELETE FROM stories WHERE id = ?", (story_id,))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Story not found.")
        return {"ok": True}

    @router.get("/api/stories/{story_id}/chapters")
    def list_chapters(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
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
        now = deps.utc_now()
        chapter_id = str(uuid.uuid4())
        content = payload.content
        with deps.get_db() as conn:
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
        if "content" in updates:
            updates["word_count"] = word_count(updates["content"])
        if "title" in updates:
            updates["title"] = str(updates["title"]).strip() or "New chapter"
        if not updates:
            return get_story_bundle(story_id)
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in updates.items():
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        values.append(deps.utc_now())
        values.extend([chapter_id, story_id])
        with deps.get_db() as conn:
            chapter = conn.execute(
                "SELECT id FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
            if not chapter:
                raise HTTPException(status_code=404, detail="Chapter not found.")
            conn.execute(
                f"UPDATE chapters SET {', '.join(assignments)} WHERE id = ? AND story_id = ?",
                values,
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
            ChapterPatchRequest(content=payload.content),
        )

    @router.delete("/api/stories/{story_id}/chapters/{chapter_id}")
    def delete_chapter(story_id: str, chapter_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            result = conn.execute(
                "DELETE FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Chapter not found.")
        return {"ok": True}

    @router.get("/api/stories/{story_id}/lorebook")
    def list_lorebook_entries(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            rows = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ?
                ORDER BY updated_at DESC, created_at DESC
                """,
                (story_id,),
            ).fetchall()
        return {"entries": [row_to_lorebook_entry(row) for row in rows]}

    @router.post("/api/stories/{story_id}/lorebook")
    def create_lorebook_entry(story_id: str, payload: LorebookEntryRequest) -> dict[str, Any]:
        now = deps.utc_now()
        entry_id = str(uuid.uuid4())
        category = normalize_lorebook_category(payload.category)
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            conn.execute(
                """
                INSERT INTO lorebook_entries (
                  id, story_id, name, category, description, aliases_json,
                  tags_json, metadata_json, disabled, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry_id,
                    story_id,
                    payload.name.strip(),
                    category,
                    (
                        normalize_timeline_description(payload.description)
                        if category == "timeline"
                        else payload.description
                    ),
                    json.dumps(sanitize_lorebook_aliases(category, payload.aliases, payload.name.strip())),
                    json.dumps(payload.tags),
                    json.dumps(sanitize_lorebook_metadata(category, payload.metadata)),
                    int(payload.disabled),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM lorebook_entries WHERE id = ?", (entry_id,)).fetchone()
        return {"entry": row_to_lorebook_entry(row)}

    @router.patch("/api/stories/{story_id}/lorebook/{entry_id}")
    def update_lorebook_entry(
        story_id: str, entry_id: str, payload: LorebookEntryRequest
    ) -> dict[str, Any]:
        now = deps.utc_now()
        category = normalize_lorebook_category(payload.category)
        with deps.get_db() as conn:
            entry = conn.execute(
                "SELECT id FROM lorebook_entries WHERE id = ? AND story_id = ?",
                (entry_id, story_id),
            ).fetchone()
            if not entry:
                raise HTTPException(status_code=404, detail="Lorebook entry not found.")
            conn.execute(
                """
                UPDATE lorebook_entries
                SET name = ?, category = ?, description = ?, aliases_json = ?,
                    tags_json = ?, metadata_json = ?, disabled = ?, updated_at = ?
                WHERE id = ? AND story_id = ?
                """,
                (
                    payload.name.strip(),
                    category,
                    (
                        normalize_timeline_description(payload.description)
                        if category == "timeline"
                        else payload.description
                    ),
                    json.dumps(sanitize_lorebook_aliases(category, payload.aliases, payload.name.strip())),
                    json.dumps(payload.tags),
                    json.dumps(sanitize_lorebook_metadata(category, payload.metadata)),
                    int(payload.disabled),
                    now,
                    entry_id,
                    story_id,
                ),
            )
            row = conn.execute("SELECT * FROM lorebook_entries WHERE id = ?", (entry_id,)).fetchone()
        return {"entry": row_to_lorebook_entry(row)}

    @router.delete("/api/stories/{story_id}/lorebook/{entry_id}")
    def delete_lorebook_entry(story_id: str, entry_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            result = conn.execute(
                "DELETE FROM lorebook_entries WHERE id = ? AND story_id = ?",
                (entry_id, story_id),
            )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Lorebook entry not found.")
        return {"ok": True}

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
            latest_generation = conn.execute(
                """
                SELECT * FROM brainstorm_generations
                WHERE story_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()

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
            "nodes": [row_to_brainstorm_node(row) for row in nodes],
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
        if deps.model_supports_reasoning(payload.model) and payload.thinking_enabled:
            body["reasoning"] = {
                "enabled": True,
                "exclude": False,
                "effort": payload.reasoning_effort,
            }

        generated_text: list[str] = []
        generation_id: str | None = None
        finish_reason: str | None = None
        usage: dict[str, Any] = {}
        saved_generation = False

        def save_generation(status: str, error: str | None = None) -> None:
            nonlocal saved_generation
            if saved_generation:
                return
            saved_generation = True
            with deps.get_db() as conn:
                conn.execute(
                    "UPDATE brainstorm_nodes SET status = ?, updated_at = ? WHERE id = ?",
                    (status, deps.utc_now(), prompt_node_id),
                )
                conn.execute(
                    """
                    INSERT INTO brainstorm_generations (
                      id, story_id, prompt_node_id, prompt, model, finish_reason, error,
                      generation_id, prompt_tokens, completion_tokens, reasoning_tokens,
                      total_tokens, cost, provider_name, generation_time, latency, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        generation_row_id,
                        story_id,
                        prompt_node_id,
                        payload.message,
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
            yield deps.stream_event(
                "prompt",
                {
                    "node": row_to_brainstorm_node(prompt_node),
                    "edges": [row_to_brainstorm_edge(edge) for edge in prompt_edges],
                },
            )
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
                        if reasoning and payload.thinking_enabled:
                            yield deps.stream_event("reasoning", str(reasoning))
                        content = delta.get("content")
                        if content:
                            generated_text.append(str(content))

            if generation_id:
                generation_usage = await deps.fetch_generation_usage(api_key, generation_id)
                if generation_usage:
                    usage.update(generation_usage)

            ideas = parse_brainstorm_ideas("".join(generated_text))
            if len(ideas) < payload.brainstorm_idea_count:
                raise ValueError(
                    f"Brainstorm output returned {len(ideas)} ideas instead of "
                    f"{payload.brainstorm_idea_count}."
                )
            ideas = ideas[:payload.brainstorm_idea_count]
            prompt_x = float(prompt_node["position_x"])
            prompt_y = float(prompt_node["position_y"])
            child_x = prompt_x + 390
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
                "ideas", {"nodes": created_nodes, "edges": created_edges}
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
                prompt_x = max(float(nodes_by_id[node_id]["position_x"]) for node_id in selected_ids) + 390
                prompt_y = sum(
                    float(nodes_by_id[node_id]["position_y"]) for node_id in selected_ids
                ) / len(selected_ids)
            else:
                root_nodes = [
                    row for row in all_nodes
                    if not any(edge["target_node_id"] == row["id"] for edge in all_edges)
                ]
                prompt_x = 0
                prompt_y = max((float(row["position_y"]) for row in root_nodes), default=-100) + 280

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

    @router.post("/api/stories/{story_id}/chapters/{chapter_id}/generate/stream")
    async def stream_story_chapter_generation(
        story_id: str,
        chapter_id: str,
        payload: StreamMessageRequest,
    ) -> StreamingResponse:
        if not deps.read_openrouter_key():
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
        if not payload.message.strip():
            raise HTTPException(status_code=400, detail="Message cannot be empty.")

        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
            if not chapter:
                raise HTTPException(status_code=404, detail="Chapter not found.")
            lorebook_rows = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY updated_at DESC",
                (story_id,),
            ).fetchall()
            conn.execute(
                """
                UPDATE stories
                SET model = ?, system_prompt = ?, temperature = ?, max_tokens = ?,
                    thinking_enabled = ?, reasoning_effort = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.model,
                    deps.write_system_prompt(payload),
                    payload.temperature,
                    payload.max_tokens,
                    int(payload.thinking_enabled),
                    payload.reasoning_effort,
                    deps.utc_now(),
                    story_id,
                ),
            )

        return StreamingResponse(
            stream_story_generation(
                story_id,
                chapter_id,
                payload,
                story,
                chapter,
                lorebook_rows,
            ),
            media_type="application/x-ndjson; charset=utf-8",
        )

    return router
