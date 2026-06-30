from __future__ import annotations

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
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "dist"
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "routerchat.sqlite3"
ENV_PATH = ROOT_DIR / ".env"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MAX_TOKENS = 30000
DEFAULT_SYSTEM_PROMPT = (
    "Respond concisely and carefully. Ask only when needed and prefer concrete next steps."
)
DEFAULT_MODEL_ID = "anthropic/claude-3.5-sonnet"
ReasoningEffort = Literal["low", "medium", "high", "xhigh"]

load_dotenv(ENV_PATH)

app = FastAPI(title="RouterChat", version="0.1.0")


class ApiKeyRequest(BaseModel):
    api_key: str = Field(min_length=1)


class ChatCreateRequest(BaseModel):
    title: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    temperature: float = 0.7
    max_tokens: int = DEFAULT_MAX_TOKENS
    thinking_enabled: bool = False
    reasoning_effort: ReasoningEffort = "medium"
    nitro_mode: bool = False


class ChatPatchRequest(BaseModel):
    title: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    thinking_enabled: bool | None = None
    reasoning_effort: ReasoningEffort | None = None


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
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    thinking_enabled: bool = False
    reasoning_effort: ReasoningEffort = "medium"
    nitro_mode: bool = False
    regenerate_message_id: str | None = None


class MessageUpdateRequest(BaseModel):
    content: str = Field(min_length=1)


