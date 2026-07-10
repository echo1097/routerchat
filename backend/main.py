from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.writing import WritingDeps, create_writing_router


ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "dist"
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "routerchat.sqlite3"
ENV_PATH = ROOT_DIR / ".env"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MAX_TOKENS = 30000
OPENROUTER_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
DEFAULT_MODEL_ID = "anthropic/claude-3.5-sonnet"
ReasoningEffort = Literal["low", "medium", "high", "xhigh"]

load_dotenv(ENV_PATH)

app = FastAPI(title="RouterChat", version="0.1.0")


class FrontendStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: dict[str, Any]) -> Any:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404:
                return await super().get_response("index.html", scope)
            raise


def configure_static_files(target_app: FastAPI, static_dir: Path) -> None:
    if static_dir.is_dir():
        target_app.mount("/", FrontendStaticFiles(directory=static_dir, html=True), name="static")
        return

    @target_app.get("/", include_in_schema=False)
    def missing_frontend_build() -> PlainTextResponse:
        return PlainTextResponse(
            "frontend build missing, run npm run build",
            status_code=503,
        )


class ApiKeyRequest(BaseModel):
    api_key: str = Field(min_length=1)


class ChatCreateRequest(BaseModel):
    title: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    chat_system_prompt: str | None = None
    write_system_prompt: str | None = None
    temperature: float = 0.7
    max_tokens: int = DEFAULT_MAX_TOKENS
    thinking_enabled: bool = False
    reasoning_effort: ReasoningEffort = "medium"
    nitro_mode: bool = False
    temporary: bool = False


class ChatPatchRequest(BaseModel):
    title: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    chat_system_prompt: str | None = None
    write_system_prompt: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    thinking_enabled: bool | None = None
    reasoning_effort: ReasoningEffort | None = None
    pinned: bool | None = None


class AppSettingsPatchRequest(BaseModel):
    default_model: str | None = None
    hide_free_models: bool | None = None
    nitro_mode: bool | None = None
    smooth_streaming: bool | None = None


class StreamMessageRequest(BaseModel):
    message: str = Field(min_length=1)
    model: str
    temperature: float = 0.7
    max_tokens: int = DEFAULT_MAX_TOKENS
    system_prompt: str = ""
    chat_system_prompt: str | None = None
    write_system_prompt: str | None = None
    thinking_enabled: bool = False
    reasoning_effort: ReasoningEffort = "medium"
    nitro_mode: bool = False
    regenerate_message_id: str | None = None
    write_generation_mode: str | None = None
    chapter_content: str | None = None
    previous_chapters: list[dict[str, Any]] = Field(default_factory=list)
    selected_idea_ids: list[str] = Field(default_factory=list)
    brainstorm_idea_count: int = Field(default=3, ge=1, le=8)


class MessageUpdateRequest(BaseModel):
    content: str = Field(min_length=1)


class ChatImportRequest(BaseModel):
    chats: list[dict[str, Any]] = Field(default_factory=list)
    messages: list[dict[str, Any]] = Field(default_factory=list)


def chatSystemPrompt(payload: ChatCreateRequest | ChatPatchRequest | StreamMessageRequest) -> str:
    return (
        payload.chat_system_prompt
        if payload.chat_system_prompt is not None
        else payload.system_prompt or ""
    )


def writeSystemPrompt(payload: ChatCreateRequest | ChatPatchRequest | StreamMessageRequest) -> str:
    return (
        payload.write_system_prompt
        if payload.write_system_prompt is not None
        else payload.system_prompt or ""
    )


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def patch_updates(payload: BaseModel) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        updates = payload.model_dump(exclude_unset=True)
    else:
        updates = payload.dict(exclude_unset=True)

    null_fields = [key for key, value in updates.items() if value is None]
    if null_fields:
        raise HTTPException(
            status_code=422,
            detail=f"Fields cannot be null: {', '.join(null_fields)}.",
        )
    return updates


