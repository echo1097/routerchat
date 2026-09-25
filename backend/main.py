from __future__ import annotations

import json
import re
import sqlite3
import uuid
from typing import Any, AsyncIterator

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.attachments import (
    AttachmentsDeps,
    attachments_by_message,
    chat_has_pdf_attachment,
    claim_attachments,
    create_attachments_router,
    delete_attachments_for_chat,
    delete_attachments_for_missing_messages,
    delete_attachments_for_story,
    delete_orphaned_attachments,
    pdf_parser_plugins,
    user_content_with_attachments,
)
from backend.brainstorm import BrainstormDeps, create_brainstorm_router
from backend.changelog_status import ChangelogStatusDeps, create_changelog_status_router
from backend.core import paths
from backend.core.appSettings import (
    globalChatSystemPrompt,
    read_app_setting,
    write_app_setting,
)
from backend.core.database import get_db, message_order_clause, next_message_order
from backend.core.paths import APP_VERSION
from backend.core.reasoningEffort import ReasoningEffort, coerce_reasoning_effort
from backend.core.schema import init_db
from backend.core.streamEvents import stream_event
from backend.core.utils import (
    coerce_bool_int,
    float_or_none,
    int_or_none,
    patch_updates,
    utc_now,
)
from backend.frontend.staticFiles import configure_static_files
from backend.lorebook import LorebookDeps, create_lorebook_router
from backend.lorebook_generate import create_lorebook_generate_router
from backend.lorebook_repair import create_lorebook_repair_router
from backend.providers.openrouter.apiKey import read_openrouter_key
from backend.providers.openrouter.client import (
    DEFAULT_MAX_TOKENS,
    OPENROUTER_BASE_URL,
    OPENROUTER_TIMEOUT,
    headers_for_key,
)
from backend.providers.openrouter.errors import openrouter_error_message
from backend.providers.openrouter.models import (
    default_model_id,
    model_supports_reasoning,
    model_supports_structured_output,
)
from backend.providers.openrouter.requestOptions import (
    effective_thinking_enabled,
    enabled_reasoning_config,
    openrouter_provider_options,
    openrouter_request_model,
    prompt_cache_control,
)
from backend.providers.openrouter.usage import fetch_generation_usage, normalize_usage
from backend.security import bootstrapRoutes
from backend.security.apiSecurity import enforce_local_api_security
from backend.security.localAccessConfig import local_access_config
from backend.settings import settingsRoutes
from backend.tos import tosRoutes
from backend.transcription import createTranscriptionRouter
from backend.usage import createUsageRouter
from backend.websearch import (
    WebSearchDeps,
    create_web_search_router,
    deserialize_sources,
    merge_sources,
    normalize_sources,
    serialize_sources,
    web_search_plugin,
)
from backend.writing import (
    WritingDeps,
    create_writing_router,
    insert_chapter_history_entry,
    row_to_story,
    word_diff_counts,
)

load_dotenv(paths.ENV_PATH)

app = FastAPI(title="RouterChat", version=APP_VERSION)


def reset_local_access_config() -> None:
    if hasattr(app.state, "localAccessConfig"):
        delattr(app.state, "localAccessConfig")


app.middleware("http")(enforce_local_api_security)
app.include_router(bootstrapRoutes.router)
app.include_router(tosRoutes.router)
app.include_router(settingsRoutes.router)


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
    web_search_enabled: bool = False
    nitro_mode: bool = False
    temporary: bool = False
    folder_id: str | None = None


class FolderCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class FolderPatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)


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
    web_search_enabled: bool | None = None
    pinned: bool | None = None
    folder_id: str | None = None


class ChapterRepairContext(BaseModel):
    #what the model produced last time and why it did not stick, so the retry is not a blind reroll
    previous_output: str = ""
    errors: list[str] = Field(default_factory=list)
    failed_edits: list[dict[str, Any]] = Field(default_factory=list)
    applied_count: int = Field(default=0, ge=0)


