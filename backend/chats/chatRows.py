from __future__ import annotations

import sqlite3
from typing import Any

from backend.providers.openrouter.requestOptions import effective_thinking_enabled
from backend.webSearch.sources import deserialize_sources


def row_to_chat(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "model": row["model"],
        "system_prompt": row["system_prompt"],
        "temperature": row["temperature"],
        "max_tokens": row["max_tokens"],
        "thinking_enabled": effective_thinking_enabled(
            row["model"], bool(row["thinking_enabled"])
        ),
        "reasoning_effort": row["reasoning_effort"],
        "web_search_enabled": bool(row["web_search_enabled"]),
        "temporary": bool(row["temporary"]),
        "pinned": bool(row["pinned"]),
        "folder_id": row["folder_id"] if "folder_id" in row.keys() else None,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_folder(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_message(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "chat_id": row["chat_id"],
        "role": row["role"],
        "content": row["content"],
        "reasoning": row["reasoning"],
        "sources": deserialize_sources(row["sources"]),
        "model": row["model"],
        "finish_reason": row["finish_reason"],
        "error": row["error"],
        "generation_id": row["generation_id"],
        "prompt_tokens": row["prompt_tokens"],
        "completion_tokens": row["completion_tokens"],
        "reasoning_tokens": row["reasoning_tokens"],
        "cached_tokens": row["cached_tokens"],
        "total_tokens": row["total_tokens"],
        "cost": row["cost"],
        "provider_name": row["provider_name"],
        "generation_time": row["generation_time"],
        "latency": row["latency"],
        "created_at": row["created_at"],
    }


def chat_has_messages(conn: sqlite3.Connection, chat_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM messages WHERE chat_id = ? LIMIT 1", (chat_id,)
    ).fetchone()
    return row is not None