def get_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS chats (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              model TEXT NOT NULL,
              system_prompt TEXT NOT NULL,
              temperature REAL NOT NULL,
              max_tokens INTEGER NOT NULL,
              thinking_enabled INTEGER NOT NULL,
              reasoning_effort TEXT NOT NULL DEFAULT 'medium',
              temporary INTEGER NOT NULL DEFAULT 0,
              pinned INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              chat_id TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              reasoning TEXT,
              model TEXT,
              finish_reason TEXT,
              error TEXT,
              message_order INTEGER,
              created_at TEXT NOT NULL,
              FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS writing_threads (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              model TEXT NOT NULL,
              system_prompt TEXT NOT NULL,
              temperature REAL NOT NULL,
              max_tokens INTEGER NOT NULL,
              thinking_enabled INTEGER NOT NULL,
              reasoning_effort TEXT NOT NULL DEFAULT 'medium',
              temporary INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS writing_messages (
              id TEXT PRIMARY KEY,
              writing_thread_id TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              reasoning TEXT,
              model TEXT,
              finish_reason TEXT,
              error TEXT,
              message_order INTEGER,
              created_at TEXT NOT NULL,
              FOREIGN KEY(writing_thread_id) REFERENCES writing_threads(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS models_cache (
              id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              fetched_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stories (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              author TEXT NOT NULL,
              language TEXT NOT NULL,
              synopsis TEXT NOT NULL,
              model TEXT NOT NULL,
              system_prompt TEXT NOT NULL,
              temperature REAL NOT NULL,
              max_tokens INTEGER NOT NULL,
              thinking_enabled INTEGER NOT NULL,
              reasoning_effort TEXT NOT NULL DEFAULT 'medium',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chapters (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              word_count INTEGER NOT NULL DEFAULT 0,
              order_index INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS lorebook_entries (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              name TEXT NOT NULL,
              category TEXT NOT NULL,
              description TEXT NOT NULL,
              aliases_json TEXT NOT NULL,
              tags_json TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              disabled INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS story_generations (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              chapter_id TEXT NOT NULL,
              prompt TEXT NOT NULL,
              generated_text TEXT NOT NULL,
              model TEXT,
              finish_reason TEXT,
              error TEXT,
              generation_id TEXT,
              prompt_tokens INTEGER,
              completion_tokens INTEGER,
              reasoning_tokens INTEGER,
              total_tokens INTEGER,
              cost REAL,
              provider_name TEXT,
              generation_time REAL,
              latency REAL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
              FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS lorebook_update_runs (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              chapter_id TEXT NOT NULL,
              generation_id TEXT,
              raw_output TEXT NOT NULL,
              applied_updates_json TEXT NOT NULL,
              error TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
              FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
              FOREIGN KEY(generation_id) REFERENCES story_generations(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS chapter_history_entries (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              chapter_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              label TEXT NOT NULL,
              detail TEXT NOT NULL DEFAULT '',
              entry_order INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
              FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS brainstorm_nodes (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              node_type TEXT NOT NULL,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              position_x REAL NOT NULL DEFAULT 0,
              position_y REAL NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'complete',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS brainstorm_edges (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              source_node_id TEXT NOT NULL,
              target_node_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
              FOREIGN KEY(source_node_id) REFERENCES brainstorm_nodes(id) ON DELETE CASCADE,
              FOREIGN KEY(target_node_id) REFERENCES brainstorm_nodes(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS brainstorm_viewports (
              story_id TEXT PRIMARY KEY,
              position_x REAL NOT NULL DEFAULT 0,
              position_y REAL NOT NULL DEFAULT 0,
              zoom REAL NOT NULL DEFAULT 1,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS brainstorm_generations (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              prompt_node_id TEXT NOT NULL,
              prompt TEXT NOT NULL,
              model TEXT NOT NULL,
              finish_reason TEXT,
              error TEXT,
              generation_id TEXT,
              prompt_tokens INTEGER,
              completion_tokens INTEGER,
              reasoning_tokens INTEGER,
              total_tokens INTEGER,
              cost REAL,
              provider_name TEXT,
              generation_time REAL,
              latency REAL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
              FOREIGN KEY(prompt_node_id) REFERENCES brainstorm_nodes(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_brainstorm_nodes_story
            ON brainstorm_nodes(story_id, created_at);

            CREATE INDEX IF NOT EXISTS idx_brainstorm_edges_story
            ON brainstorm_edges(story_id, created_at);
            """
        )
        ensure_message_order_column(conn)
        ensure_message_usage_columns(conn)
        ensure_chat_settings_columns(conn)
        ensure_writing_message_order_column(conn)
        ensure_writing_message_usage_columns(conn)
        ensure_writing_thread_settings_columns(conn)
        clean_lorebook_categories(conn)


def ensure_chat_settings_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(chats)").fetchall()
    }
    if "reasoning_effort" not in existing_columns:
        conn.execute(
            "ALTER TABLE chats ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'"
        )
    if "temporary" not in existing_columns:
        conn.execute("ALTER TABLE chats ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0")
    if "pinned" not in existing_columns:
        conn.execute("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")


def ensure_writing_thread_settings_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(writing_threads)").fetchall()
    }
    if "reasoning_effort" not in existing_columns:
        conn.execute(
            "ALTER TABLE writing_threads ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'"
        )
    if "temporary" not in existing_columns:
        conn.execute(
            "ALTER TABLE writing_threads ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0"
        )


def clean_lorebook_categories(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        UPDATE lorebook_entries
        SET category = 'note'
        WHERE lower(category) = 'starting scenario'
        """
    )


def ensure_message_order_column(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(messages)").fetchall()
    }
    if "message_order" not in existing_columns:
        conn.execute("ALTER TABLE messages ADD COLUMN message_order INTEGER")

    chatRows = conn.execute(
        """
        SELECT DISTINCT chat_id FROM messages
        WHERE message_order IS NULL
        ORDER BY chat_id ASC
        """
    ).fetchall()
    for chatRow in chatRows:
        messageRows = conn.execute(
            """
            SELECT rowid FROM messages
            WHERE chat_id = ? AND message_order IS NULL
            ORDER BY created_at ASC, rowid ASC
            """,
            (chatRow["chat_id"],),
        ).fetchall()
        nextOrder = next_message_order(conn, chatRow["chat_id"])
        for offset, messageRow in enumerate(messageRows):
            conn.execute(
                "UPDATE messages SET message_order = ? WHERE rowid = ?",
                (nextOrder + offset, messageRow["rowid"]),
            )


def ensure_writing_message_order_column(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(writing_messages)").fetchall()
    }
    if "message_order" not in existing_columns:
        conn.execute("ALTER TABLE writing_messages ADD COLUMN message_order INTEGER")

    threadRows = conn.execute(
        """
        SELECT DISTINCT writing_thread_id FROM writing_messages
        WHERE message_order IS NULL
        ORDER BY writing_thread_id ASC
        """
    ).fetchall()
    for threadRow in threadRows:
        messageRows = conn.execute(
            """
            SELECT rowid FROM writing_messages
            WHERE writing_thread_id = ? AND message_order IS NULL
            ORDER BY created_at ASC, rowid ASC
            """,
            (threadRow["writing_thread_id"],),
        ).fetchall()
        nextOrder = next_writing_message_order(conn, threadRow["writing_thread_id"])
        for offset, messageRow in enumerate(messageRows):
            conn.execute(
                "UPDATE writing_messages SET message_order = ? WHERE rowid = ?",
                (nextOrder + offset, messageRow["rowid"]),
            )


def ensure_message_usage_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(messages)").fetchall()
    }
    usage_columns = {
        "generation_id": "TEXT",
        "prompt_tokens": "INTEGER",
        "completion_tokens": "INTEGER",
        "reasoning_tokens": "INTEGER",
        "total_tokens": "INTEGER",
        "cost": "REAL",
        "provider_name": "TEXT",
        "generation_time": "REAL",
        "latency": "REAL",
    }
    for column, column_type in usage_columns.items():
        if column not in existing_columns:
            conn.execute(f"ALTER TABLE messages ADD COLUMN {column} {column_type}")


def ensure_writing_message_usage_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(writing_messages)").fetchall()
    }
    usage_columns = {
        "generation_id": "TEXT",
        "prompt_tokens": "INTEGER",
        "completion_tokens": "INTEGER",
        "reasoning_tokens": "INTEGER",
        "total_tokens": "INTEGER",
        "cost": "REAL",
        "provider_name": "TEXT",
        "generation_time": "REAL",
        "latency": "REAL",
    }
    for column, column_type in usage_columns.items():
        if column not in existing_columns:
            conn.execute(f"ALTER TABLE writing_messages ADD COLUMN {column} {column_type}")


def next_message_order(conn: sqlite3.Connection, chat_id: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(message_order), -1) + 1 AS next_order
        FROM messages
        WHERE chat_id = ?
        """,
        (chat_id,),
    ).fetchone()
    return int(row["next_order"])


def next_writing_message_order(conn: sqlite3.Connection, thread_id: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(message_order), -1) + 1 AS next_order
        FROM writing_messages
        WHERE writing_thread_id = ?
        """,
        (thread_id,),
    ).fetchone()
    return int(row["next_order"])


def message_order_clause() -> str:
    return "message_order ASC, created_at ASC, rowid ASC"


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    with get_db() as conn:
        conn.execute(
            """
            DELETE FROM messages
            WHERE chat_id IN (SELECT id FROM chats WHERE temporary = 1)
            """
        )
        conn.execute("DELETE FROM chats WHERE temporary = 1")
        conn.execute(
            """
            DELETE FROM writing_messages
            WHERE writing_thread_id IN (SELECT id FROM writing_threads WHERE temporary = 1)
            """
        )
        conn.execute("DELETE FROM writing_threads WHERE temporary = 1")


def read_openrouter_key() -> str | None:
    env_key = os.getenv("OPENROUTER_API_KEY")
    if env_key:
        return env_key.strip()
    if not ENV_PATH.exists():
        return None
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        if line.startswith("OPENROUTER_API_KEY="):
            value = line.split("=", 1)[1].strip().strip('"').strip("'")
            return value or None
    return None


def write_openrouter_key(api_key: str) -> None:
    lines: list[str] = []
    replaced = False
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()

    next_lines: list[str] = []
    for line in lines:
        if line.startswith("OPENROUTER_API_KEY="):
            next_lines.append(f"OPENROUTER_API_KEY={api_key}")
            replaced = True
        else:
            next_lines.append(line)
    if not replaced:
        next_lines.append(f"OPENROUTER_API_KEY={api_key}")

    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=ROOT_DIR, delete=False
    ) as handle:
        handle.write("\n".join(next_lines).rstrip() + "\n")
        temp_name = handle.name
    Path(temp_name).replace(ENV_PATH)
    os.environ["OPENROUTER_API_KEY"] = api_key


def headers_for_key(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "HTTP-Referer": "http://127.0.0.1:8000",
        "X-OpenRouter-Title": "RouterChat",
    }


async def validate_key(api_key: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(
            f"{OPENROUTER_BASE_URL}/key", headers=headers_for_key(api_key)
        )
    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="OpenRouter API key is invalid.")
    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"OpenRouter key validation failed: {response.text}",
        )
    return response.json().get("data", {})


def normalize_key_status(data: dict[str, Any] | None, has_key: bool) -> dict[str, Any]:
    data = data or {}
    return {
        "has_key": has_key,
        "label": data.get("label"),
        "limit_remaining": data.get("limit_remaining"),
        "usage": data.get("usage"),
    }


def normalize_model(model: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": model.get("id"),
        "name": model.get("name") or model.get("id"),
        "context_length": model.get("context_length"),
        "top_provider": model.get("top_provider") or {},
        "architecture": model.get("architecture") or {},
        "pricing": model.get("pricing") or {},
        "supported_parameters": model.get("supported_parameters") or [],
        "description": model.get("description"),
    }


def outputs_text_model(model: dict[str, Any]) -> bool:
    architecture = model.get("architecture") or {}
    output_modalities = set(architecture.get("output_modalities") or [])

    if output_modalities:
        return "text" in output_modalities

    modality = architecture.get("modality")
    if isinstance(modality, str) and "->" in modality:
        _, target = modality.split("->", 1)
        return "text" in set(target.split("+"))

    # Older cached entries may not include OpenRouter architecture metadata.
    searchable = " ".join(
        str(model.get(key) or "").lower() for key in ("id", "name")
    )
    return not any(kind in searchable for kind in ("image", "audio", "video", "vision"))


def cached_models() -> list[dict[str, Any]]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT payload_json FROM models_cache WHERE id = ?", ("openrouter_text",)
        ).fetchone()
    if not row:
        return []
    return [model for model in json.loads(row["payload_json"]) if outputs_text_model(model)]


def cache_models(models: list[dict[str, Any]]) -> None:
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO models_cache (id, payload_json, fetched_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              payload_json = excluded.payload_json,
              fetched_at = excluded.fetched_at
            """,
            ("openrouter_text", json.dumps(models), utc_now()),
        )


def read_app_setting(key: str) -> Any:
    with get_db() as conn:
        row = conn.execute(
            "SELECT value_json FROM app_settings WHERE key = ?", (key,)
        ).fetchone()
    if not row:
        return None
    return json.loads(row["value_json"])


def write_app_setting(key: str, value: Any) -> None:
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            """,
            (key, json.dumps(value), utc_now()),
        )


def app_settings_payload() -> dict[str, Any]:
    return {
        "default_model": default_model_id(),
        "hide_free_models": bool(read_app_setting("hide_free_models")),
        "nitro_mode": bool(read_app_setting("nitro_mode")),
        "smooth_streaming": bool(read_app_setting("smooth_streaming")),
    }


def openrouter_request_model(model_id: str, nitro_mode: bool) -> str:
    if not nitro_mode:
        return model_id
    if model_id.endswith(":nitro"):
        return model_id
    return f"{model_id}:nitro"


async def fetch_models_from_openrouter(api_key: str) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{OPENROUTER_BASE_URL}/models",
            headers=headers_for_key(api_key),
            params={"output_modalities": "text"},
        )
    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"OpenRouter model fetch failed: {response.text}",
        )
    models = [
        normalize_model(item)
        for item in response.json().get("data", [])
        if outputs_text_model(item)
    ]
    return [model for model in models if model.get("id")]


def row_to_chat(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "model": row["model"],
        "system_prompt": row["system_prompt"],
        "temperature": row["temperature"],
        "max_tokens": row["max_tokens"],
        "thinking_enabled": bool(row["thinking_enabled"]),
        "reasoning_effort": row["reasoning_effort"],
        "temporary": bool(row["temporary"]),
        "pinned": bool(row["pinned"]),
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
        "model": row["model"],
        "finish_reason": row["finish_reason"],
        "error": row["error"],
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


def row_to_writing_thread(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "model": row["model"],
        "system_prompt": row["system_prompt"],
        "temperature": row["temperature"],
        "max_tokens": row["max_tokens"],
        "thinking_enabled": bool(row["thinking_enabled"]),
        "reasoning_effort": row["reasoning_effort"],
        "temporary": bool(row["temporary"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_writing_message(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "writing_thread_id": row["writing_thread_id"],
        "chat_id": row["writing_thread_id"],
        "role": row["role"],
        "content": row["content"],
        "reasoning": row["reasoning"],
        "model": row["model"],
        "finish_reason": row["finish_reason"],
        "error": row["error"],
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


def coerce_bool_int(value: Any) -> int:
    return int(bool(value))


def coerce_reasoning_effort(value: Any) -> ReasoningEffort:
    return value if value in {"low", "medium", "high", "xhigh"} else "medium"


def chat_has_messages(conn: sqlite3.Connection, chat_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM messages WHERE chat_id = ? LIMIT 1", (chat_id,)
    ).fetchone()
    return row is not None


def writing_thread_has_messages(conn: sqlite3.Connection, thread_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM writing_messages WHERE writing_thread_id = ? LIMIT 1",
        (thread_id,),
    ).fetchone()
    return row is not None


def default_model_id() -> str:
    models = cached_models()
    ids = {model["id"] for model in models if model.get("id")}
    saved_default = read_app_setting("default_model")
    if isinstance(saved_default, str) and saved_default in ids:
        return saved_default
    if DEFAULT_MODEL_ID in ids:
        return DEFAULT_MODEL_ID
    return models[0]["id"] if models else DEFAULT_MODEL_ID


def chat_title_from_message(message: str) -> str:
    words = message.strip().split()
    title = " ".join(words[:6])
    if not title:
        return "New chat"
    return title[:48]


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "has_key": bool(read_openrouter_key())}


@app.get("/api/settings/key-status")
async def key_status() -> dict[str, Any]:
    api_key = read_openrouter_key()
    if not api_key:
        return normalize_key_status(None, False)
    try:
        return normalize_key_status(await validate_key(api_key), True)
    except HTTPException:
        return {"has_key": True, "label": None, "limit_remaining": None, "usage": None}


@app.post("/api/settings/openrouter-key")
async def save_openrouter_key(payload: ApiKeyRequest) -> dict[str, Any]:
    api_key = payload.api_key.strip()
    data = await validate_key(api_key)
    write_openrouter_key(api_key)
    return normalize_key_status(data, True)


@app.get("/api/settings")
def get_app_settings() -> dict[str, Any]:
    return app_settings_payload()


@app.patch("/api/settings")
def update_app_settings(payload: AppSettingsPatchRequest) -> dict[str, Any]:
    patch_updates(payload)
    if payload.default_model is not None:
        model_id = payload.default_model.strip()
        ids = {model["id"] for model in cached_models() if model.get("id")}
        if ids and model_id not in ids:
            raise HTTPException(status_code=400, detail="Unknown model.")
        write_app_setting("default_model", model_id)
    if payload.hide_free_models is not None:
        write_app_setting("hide_free_models", payload.hide_free_models)
    if payload.nitro_mode is not None:
        write_app_setting("nitro_mode", payload.nitro_mode)
    if payload.smooth_streaming is not None:
        write_app_setting("smooth_streaming", payload.smooth_streaming)
    return app_settings_payload()


@app.get("/api/models")
async def get_models() -> dict[str, Any]:
    api_key = read_openrouter_key()
    if not api_key:
        models = cached_models()
        if models:
            return {"models": models, "cached": True}
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

    try:
        models = await fetch_models_from_openrouter(api_key)
        cache_models(models)
        return {"models": models, "cached": False}
    except HTTPException:
        models = cached_models()
        if models:
            return {"models": models, "cached": True}
        raise


@app.get("/api/chats")
def list_chats() -> dict[str, Any]:
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM chats
            WHERE temporary = 0
            ORDER BY pinned DESC, updated_at DESC, created_at DESC
            """
        ).fetchall()
    return {"chats": [row_to_chat(row) for row in rows]}


@app.post("/api/chats")
def create_chat(payload: ChatCreateRequest) -> dict[str, Any]:
    now = utc_now()
    chat_id = str(uuid.uuid4())
    model = payload.model or default_model_id()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO chats (
              id, title, model, system_prompt, temperature, max_tokens,
              thinking_enabled, reasoning_effort, temporary, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                chat_id,
                payload.title or "New chat",
                model,
                chatSystemPrompt(payload),
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                int(payload.temporary),
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
    return {"chat": row_to_chat(row)}


@app.get("/api/chats/{chat_id}/export")
def export_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        chat = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found.")
        chat_rows = conn.execute(
            "SELECT * FROM chats WHERE id = ?",
            (chat_id,),
        ).fetchall()
        message_rows = conn.execute(
            f"SELECT * FROM messages WHERE chat_id = ? ORDER BY {message_order_clause()}",
            (chat_id,),
        ).fetchall()
    return {
        "schema": "routerchat.chats.v1",
        "exported_at": utc_now(),
        "chats": [row_to_chat(row) for row in chat_rows],
        "messages": [row_to_message(row) for row in message_rows],
    }


@app.post("/api/chats/import")
def import_chats(payload: ChatImportRequest) -> dict[str, Any]:
    now = utc_now()
    chat_id_map: dict[str, str] = {}
    imported_chat_ids: set[str] = set()
    imported_messages = 0
    nextMessageOrders: dict[str, int] = {}

    with get_db() as conn:
        existing_chat_ids = {
            row["id"] for row in conn.execute("SELECT id FROM chats").fetchall()
        }
        existing_message_ids = {
            row["id"] for row in conn.execute("SELECT id FROM messages").fetchall()
        }

        for item in payload.chats:
            source_id = str(item.get("id") or uuid.uuid4())
            chat_id = source_id
            if chat_id in existing_chat_ids or chat_id in imported_chat_ids:
                chat_id = str(uuid.uuid4())
            chat_id_map[source_id] = chat_id
            imported_chat_ids.add(chat_id)
            imported_temperature = float_or_none(item.get("temperature"))

            conn.execute(
                """
                INSERT INTO chats (
                  id, title, model, system_prompt, temperature, max_tokens,
                  thinking_enabled, reasoning_effort, pinned, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chat_id,
                    str(item.get("title") or "Imported chat")[:120],
                    str(item.get("model") or default_model_id()),
                    str(item.get("system_prompt") or ""),
                    0.7 if imported_temperature is None else imported_temperature,
                    int_or_none(item.get("max_tokens")) or DEFAULT_MAX_TOKENS,
                    coerce_bool_int(item.get("thinking_enabled")),
                    coerce_reasoning_effort(item.get("reasoning_effort")),
                    coerce_bool_int(item.get("pinned")),
                    str(item.get("created_at") or now),
                    str(item.get("updated_at") or now),
                ),
            )

        for item in payload.messages:
            source_chat_id = str(item.get("chat_id") or "")
            chat_id = chat_id_map.get(source_chat_id)
            if not chat_id:
                continue
            message_id = str(item.get("id") or uuid.uuid4())
            if message_id in existing_message_ids:
                message_id = str(uuid.uuid4())
            existing_message_ids.add(message_id)
            if chat_id not in nextMessageOrders:
                nextMessageOrders[chat_id] = next_message_order(conn, chat_id)
            messageOrder = nextMessageOrders[chat_id]
            nextMessageOrders[chat_id] += 1

            conn.execute(
                """
                INSERT INTO messages (
                  id, chat_id, role, content, reasoning, model, finish_reason,
                  error, generation_id, prompt_tokens, completion_tokens,
                  reasoning_tokens, total_tokens, cost, provider_name,
                  generation_time, latency, message_order, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    chat_id,
                    str(item.get("role") or "user"),
                    str(item.get("content") or ""),
                    item.get("reasoning"),
                    item.get("model"),
                    item.get("finish_reason"),
                    item.get("error"),
                    item.get("generation_id"),
                    int_or_none(item.get("prompt_tokens")),
                    int_or_none(item.get("completion_tokens")),
                    int_or_none(item.get("reasoning_tokens")),
                    int_or_none(item.get("total_tokens")),
                    float_or_none(item.get("cost")),
                    item.get("provider_name"),
                    float_or_none(item.get("generation_time")),
                    float_or_none(item.get("latency")),
                    messageOrder,
                    str(item.get("created_at") or now),
                ),
            )
            imported_messages += 1

    return {
        "ok": True,
        "imported_chats": len(imported_chat_ids),
        "imported_messages": imported_messages,
    }


@app.get("/api/chats/{chat_id}")
def get_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        chat = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found.")
        messages = conn.execute(
            f"SELECT * FROM messages WHERE chat_id = ? ORDER BY {message_order_clause()}",
            (chat_id,),
        ).fetchall()
    return {"chat": row_to_chat(chat), "messages": [row_to_message(row) for row in messages]}


@app.patch("/api/chats/{chat_id}")
def update_chat(chat_id: str, payload: ChatPatchRequest) -> dict[str, Any]:
    updates = patch_updates(payload)
    if "chat_system_prompt" in updates:
        updates["system_prompt"] = chatSystemPrompt(payload)
        updates.pop("chat_system_prompt", None)
    updates.pop("write_system_prompt", None)
    if not updates:
        return get_chat(chat_id)
    assignments: list[str] = []
    values: list[Any] = []
    with get_db() as conn:
        chat = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found.")
        if (
            "model" in updates
            and updates["model"] != chat["model"]
            and chat_has_messages(conn, chat_id)
        ):
            raise HTTPException(
                status_code=409,
                detail=f"This chat is locked to {chat['model']}. Start a new chat to use another model.",
            )
        for key, value in updates.items():
            if key in {"thinking_enabled", "pinned"}:
                value = int(bool(value))
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        values.append(utc_now())
        values.append(chat_id)
        result = conn.execute(
            f"UPDATE chats SET {', '.join(assignments)} WHERE id = ?", values
        )
    return get_chat(chat_id)


@app.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        result = conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Chat not found.")
    return {"ok": True}


@app.post("/api/chats/{chat_id}/close")
def close_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        chat = conn.execute(
            "SELECT temporary FROM chats WHERE id = ?", (chat_id,)
        ).fetchone()
        if not chat:
            return {"ok": True}
        if not bool(chat["temporary"]):
            return {"ok": True}
        conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    return {"ok": True}


@app.get("/api/writing")
def list_writing_threads() -> dict[str, Any]:
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM writing_threads
            WHERE temporary = 0
            ORDER BY updated_at DESC, created_at DESC
            """
        ).fetchall()
    return {"threads": [row_to_writing_thread(row) for row in rows]}


@app.post("/api/writing")
def create_writing_thread(payload: ChatCreateRequest) -> dict[str, Any]:
    now = utc_now()
    thread_id = str(uuid.uuid4())
    model = payload.model or default_model_id()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO writing_threads (
              id, title, model, system_prompt, temperature, max_tokens,
              thinking_enabled, reasoning_effort, temporary, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                thread_id,
                payload.title or "New writing",
                model,
                writeSystemPrompt(payload),
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                int(payload.temporary),
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM writing_threads WHERE id = ?", (thread_id,)
        ).fetchone()
    return {"thread": row_to_writing_thread(row)}


@app.get("/api/writing/{thread_id}")
def get_writing_thread(thread_id: str) -> dict[str, Any]:
    with get_db() as conn:
        thread = conn.execute(
            "SELECT * FROM writing_threads WHERE id = ?", (thread_id,)
        ).fetchone()
        if not thread:
            raise HTTPException(status_code=404, detail="Writing thread not found.")
        messages = conn.execute(
            f"""
            SELECT * FROM writing_messages
            WHERE writing_thread_id = ?
            ORDER BY {message_order_clause()}
            """,
            (thread_id,),
        ).fetchall()
    return {
        "thread": row_to_writing_thread(thread),
        "messages": [row_to_writing_message(row) for row in messages],
    }


@app.patch("/api/writing/{thread_id}")
def update_writing_thread(thread_id: str, payload: ChatPatchRequest) -> dict[str, Any]:
    updates = patch_updates(payload)
    if "write_system_prompt" in updates:
        updates["system_prompt"] = writeSystemPrompt(payload)
        updates.pop("write_system_prompt", None)
    updates.pop("chat_system_prompt", None)
    if not updates:
        return get_writing_thread(thread_id)
    assignments: list[str] = []
    values: list[Any] = []
    with get_db() as conn:
        thread = conn.execute(
            "SELECT * FROM writing_threads WHERE id = ?", (thread_id,)
        ).fetchone()
        if not thread:
            raise HTTPException(status_code=404, detail="Writing thread not found.")
        if (
            "model" in updates
            and updates["model"] != thread["model"]
            and writing_thread_has_messages(conn, thread_id)
        ):
            raise HTTPException(
                status_code=409,
                detail=f"This writing thread is locked to {thread['model']}. Start a new writing thread to use another model.",
            )
        for key, value in updates.items():
            if key == "thinking_enabled":
                value = int(bool(value))
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        values.append(utc_now())
        values.append(thread_id)
        conn.execute(
            f"UPDATE writing_threads SET {', '.join(assignments)} WHERE id = ?",
            values,
        )
    return get_writing_thread(thread_id)


@app.delete("/api/writing/{thread_id}")
def delete_writing_thread(thread_id: str) -> dict[str, Any]:
    with get_db() as conn:
        conn.execute(
            "DELETE FROM writing_messages WHERE writing_thread_id = ?", (thread_id,)
        )
        result = conn.execute("DELETE FROM writing_threads WHERE id = ?", (thread_id,))
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Writing thread not found.")
    return {"ok": True}


@app.post("/api/writing/{thread_id}/close")
def close_writing_thread(thread_id: str) -> dict[str, Any]:
    with get_db() as conn:
        thread = conn.execute(
            "SELECT temporary FROM writing_threads WHERE id = ?", (thread_id,)
        ).fetchone()
        if not thread:
            return {"ok": True}
        if not bool(thread["temporary"]):
            return {"ok": True}
        conn.execute(
            "DELETE FROM writing_messages WHERE writing_thread_id = ?", (thread_id,)
        )
        conn.execute("DELETE FROM writing_threads WHERE id = ?", (thread_id,))
    return {"ok": True}


def refresh_chat_after_message_change(
    conn: sqlite3.Connection, chat_id: str, previous_first_user_content: str | None
) -> None:
    chat = conn.execute("SELECT title FROM chats WHERE id = ?", (chat_id,)).fetchone()
    if chat is None:
        return
    previous_auto_title = (
        chat_title_from_message(previous_first_user_content)
        if previous_first_user_content
        else "New chat"
    )
    if chat["title"] != previous_auto_title:
        # The title was customized (renamed, or no longer matches the message it
        # was originally derived from) -- leave it alone.
        conn.execute("UPDATE chats SET updated_at = ? WHERE id = ?", (utc_now(), chat_id))
        return
    first_user = conn.execute(
        """
        SELECT content FROM messages
        WHERE chat_id = ? AND role = 'user'
        ORDER BY message_order ASC, created_at ASC, rowid ASC
        LIMIT 1
        """,
        (chat_id,),
    ).fetchone()
    title = chat_title_from_message(first_user["content"]) if first_user else "New chat"
    conn.execute(
        "UPDATE chats SET title = ?, updated_at = ? WHERE id = ?",
        (title, utc_now(), chat_id),
    )


def refresh_writing_after_message_change(
    conn: sqlite3.Connection, thread_id: str, previous_first_user_content: str | None
) -> None:
    thread = conn.execute(
        "SELECT title FROM writing_threads WHERE id = ?", (thread_id,)
    ).fetchone()
    if thread is None:
        return
    previous_auto_title = (
        chat_title_from_message(previous_first_user_content)
        if previous_first_user_content
        else "New writing"
    )
    if thread["title"] != previous_auto_title:
        conn.execute(
            "UPDATE writing_threads SET updated_at = ? WHERE id = ?",
            (utc_now(), thread_id),
        )
        return
    first_user = conn.execute(
        """
        SELECT content FROM writing_messages
        WHERE writing_thread_id = ? AND role = 'user'
        ORDER BY message_order ASC, created_at ASC, rowid ASC
        LIMIT 1
        """,
        (thread_id,),
    ).fetchone()
    title = chat_title_from_message(first_user["content"]) if first_user else "New writing"
    conn.execute(
        "UPDATE writing_threads SET title = ?, updated_at = ? WHERE id = ?",
        (title, utc_now(), thread_id),
    )


@app.patch("/api/chats/{chat_id}/messages/{message_id}")
def update_message(
    chat_id: str, message_id: str, payload: MessageUpdateRequest
) -> dict[str, Any]:
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    with get_db() as conn:
        message = conn.execute(
            "SELECT * FROM messages WHERE id = ? AND chat_id = ?",
            (message_id, chat_id),
        ).fetchone()
        if not message:
            raise HTTPException(status_code=404, detail="Message not found.")
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be edited.")
        previous_first_user = conn.execute(
            """
            SELECT content FROM messages
            WHERE chat_id = ? AND role = 'user'
            ORDER BY message_order ASC, created_at ASC, rowid ASC
            LIMIT 1
            """,
            (chat_id,),
        ).fetchone()
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        conn.execute(
            "UPDATE messages SET content = ? WHERE id = ? AND chat_id = ?",
            (content, message_id, chat_id),
        )
        refresh_chat_after_message_change(conn, chat_id, previous_first_user_content)
    return get_chat(chat_id)


@app.delete("/api/chats/{chat_id}/messages/{message_id}")
def delete_message(chat_id: str, message_id: str) -> dict[str, Any]:
    with get_db() as conn:
        message = conn.execute(
            "SELECT * FROM messages WHERE id = ? AND chat_id = ?",
            (message_id, chat_id),
        ).fetchone()
        if not message:
            raise HTTPException(status_code=404, detail="Message not found.")
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be deleted.")
        previous_first_user = conn.execute(
            """
            SELECT content FROM messages
            WHERE chat_id = ? AND role = 'user'
            ORDER BY message_order ASC, created_at ASC, rowid ASC
            LIMIT 1
            """,
            (chat_id,),
        ).fetchone()
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        conn.execute(
            """
            DELETE FROM messages
            WHERE chat_id = ? AND message_order >= ?
            """,
            (chat_id, message["message_order"]),
        )
        refresh_chat_after_message_change(conn, chat_id, previous_first_user_content)
    return get_chat(chat_id)


@app.patch("/api/writing/{thread_id}/messages/{message_id}")
def update_writing_message(
    thread_id: str, message_id: str, payload: MessageUpdateRequest
) -> dict[str, Any]:
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    with get_db() as conn:
        message = conn.execute(
            "SELECT * FROM writing_messages WHERE id = ? AND writing_thread_id = ?",
            (message_id, thread_id),
        ).fetchone()
        if not message:
            raise HTTPException(status_code=404, detail="Message not found.")
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be edited.")
        previous_first_user = conn.execute(
            """
            SELECT content FROM writing_messages
            WHERE writing_thread_id = ? AND role = 'user'
            ORDER BY message_order ASC, created_at ASC, rowid ASC
            LIMIT 1
            """,
            (thread_id,),
        ).fetchone()
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        conn.execute(
            "UPDATE writing_messages SET content = ? WHERE id = ? AND writing_thread_id = ?",
            (content, message_id, thread_id),
        )
        refresh_writing_after_message_change(conn, thread_id, previous_first_user_content)
    return get_writing_thread(thread_id)


@app.delete("/api/writing/{thread_id}/messages/{message_id}")
def delete_writing_message(thread_id: str, message_id: str) -> dict[str, Any]:
    with get_db() as conn:
        message = conn.execute(
            "SELECT * FROM writing_messages WHERE id = ? AND writing_thread_id = ?",
            (message_id, thread_id),
        ).fetchone()
        if not message:
            raise HTTPException(status_code=404, detail="Message not found.")
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="Only user prompts can be deleted.")
        previous_first_user = conn.execute(
            """
            SELECT content FROM writing_messages
            WHERE writing_thread_id = ? AND role = 'user'
            ORDER BY message_order ASC, created_at ASC, rowid ASC
            LIMIT 1
            """,
            (thread_id,),
        ).fetchone()
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        conn.execute(
            """
            DELETE FROM writing_messages
            WHERE writing_thread_id = ? AND message_order >= ?
            """,
            (thread_id, message["message_order"]),
        )
        refresh_writing_after_message_change(conn, thread_id, previous_first_user_content)
    return get_writing_thread(thread_id)


def build_openrouter_messages(
    chat_id: str,
    system_prompt: str,
    regenerate_message_id: str | None = None,
    replacement_content: str | None = None,
) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, role, content FROM messages
            WHERE chat_id = ? AND error IS NULL
            ORDER BY message_order ASC, created_at ASC, rowid ASC
            """,
            (chat_id,),
        ).fetchall()
    for row in rows:
        if regenerate_message_id and row["id"] == regenerate_message_id:
            messages.append({"role": "user", "content": replacement_content or row["content"]})
            break
        if row["role"] in {"user", "assistant"}:
            messages.append({"role": row["role"], "content": row["content"]})
    return messages


def build_openrouter_writing_messages(
    thread_id: str,
    system_prompt: str,
    regenerate_message_id: str | None = None,
    replacement_content: str | None = None,
) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, role, content FROM writing_messages
            WHERE writing_thread_id = ? AND error IS NULL
            ORDER BY message_order ASC, created_at ASC, rowid ASC
            """,
            (thread_id,),
        ).fetchall()
    for row in rows:
        if regenerate_message_id and row["id"] == regenerate_message_id:
            messages.append({"role": "user", "content": replacement_content or row["content"]})
            break
        if row["role"] in {"user", "assistant"}:
            messages.append({"role": row["role"], "content": row["content"]})
    return messages


def model_supports_reasoning(model_id: str) -> bool:
    for model in cached_models():
        if model.get("id") == model_id:
            return "reasoning" in (model.get("supported_parameters") or [])
    return False


def openrouter_error_message(status_code: int, response_text: str) -> str:
    try:
        payload = json.loads(response_text)
        message = payload.get("error", {}).get("message") or payload.get("message")
        if message:
            return f"OpenRouter error {status_code}: {message}"
    except json.JSONDecodeError:
        pass
    return f"OpenRouter error {status_code}: {response_text}"


def int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_usage(usage: dict[str, Any] | None) -> dict[str, Any] | None:
    if not usage:
        return None
    completion_details = usage.get("completion_tokens_details") or {}
    # Context meter reference math, kept here for future backend-side use:
    # prompt_tokens = int_or_none(usage.get("prompt_tokens"))
    # completion_tokens = int_or_none(usage.get("completion_tokens"))
    # current_context_tokens = int_or_none(usage.get("total_tokens"))
    # if current_context_tokens is None and prompt_tokens is not None and completion_tokens is not None:
    #     current_context_tokens = prompt_tokens + completion_tokens
    return {
        "prompt_tokens": int_or_none(usage.get("prompt_tokens")),
        "completion_tokens": int_or_none(usage.get("completion_tokens")),
        "reasoning_tokens": int_or_none(completion_details.get("reasoning_tokens")),
        "total_tokens": int_or_none(usage.get("total_tokens")),
        "cost": float_or_none(usage.get("cost")),
        "provider_name": usage.get("provider_name"),
        "generation_time": float_or_none(usage.get("generation_time")),
        "latency": float_or_none(usage.get("latency")),
    }


def normalize_generation_usage(data: dict[str, Any] | None) -> dict[str, Any] | None:
    if not data:
        return None
    prompt_tokens = int_or_none(
        data.get("native_tokens_prompt") or data.get("tokens_prompt")
    )
    completion_tokens = int_or_none(
        data.get("native_tokens_completion") or data.get("tokens_completion")
    )
    total_tokens = (
        prompt_tokens + completion_tokens
        if prompt_tokens is not None and completion_tokens is not None
        else None
    )
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "reasoning_tokens": int_or_none(data.get("native_tokens_reasoning")),
        "total_tokens": total_tokens,
        "cost": float_or_none(data.get("total_cost") or data.get("usage")),
        "provider_name": data.get("provider_name"),
        "generation_time": float_or_none(data.get("generation_time")),
        "latency": float_or_none(data.get("latency")),
    }


async def fetch_generation_usage(
    api_key: str, generation_id: str
) -> dict[str, Any] | None:
    retry_delays = [0.0, 0.35, 0.8, 1.5]
    async with httpx.AsyncClient(timeout=15.0) as client:
        for delay in retry_delays:
            if delay:
                await asyncio.sleep(delay)
            response = await client.get(
                f"{OPENROUTER_BASE_URL}/generation",
                headers=headers_for_key(api_key),
                params={"id": generation_id},
            )
            if response.status_code == 404:
                continue
            if response.status_code >= 400:
                return None
            return normalize_generation_usage(response.json().get("data"))
    return None


def stream_event(event_type: str, value: Any) -> bytes:
    return (json.dumps({"type": event_type, "value": value}) + "\n").encode("utf-8")


async def stream_openrouter_response(
    chat_id: str,
    payload: StreamMessageRequest,
    assistant_message_id: str,
    *,
    writing: bool = False,
) -> AsyncIterator[bytes]:
    api_key = read_openrouter_key()
    if not api_key:
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

    messages = (
        build_openrouter_writing_messages(
            chat_id,
            writeSystemPrompt(payload),
            payload.regenerate_message_id,
            payload.message.strip(),
        )
        if writing
        else build_openrouter_messages(
            chat_id,
            chatSystemPrompt(payload),
            payload.regenerate_message_id,
            payload.message.strip(),
        )
    )
    body: dict[str, Any] = {
        "model": openrouter_request_model(payload.model, payload.nitro_mode),
        "messages": messages,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "stream": True,
    }
    supports_reasoning = model_supports_reasoning(payload.model)
    if supports_reasoning and payload.thinking_enabled:
        body["reasoning"] = {
            "enabled": True,
            "exclude": False,
            "effort": payload.reasoning_effort,
        }
        body["reasoning_effort"] = payload.reasoning_effort
    elif supports_reasoning:
        body["reasoning"] = {"enabled": False, "exclude": True}
        body["reasoning_effort"] = "none"
        body["include_reasoning"] = False

    assistant_text: list[str] = []
    reasoning_text: list[str] = []
    finish_reason: str | None = None
    error_text: str | None = None
    generation_id: str | None = None
    usage: dict[str, Any] | None = None
    stream_completed = False

    try:
        async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client:
            async with client.stream(
                "POST",
                f"{OPENROUTER_BASE_URL}/chat/completions",
                headers={**headers_for_key(api_key), "Content-Type": "application/json"},
                json=body,
            ) as response:
                if response.status_code >= 400:
                    raw_error = (await response.aread()).decode(
                        "utf-8", errors="replace"
                    )
                    error_text = openrouter_error_message(
                        response.status_code, raw_error
                    )
                    assistant_text.append(error_text)
                    yield stream_event("error", error_text)
                    return
                generation_id = response.headers.get("X-Generation-Id") or generation_id

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line.removeprefix("data:").strip()
                    if data == "[DONE]":
                        stream_completed = True
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    generation_id = generation_id or chunk.get("id")
                    next_usage = normalize_usage(chunk.get("usage"))
                    if next_usage:
                        usage = next_usage
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    choice = choices[0]
                    finish_reason = choice.get("finish_reason") or finish_reason
                    if finish_reason:
                        stream_completed = True
                    delta = choice.get("delta") or {}
                    reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                    if reasoning and payload.thinking_enabled:
                        value = str(reasoning)
                        reasoning_text.append(value)
                        yield stream_event("reasoning", value)
                    content = delta.get("content")
                    if content:
                        value = str(content)
                        assistant_text.append(value)
                        yield stream_event("content", value)
                if generation_id:
                    generation_usage = await fetch_generation_usage(api_key, generation_id)
                    if generation_usage:
                        usage = {**(usage or {}), **generation_usage}
                if usage:
                    yield stream_event(
                        "usage",
                        {
                            "generation_id": generation_id,
                            "model": payload.model,
                            **usage,
                        },
                    )
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)
        fallback = f"RouterChat error: {error_text}"
        assistant_text.append(fallback)
        yield stream_event("error", fallback)
    finally:
        if payload.regenerate_message_id and (error_text or not stream_completed):
            return

        content = "".join(assistant_text)
        with get_db() as conn:
            if writing:
                if payload.regenerate_message_id:
                    regenerate_message = conn.execute(
                        """
                        SELECT * FROM writing_messages
                        WHERE id = ? AND writing_thread_id = ? AND role = 'user'
                        """,
                        (payload.regenerate_message_id, chat_id),
                    ).fetchone()
                    if not regenerate_message:
                        return
                    previous_first_user = conn.execute(
                        """
                        SELECT content FROM writing_messages
                        WHERE writing_thread_id = ? AND role = 'user'
                        ORDER BY message_order ASC, created_at ASC, rowid ASC
                        LIMIT 1
                        """,
                        (chat_id,),
                    ).fetchone()
                    previous_first_user_content = (
                        previous_first_user["content"] if previous_first_user else None
                    )
                    conn.execute(
                        """
                        DELETE FROM writing_messages
                        WHERE writing_thread_id = ? AND message_order > ?
                        """,
                        (chat_id, regenerate_message["message_order"]),
                    )
                    conn.execute(
                        """
                        UPDATE writing_messages SET content = ?
                        WHERE id = ? AND writing_thread_id = ?
                        """,
                        (payload.message.strip(), payload.regenerate_message_id, chat_id),
                    )
                    refresh_writing_after_message_change(
                        conn, chat_id, previous_first_user_content
                    )

                conn.execute(
                    """
                    INSERT INTO writing_messages (
                      id, writing_thread_id, role, content, reasoning, model, finish_reason,
                      error, generation_id, prompt_tokens, completion_tokens,
                      reasoning_tokens, total_tokens, cost, provider_name,
                      generation_time, latency, message_order, created_at
                    )
                    VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        assistant_message_id,
                        chat_id,
                        content,
                        "".join(reasoning_text) or None,
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
                        next_writing_message_order(conn, chat_id),
                        utc_now(),
                    ),
                )
                conn.execute(
                    "UPDATE writing_threads SET updated_at = ? WHERE id = ?",
                    (utc_now(), chat_id),
                )
                return

            if payload.regenerate_message_id:
                regenerate_message = conn.execute(
                    """
                    SELECT * FROM messages
                    WHERE id = ? AND chat_id = ? AND role = 'user'
                    """,
                    (payload.regenerate_message_id, chat_id),
                ).fetchone()
                if not regenerate_message:
                    return
                previous_first_user = conn.execute(
                    """
                    SELECT content FROM messages
                    WHERE chat_id = ? AND role = 'user'
                    ORDER BY message_order ASC, created_at ASC, rowid ASC
                    LIMIT 1
                    """,
                    (chat_id,),
                ).fetchone()
                previous_first_user_content = (
                    previous_first_user["content"] if previous_first_user else None
                )
                conn.execute(
                    """
                    DELETE FROM messages
                    WHERE chat_id = ? AND message_order > ?
                    """,
                    (chat_id, regenerate_message["message_order"]),
                )
                conn.execute(
                    """
                    UPDATE messages SET content = ? WHERE id = ? AND chat_id = ?
                    """,
                    (payload.message.strip(), payload.regenerate_message_id, chat_id),
                )
                refresh_chat_after_message_change(
                    conn, chat_id, previous_first_user_content
                )

            conn.execute(
                """
                INSERT INTO messages (
                  id, chat_id, role, content, reasoning, model, finish_reason,
                  error, generation_id, prompt_tokens, completion_tokens,
                  reasoning_tokens, total_tokens, cost, provider_name,
                  generation_time, latency, message_order, created_at
                )
                VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    assistant_message_id,
                    chat_id,
                    content,
                    "".join(reasoning_text) or None,
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
                    next_message_order(conn, chat_id),
                    utc_now(),
                ),
            )
            conn.execute(
                "UPDATE chats SET updated_at = ? WHERE id = ?", (utc_now(), chat_id)
            )


@app.post("/api/chats/{chat_id}/messages/stream")
async def stream_message(
    chat_id: str,
    payload: StreamMessageRequest,
) -> StreamingResponse:
    if not read_openrouter_key():
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    now = utc_now()
    user_message_id = payload.regenerate_message_id or str(uuid.uuid4())
    assistant_message_id = str(uuid.uuid4())

    with get_db() as conn:
        chat = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found.")
        has_messages = chat_has_messages(conn, chat_id)
        locked_model = chat["model"] if has_messages else payload.model
        if has_messages and payload.model != locked_model:
            raise HTTPException(
                status_code=409,
                detail=f"This chat is locked to {locked_model}. Start a new chat to use another model.",
            )

        if payload.regenerate_message_id:
            regenerateMessage = conn.execute(
                """
                SELECT * FROM messages
                WHERE id = ? AND chat_id = ?
                """,
                (payload.regenerate_message_id, chat_id),
            ).fetchone()
            if not regenerateMessage:
                raise HTTPException(status_code=404, detail="Message not found.")
            if regenerateMessage["role"] != "user":
                raise HTTPException(
                    status_code=400,
                    detail="Only user prompts can be regenerated.",
                )
        else:
            conn.execute(
                """
                INSERT INTO messages (
                  id, chat_id, role, content, reasoning, model, finish_reason,
                  error, message_order, created_at
                )
                VALUES (?, ?, 'user', ?, NULL, ?, NULL, NULL, ?, ?)
                """,
                (
                    user_message_id,
                    chat_id,
                    message,
                    payload.model,
                    next_message_order(conn, chat_id),
                    now,
                ),
            )

        title = chat["title"]
        if title == "New chat":
            title = chat_title_from_message(message)
        conn.execute(
            """
            UPDATE chats
            SET title = ?, model = ?, system_prompt = ?, temperature = ?,
                max_tokens = ?, thinking_enabled = ?, reasoning_effort = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                title,
                locked_model,
                chatSystemPrompt(payload),
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                now,
                chat_id,
            ),
        )

    return StreamingResponse(
        stream_openrouter_response(chat_id, payload, assistant_message_id),
        media_type="application/x-ndjson; charset=utf-8",
        headers={
            "X-User-Message-Id": user_message_id,
            "X-Assistant-Message-Id": assistant_message_id,
        },
    )


@app.post("/api/writing/{thread_id}/messages/stream")
async def stream_writing_message(
    thread_id: str,
    payload: StreamMessageRequest,
) -> StreamingResponse:
    if not read_openrouter_key():
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    now = utc_now()
    user_message_id = payload.regenerate_message_id or str(uuid.uuid4())
    assistant_message_id = str(uuid.uuid4())

    with get_db() as conn:
        thread = conn.execute(
            "SELECT * FROM writing_threads WHERE id = ?", (thread_id,)
        ).fetchone()
        if not thread:
            raise HTTPException(status_code=404, detail="Writing thread not found.")
        has_messages = writing_thread_has_messages(conn, thread_id)
        locked_model = thread["model"] if has_messages else payload.model
        if has_messages and payload.model != locked_model:
            raise HTTPException(
                status_code=409,
                detail=f"This writing thread is locked to {locked_model}. Start a new writing thread to use another model.",
            )

        if payload.regenerate_message_id:
            regenerateMessage = conn.execute(
                """
                SELECT * FROM writing_messages
                WHERE id = ? AND writing_thread_id = ?
                """,
                (payload.regenerate_message_id, thread_id),
            ).fetchone()
            if not regenerateMessage:
                raise HTTPException(status_code=404, detail="Message not found.")
            if regenerateMessage["role"] != "user":
                raise HTTPException(
                    status_code=400,
                    detail="Only user prompts can be regenerated.",
                )
        else:
            conn.execute(
                """
                INSERT INTO writing_messages (
                  id, writing_thread_id, role, content, reasoning, model, finish_reason,
                  error, message_order, created_at
                )
                VALUES (?, ?, 'user', ?, NULL, ?, NULL, NULL, ?, ?)
                """,
                (
                    user_message_id,
                    thread_id,
                    message,
                    payload.model,
                    next_writing_message_order(conn, thread_id),
                    now,
                ),
            )

        title = thread["title"]
        if title == "New writing":
            title = chat_title_from_message(message)
        conn.execute(
            """
            UPDATE writing_threads
            SET title = ?, model = ?, system_prompt = ?, temperature = ?,
                max_tokens = ?, thinking_enabled = ?, reasoning_effort = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                title,
                locked_model,
                writeSystemPrompt(payload),
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
                now,
                thread_id,
            ),
        )

    return StreamingResponse(
        stream_openrouter_response(
            thread_id,
            payload,
            assistant_message_id,
            writing=True,
        ),
        media_type="application/x-ndjson; charset=utf-8",
        headers={
            "X-User-Message-Id": user_message_id,
            "X-Assistant-Message-Id": assistant_message_id,
        },
    )


app.include_router(
    create_writing_router(
        WritingDeps(
            get_db=get_db,
            utc_now=utc_now,
            default_model_id=default_model_id,
            read_openrouter_key=read_openrouter_key,
            headers_for_key=headers_for_key,
            write_system_prompt=writeSystemPrompt,
            openrouter_request_model=openrouter_request_model,
            model_supports_reasoning=model_supports_reasoning,
            openrouter_error_message=openrouter_error_message,
            normalize_usage=normalize_usage,
            fetch_generation_usage=fetch_generation_usage,
            stream_event=stream_event,
            stream_message_request=StreamMessageRequest,
            openrouter_base_url=OPENROUTER_BASE_URL,
        )
    )
)

configure_static_files(app, STATIC_DIR)