class StreamMessageRequest(BaseModel):
    message: str = Field(default="")
    model: str
    temperature: float = 0.7
    max_tokens: int = DEFAULT_MAX_TOKENS
    system_prompt: str = ""
    chat_system_prompt: str | None = None
    write_system_prompt: str | None = None
    thinking_enabled: bool = False
    reasoning_effort: ReasoningEffort = "medium"
    web_search_enabled: bool = False
    nitro_mode: bool = False
    regenerate_message_id: str | None = None
    write_generation_mode: str | None = None
    chapter_revision: int | None = Field(default=None, ge=0)
    generation_run_id: str | None = Field(default=None, min_length=1)
    generation_status_id: str | None = Field(default=None, min_length=1)
    selected_idea_ids: list[str] = Field(default_factory=list)
    brainstorm_idea_count: int = Field(default=3, ge=1, le=8)
    repair_context: ChapterRepairContext | None = None
    attachment_ids: list[str] = Field(default_factory=list)


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


@app.on_event("startup")
def on_startup() -> None:
    local_access_config(app)
    paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    with get_db() as conn:
        conn.execute(
            """
            DELETE FROM messages
            WHERE chat_id IN (SELECT id FROM chats WHERE temporary = 1)
            """
        )
        conn.execute("DELETE FROM chats WHERE temporary = 1")
        delete_orphaned_attachments(conn)
        temporaryStoryIds = [
            row["id"]
            for row in conn.execute("SELECT id FROM stories WHERE temporary = 1").fetchall()
        ]
        for storyId in temporaryStoryIds:
            delete_attachments_for_story(conn, storyId)
            conn.execute("DELETE FROM brainstorm_generations WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM brainstorm_edges WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM brainstorm_nodes WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM brainstorm_viewports WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM lorebook_update_runs WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM story_generations WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM lorebook_entries WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM chapters WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM stories WHERE id = ?", (storyId,))


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


def chat_title_from_message(message: str) -> str:
    words = message.strip().split()
    title = " ".join(words[:6])
    if not title:
        return "New chat"
    return title[:48]


CHAT_TITLE_PROMPT = (
    "Give a short name for this chat based on the message below. "
    "Use 3 to 5 words in Title Case. "
    "Reply with the name only, with no quotes, no final punctuation, and no explanation."
)

CHAT_TITLE_MAX_LENGTH = 48


def title_case_word(word: str) -> str:
    #an acronym the model chose on purpose reads worse after capitalize() lowercases the rest of it
    if word.isupper() and len(word) > 1:
        return word
    if any(letter.isupper() for letter in word[1:]):
        return word
    return word[:1].upper() + word[1:]


def chat_title_from_model_output(raw: str | None) -> str | None:
    if not raw:
        return None

    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if not lines:
        return None

    #a chatty model puts its preamble first and the actual name on the last line
    title = lines[-1]
    title = re.sub(r"^(?:chat\s+)?(?:name|title)\s*[:\-]\s*", "", title, flags=re.IGNORECASE)
    title = title.strip().strip("\"'`“”‘’*")
    title = title.rstrip(".!?:;,")
    title = " ".join(title.split())

    if not title:
        return None

    #the word count lives in the prompt, so only trim here when the sidebar could not show it anyway
    if len(title) > CHAT_TITLE_MAX_LENGTH:
        trimmed = title[:CHAT_TITLE_MAX_LENGTH].rsplit(" ", 1)[0]
        title = trimmed or title[:CHAT_TITLE_MAX_LENGTH]

    title = " ".join(title_case_word(word) for word in title.split(" "))

    return title or None


def folder_or_404(conn: sqlite3.Connection, folder_id: str) -> sqlite3.Row:
    folder = conn.execute(
        "SELECT * FROM chat_folders WHERE id = ?", (folder_id,)
    ).fetchone()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found.")
    return folder


@app.get("/api/folders")
def list_folders() -> dict[str, Any]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM chat_folders ORDER BY created_at ASC"
        ).fetchall()
        counts = conn.execute(
            """
            SELECT folder_id, COUNT(*) AS chat_count FROM chats
            WHERE temporary = 0 AND folder_id IS NOT NULL
            GROUP BY folder_id
            """
        ).fetchall()

    chat_counts = {row["folder_id"]: row["chat_count"] for row in counts}
    folders = []
    for row in rows:
        folder = row_to_folder(row)
        folder["chat_count"] = chat_counts.get(folder["id"], 0)
        folders.append(folder)
    return {"folders": folders}