class ChatImportRequest(BaseModel):
    chats: list[dict[str, Any]] = Field(default_factory=list)
    messages: list[dict[str, Any]] = Field(default_factory=list)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
              created_at TEXT NOT NULL,
              FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
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
            """
        )
        ensure_message_usage_columns(conn)
        ensure_chat_settings_columns(conn)


def ensure_chat_settings_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(chats)").fetchall()
    }
    if "reasoning_effort" not in existing_columns:
        conn.execute(
            "ALTER TABLE chats ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'"
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
    }
    for column, column_type in usage_columns.items():
        if column not in existing_columns:
            conn.execute(f"ALTER TABLE messages ADD COLUMN {column} {column_type}")


@app.on_event("startup")
def on_startup() -> None:
    init_db()


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
        "architecture": model.get("architecture") or {},
        "pricing": model.get("pricing") or {},
        "supported_parameters": model.get("supported_parameters") or [],
        "description": model.get("description"),
    }


def is_text_only_model(model: dict[str, Any]) -> bool:
    architecture = model.get("architecture") or {}
    input_modalities = set(architecture.get("input_modalities") or [])
    output_modalities = set(architecture.get("output_modalities") or [])

    if input_modalities or output_modalities:
        return input_modalities == {"text"} and output_modalities == {"text"}

    modality = architecture.get("modality")
    if isinstance(modality, str) and "->" in modality:
        source, target = modality.split("->", 1)
        return set(source.split("+")) == {"text"} and set(target.split("+")) == {"text"}

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
    return [model for model in json.loads(row["payload_json"]) if is_text_only_model(model)]


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
        if is_text_only_model(item)
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
            "SELECT * FROM chats ORDER BY updated_at DESC, created_at DESC"
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
              thinking_enabled, reasoning_effort, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                chat_id,
                payload.title or "New chat",
                model,
                payload.system_prompt or DEFAULT_SYSTEM_PROMPT,
                payload.temperature,
                payload.max_tokens,
                int(payload.thinking_enabled),
                payload.reasoning_effort,
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
            "SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC",
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

            conn.execute(
                """
                INSERT INTO chats (
                  id, title, model, system_prompt, temperature, max_tokens,
                  thinking_enabled, reasoning_effort, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chat_id,
                    str(item.get("title") or "Imported chat")[:120],
                    str(item.get("model") or default_model_id()),
                    str(item.get("system_prompt") or DEFAULT_SYSTEM_PROMPT),
                    float_or_none(item.get("temperature")) or 0.7,
                    int_or_none(item.get("max_tokens")) or DEFAULT_MAX_TOKENS,
                    coerce_bool_int(item.get("thinking_enabled")),
                    coerce_reasoning_effort(item.get("reasoning_effort")),
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

            conn.execute(
                """
                INSERT INTO messages (
                  id, chat_id, role, content, reasoning, model, finish_reason,
                  error, generation_id, prompt_tokens, completion_tokens,
                  reasoning_tokens, total_tokens, cost, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            "SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC",
            (chat_id,),
        ).fetchall()
    return {"chat": row_to_chat(chat), "messages": [row_to_message(row) for row in messages]}


@app.patch("/api/chats/{chat_id}")
def update_chat(chat_id: str, payload: ChatPatchRequest) -> dict[str, Any]:
    updates = payload.dict(exclude_unset=True)
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
            if key == "thinking_enabled":
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
        ORDER BY created_at ASC
        LIMIT 1
        """,
        (chat_id,),
    ).fetchone()
    title = chat_title_from_message(first_user["content"]) if first_user else "New chat"
    conn.execute(
        "UPDATE chats SET title = ?, updated_at = ? WHERE id = ?",
        (title, utc_now(), chat_id),
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
            ORDER BY created_at ASC
            LIMIT 1
            """,
            (chat_id,),
        ).fetchone()
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        conn.execute(
            """
            DELETE FROM messages
            WHERE chat_id = ? AND created_at > ?
            """,
            (chat_id, message["created_at"]),
        )
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
            ORDER BY created_at ASC
            LIMIT 1
            """,
            (chat_id,),
        ).fetchone()
        previous_first_user_content = previous_first_user["content"] if previous_first_user else None
        conn.execute(
            """
            DELETE FROM messages
            WHERE chat_id = ? AND created_at >= ?
            """,
            (chat_id, message["created_at"]),
        )
        refresh_chat_after_message_change(conn, chat_id, previous_first_user_content)
    return get_chat(chat_id)


def build_openrouter_messages(chat_id: str, system_prompt: str) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT role, content FROM messages
            WHERE chat_id = ? AND error IS NULL
            ORDER BY created_at ASC
            """,
            (chat_id,),
        ).fetchall()
    for row in rows:
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
    return {
        "prompt_tokens": int_or_none(usage.get("prompt_tokens")),
        "completion_tokens": int_or_none(usage.get("completion_tokens")),
        "reasoning_tokens": int_or_none(completion_details.get("reasoning_tokens")),
        "total_tokens": int_or_none(usage.get("total_tokens")),
        "cost": float_or_none(usage.get("cost")),
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
    }


async def fetch_generation_usage(
    api_key: str, generation_id: str
) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            f"{OPENROUTER_BASE_URL}/generation",
            headers=headers_for_key(api_key),
            params={"id": generation_id},
        )
    if response.status_code >= 400:
        return None
    return normalize_generation_usage(response.json().get("data"))


def stream_event(event_type: str, value: Any) -> bytes:
    return (json.dumps({"type": event_type, "value": value}) + "\n").encode("utf-8")


async def stream_openrouter_response(
    chat_id: str,
    payload: StreamMessageRequest,
    assistant_message_id: str,
) -> AsyncIterator[bytes]:
    api_key = read_openrouter_key()
    if not api_key:
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

    messages = build_openrouter_messages(chat_id, payload.system_prompt)
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

    try:
        async with httpx.AsyncClient(timeout=None) as client:
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
                    generation_id = chunk.get("id") or generation_id
                    next_usage = normalize_usage(chunk.get("usage"))
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
                        value = str(reasoning)
                        reasoning_text.append(value)
                        yield stream_event("reasoning", value)
                    content = delta.get("content")
                    if content:
                        value = str(content)
                        assistant_text.append(value)
                        yield stream_event("content", value)
                if generation_id and not usage:
                    usage = await fetch_generation_usage(api_key, generation_id)
                if usage:
                    yield stream_event(
                        "usage", {"generation_id": generation_id, **usage}
                    )
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)
        fallback = f"RouterChat error: {error_text}"
        assistant_text.append(fallback)
        yield stream_event("error", fallback)
    finally:
        content = "".join(assistant_text)
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO messages (
                  id, chat_id, role, content, reasoning, model, finish_reason,
                  error, generation_id, prompt_tokens, completion_tokens,
                  reasoning_tokens, total_tokens, cost, created_at
                )
                VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    utc_now(),
                ),
            )
            conn.execute(
                "UPDATE chats SET updated_at = ? WHERE id = ?", (utc_now(), chat_id)
            )


@app.post("/api/chats/{chat_id}/messages/stream")
async def stream_message(chat_id: str, payload: StreamMessageRequest) -> StreamingResponse:
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
            conn.execute(
                """
                DELETE FROM messages
                WHERE chat_id = ? AND created_at > (
                  SELECT created_at FROM messages WHERE id = ? AND chat_id = ?
                )
                """,
                (chat_id, payload.regenerate_message_id, chat_id),
            )
        else:
            conn.execute(
                """
                INSERT INTO messages (
                  id, chat_id, role, content, reasoning, model, finish_reason,
                  error, created_at
                )
                VALUES (?, ?, 'user', ?, NULL, ?, NULL, NULL, ?)
                """,
                (user_message_id, chat_id, message, payload.model, now),
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
                payload.system_prompt,
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


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