@app.post("/api/folders")
def create_folder(payload: FolderCreateRequest) -> dict[str, Any]:
    now = utc_now()
    folder_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO chat_folders (id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (folder_id, payload.name.strip(), now, now),
        )
        row = conn.execute(
            "SELECT * FROM chat_folders WHERE id = ?", (folder_id,)
        ).fetchone()

    folder = row_to_folder(row)
    folder["chat_count"] = 0
    return {"folder": folder}


@app.patch("/api/folders/{folder_id}")
def update_folder(folder_id: str, payload: FolderPatchRequest) -> dict[str, Any]:
    updates = patch_updates(payload)
    with get_db() as conn:
        folder_or_404(conn, folder_id)
        if updates:
            if "name" in updates:
                updates["name"] = updates["name"].strip()

            assignments = [f"{key} = ?" for key in updates]
            values = list(updates.values())
            assignments.append("updated_at = ?")
            values.append(utc_now())
            values.append(folder_id)
            conn.execute(
                f"UPDATE chat_folders SET {', '.join(assignments)} WHERE id = ?", values
            )

        row = conn.execute(
            "SELECT * FROM chat_folders WHERE id = ?", (folder_id,)
        ).fetchone()
        count = conn.execute(
            "SELECT COUNT(*) AS chat_count FROM chats WHERE folder_id = ? AND temporary = 0",
            (folder_id,),
        ).fetchone()

    folder = row_to_folder(row)
    folder["chat_count"] = count["chat_count"]
    return {"folder": folder}


@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: str, delete_chats: bool = False) -> dict[str, Any]:
    with get_db() as conn:
        folder_or_404(conn, folder_id)
        if delete_chats:
            chat_ids = [
                row["id"]
                for row in conn.execute(
                    "SELECT id FROM chats WHERE folder_id = ?", (folder_id,)
                ).fetchall()
            ]
            for chat_id in chat_ids:
                delete_attachments_for_chat(conn, chat_id)
                conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
                conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
        else:
            conn.execute(
                "UPDATE chats SET folder_id = NULL WHERE folder_id = ?", (folder_id,)
            )
        conn.execute("DELETE FROM chat_folders WHERE id = ?", (folder_id,))
    return {"ok": True}


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
    folder_id = (payload.folder_id or "").strip() or None
    with get_db() as conn:
        if folder_id:
            folder_or_404(conn, folder_id)
        conn.execute(
            """
            INSERT INTO chats (
              id, title, model, system_prompt, temperature, max_tokens,
              thinking_enabled, reasoning_effort, web_search_enabled, temporary,
              folder_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                int(payload.web_search_enabled),
                int(payload.temporary),
                folder_id,
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
                  thinking_enabled, reasoning_effort, web_search_enabled, pinned,
                  created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    coerce_bool_int(item.get("web_search_enabled")),
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
                  id, chat_id, role, content, reasoning, sources, model, finish_reason,
                  error, generation_id, prompt_tokens, completion_tokens,
                  reasoning_tokens, cached_tokens, total_tokens, cost, provider_name,
                  generation_time, latency, message_order, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    chat_id,
                    str(item.get("role") or "user"),
                    str(item.get("content") or ""),
                    item.get("reasoning"),
                    serialize_sources(normalize_sources(item.get("sources"))),
                    item.get("model"),
                    item.get("finish_reason"),
                    item.get("error"),
                    item.get("generation_id"),
                    int_or_none(item.get("prompt_tokens")),
                    int_or_none(item.get("completion_tokens")),
                    int_or_none(item.get("reasoning_tokens")),
                    int_or_none(item.get("cached_tokens")),
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
        attachmentsByMessage = attachments_by_message(conn, chat_id)

    return {
        "chat": row_to_chat(chat),
        "messages": [
            {
                **row_to_message(row),
                "attachments": attachmentsByMessage.get(row["id"], []),
            }
            for row in messages
        ],
    }


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
        if "folder_id" in updates:
            nextFolderId = (updates["folder_id"] or "").strip() or None
            if nextFolderId:
                folder_or_404(conn, nextFolderId)
            updates["folder_id"] = nextFolderId

        for key, value in updates.items():
            if key in {"thinking_enabled", "web_search_enabled", "pinned"}:
                value = int(bool(value))
            assignments.append(f"{key} = ?")
            values.append(value)

        #settings, renames, pins and folder moves are housekeeping, so they leave updated_at alone
        #and the chat keeps its place in the sidebar until someone actually talks in it
        values.append(chat_id)
        conn.execute(
            f"UPDATE chats SET {', '.join(assignments)} WHERE id = ?", values
        )
    return get_chat(chat_id)


@app.post("/api/chats/{chat_id}/title")
async def name_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        chat = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found.")
        #a rename or an earlier naming run already settled this, and neither should be overwritten
        if chat["title"] != "New chat":
            return get_chat(chat_id)
        first = conn.execute(
            f"""
            SELECT content FROM messages
            WHERE chat_id = ? AND role = 'user'
            ORDER BY {message_order_clause()}
            LIMIT 1
            """,
            (chat_id,),
        ).fetchone()

    if not first or not (first["content"] or "").strip():
        return get_chat(chat_id)

    message = first["content"]
    api_key = read_openrouter_key()
    title = None
    if api_key:
        title = await generate_chat_title(
            api_key, chat["model"], chat["reasoning_effort"], message
        )

    #a chat that cannot be named is still better off with the old derived title than a placeholder
    if not title:
        title = chat_title_from_message(message)

    with get_db() as conn:
        conn.execute(
            "UPDATE chats SET title = ? WHERE id = ? AND title = 'New chat'",
            (title, chat_id),
        )

    return get_chat(chat_id)


@app.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        delete_attachments_for_chat(conn, chat_id)
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
        delete_attachments_for_chat(conn, chat_id)
        conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
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
        delete_attachments_for_missing_messages(conn)
        refresh_chat_after_message_change(conn, chat_id, previous_first_user_content)
    return get_chat(chat_id)


def build_openrouter_messages(
    chat_id: str,
    system_prompt: str,
    regenerate_message_id: str | None = None,
    replacement_content: str | None = None,
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
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
        attachmentsByMessage = attachments_by_message(conn, chat_id)

        for row in rows:
            isRegenerated = bool(regenerate_message_id) and row["id"] == regenerate_message_id
            if not isRegenerated and row["role"] not in {"user", "assistant"}:
                continue

            content = replacement_content or row["content"] if isRegenerated else row["content"]
            role = "user" if isRegenerated else row["role"]
            attachmentIds = [
                attachment["id"] for attachment in attachmentsByMessage.get(row["id"], [])
            ]

            if role == "user" and attachmentIds:
                content = user_content_with_attachments(conn, attachmentIds, content)

            messages.append({"role": role, "content": content})

            if isRegenerated:
                break

    return messages


#a title is a handful of tokens, so the long read budget a real generation needs would only ever
#leave the rename lock sitting there after something already went wrong
CHAT_TITLE_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=15.0, pool=10.0)


def chat_title_request_body(model_id: str, reasoning_effort: ReasoningEffort, message: str) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": openrouter_request_model(model_id, bool(read_app_setting("nitro_mode"))),
        "messages": [{"role": "user", "content": f"{CHAT_TITLE_PROMPT}\n\n{message}"}],
        "temperature": 0.3,
        "max_tokens": 32,
        "stream": False,
    }

    providerOptions = openrouter_provider_options()
    if providerOptions:
        body["provider"] = providerOptions

    #asking for thinking off means passing False here, which still lets a mandatory model keep it
    reasoningConfig = enabled_reasoning_config(model_id, False, reasoning_effort)
    if reasoningConfig:
        body["reasoning"] = reasoningConfig
        body["reasoning_effort"] = reasoningConfig["effort"]
    elif model_supports_reasoning(model_id):
        body["reasoning"] = {"enabled": False, "exclude": True}
        body["reasoning_effort"] = "none"
        body["include_reasoning"] = False

    return body


async def generate_chat_title(
    api_key: str,
    model_id: str,
    reasoning_effort: ReasoningEffort,
    message: str,
) -> str | None:
    body = chat_title_request_body(model_id, reasoning_effort, message)

    try:
        async with httpx.AsyncClient(timeout=CHAT_TITLE_TIMEOUT) as client:
            response = await client.post(
                f"{OPENROUTER_BASE_URL}/chat/completions",
                headers={**headers_for_key(api_key), "Content-Type": "application/json"},
                json=body,
            )
        if response.status_code >= 400:
            return None
        payload = response.json()
    except (httpx.HTTPError, json.JSONDecodeError, ValueError):
        return None

    choices = payload.get("choices") or []
    if not choices:
        return None
    content = (choices[0].get("message") or {}).get("content")

    return chat_title_from_model_output(content)


def saveAssistantReply(
    chat_id: str,
    payload: StreamMessageRequest,
    assistant_message_id: str,
    assistant_text: list[str],
    reasoning_text: list[str],
    sources: list[dict[str, str]],
    finish_reason: str | None,
    error_text: str | None,
    generation_id: str | None,
    usage: dict[str, Any] | None,
) -> None:
    content = "".join(assistant_text)
    with get_db() as conn:
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
            delete_attachments_for_missing_messages(conn)
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
              id, chat_id, role, content, reasoning, sources, model, finish_reason,
              error, generation_id, prompt_tokens, completion_tokens,
              reasoning_tokens, cached_tokens, total_tokens, cost, provider_name,
              generation_time, latency, message_order, created_at
            )
            VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                assistant_message_id,
                chat_id,
                content,
                "".join(reasoning_text) or None,
                serialize_sources(sources),
                payload.model,
                finish_reason,
                error_text,
                generation_id,
                usage.get("prompt_tokens") if usage else None,
                usage.get("completion_tokens") if usage else None,
                usage.get("reasoning_tokens") if usage else None,
                usage.get("cached_tokens") if usage else None,
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


async def stream_openrouter_response(
    chat_id: str,
    payload: StreamMessageRequest,
    assistant_message_id: str,
) -> AsyncIterator[bytes]:
    api_key = read_openrouter_key()
    if not api_key:
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

    messages = build_openrouter_messages(
        chat_id,
        globalChatSystemPrompt(),
        payload.regenerate_message_id,
        payload.message.strip(),
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

    cacheControl = prompt_cache_control()
    if cacheControl:
        body["cache_control"] = cacheControl
        body["session_id"] = chat_id

    with get_db() as conn:
        needsPdfParser = chat_has_pdf_attachment(conn, chat_id)

    plugins: list[dict[str, Any]] = []
    if needsPdfParser:
        plugins.extend(pdf_parser_plugins())
    if payload.web_search_enabled:
        plugins.append(web_search_plugin())
    if plugins:
        body["plugins"] = plugins

    supportsReasoning = model_supports_reasoning(payload.model)
    effectiveThinkingEnabled = effective_thinking_enabled(
        payload.model, payload.thinking_enabled
    )
    reasoningConfig = enabled_reasoning_config(
        payload.model, payload.thinking_enabled, payload.reasoning_effort
    )
    if reasoningConfig:
        body["reasoning"] = reasoningConfig
        body["reasoning_effort"] = reasoningConfig["effort"]
    elif supportsReasoning:
        body["reasoning"] = {"enabled": False, "exclude": True}
        body["reasoning_effort"] = "none"
        body["include_reasoning"] = False

    assistant_text: list[str] = []
    reasoning_text: list[str] = []
    sources: list[dict[str, str]] = []
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
                    message = choice.get("message") or {}
                    incomingSources = normalize_sources(
                        delta.get("annotations") or message.get("annotations")
                    )
                    if incomingSources:
                        merged = merge_sources(sources, incomingSources)
                        if merged != sources:
                            sources = merged
                            yield stream_event("sources", sources)
                    reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                    if reasoning and effectiveThinkingEnabled:
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
        if not (payload.regenerate_message_id and (error_text or not stream_completed)):
            saveAssistantReply(
                chat_id,
                payload,
                assistant_message_id,
                assistant_text,
                reasoning_text,
                sources,
                finish_reason,
                error_text,
                generation_id,
                usage,
            )


@app.post("/api/chats/{chat_id}/messages/stream")
async def stream_message(
    chat_id: str,
    payload: StreamMessageRequest,
) -> StreamingResponse:
    if not read_openrouter_key():
        raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
    message = payload.message.strip()
    attachmentIds = payload.attachment_ids
    if not message and not attachmentIds:
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
            claim_attachments(
                conn,
                attachmentIds,
                chat_id=chat_id,
                message_id=user_message_id,
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
            claim_attachments(
                conn,
                attachmentIds,
                chat_id=chat_id,
                message_id=user_message_id,
            )

        title = chat["title"]
        #the naming route fills this in once the run is done, so leave the placeholder alone for it
        if title == "New chat" and not bool(read_app_setting("generate_chat_name")):
            title = chat_title_from_message(message)
        conn.execute(
            """
            UPDATE chats
            SET title = ?, model = ?, system_prompt = ?, temperature = ?,
                max_tokens = ?, thinking_enabled = ?, reasoning_effort = ?,
                web_search_enabled = ?, updated_at = ?
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
                int(payload.web_search_enabled),
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


writingDeps = WritingDeps(
    get_db=get_db,
    utc_now=utc_now,
    default_model_id=default_model_id,
    read_openrouter_key=read_openrouter_key,
    headers_for_key=headers_for_key,
    write_system_prompt=writeSystemPrompt,
    openrouter_request_model=openrouter_request_model,
    openrouter_provider_options=openrouter_provider_options,
    prompt_cache_control=prompt_cache_control,
    model_supports_reasoning=model_supports_reasoning,
    effective_thinking_enabled=effective_thinking_enabled,
    enabled_reasoning_config=enabled_reasoning_config,
    model_supports_structured_output=model_supports_structured_output,
    openrouter_error_message=openrouter_error_message,
    normalize_usage=normalize_usage,
    fetch_generation_usage=fetch_generation_usage,
    stream_event=stream_event,
    stream_message_request=StreamMessageRequest,
    openrouter_base_url=OPENROUTER_BASE_URL,
)

lorebookDeps = LorebookDeps(
    get_db=get_db,
    utc_now=utc_now,
    read_openrouter_key=read_openrouter_key,
    headers_for_key=headers_for_key,
    openrouter_request_model=openrouter_request_model,
    openrouter_provider_options=openrouter_provider_options,
    effective_thinking_enabled=effective_thinking_enabled,
    enabled_reasoning_config=enabled_reasoning_config,
    model_supports_structured_output=model_supports_structured_output,
    openrouter_error_message=openrouter_error_message,
    normalize_usage=normalize_usage,
    fetch_generation_usage=fetch_generation_usage,
    stream_event=stream_event,
    row_to_story=row_to_story,
    insert_chapter_history_entry=insert_chapter_history_entry,
    word_diff_counts=word_diff_counts,
    openrouter_base_url=OPENROUTER_BASE_URL,
)

brainstormDeps = BrainstormDeps(
    get_db=get_db,
    utc_now=utc_now,
    read_openrouter_key=read_openrouter_key,
    headers_for_key=headers_for_key,
    openrouter_request_model=openrouter_request_model,
    openrouter_provider_options=openrouter_provider_options,
    effective_thinking_enabled=effective_thinking_enabled,
    enabled_reasoning_config=enabled_reasoning_config,
    model_supports_structured_output=model_supports_structured_output,
    openrouter_error_message=openrouter_error_message,
    normalize_usage=normalize_usage,
    fetch_generation_usage=fetch_generation_usage,
    stream_event=stream_event,
    stream_message_request=StreamMessageRequest,
    openrouter_base_url=OPENROUTER_BASE_URL,
)

webSearchDeps = WebSearchDeps(get_db=get_db, utc_now=utc_now)
app.include_router(create_web_search_router(webSearchDeps))
app.include_router(createUsageRouter(get_db, read_app_setting))

attachmentsDeps = AttachmentsDeps(
    get_db=get_db,
    utc_now=utc_now,
    data_dir=lambda: paths.DATA_DIR,
)

changelogStatusDeps = ChangelogStatusDeps(
    read_app_setting=read_app_setting,
    write_app_setting=write_app_setting,
    app_version=APP_VERSION,
)

app.include_router(create_attachments_router(attachmentsDeps))
app.include_router(create_writing_router(writingDeps, lorebookDeps))
app.include_router(create_changelog_status_router(changelogStatusDeps))
app.include_router(create_lorebook_router(lorebookDeps))
app.include_router(create_lorebook_repair_router(lorebookDeps))
app.include_router(create_lorebook_generate_router(lorebookDeps))
app.include_router(create_brainstorm_router(brainstormDeps))

app.include_router(createTranscriptionRouter(
    read_openrouter_key, read_app_setting, write_app_setting, headers_for_key, OPENROUTER_BASE_URL,
    get_db, utc_now,
))

configure_static_files(app, paths.STATIC_DIR)
