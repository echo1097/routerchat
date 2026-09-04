from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import sqlite3
import tempfile
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Literal
from urllib.parse import parse_qs

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.websearch import (
    WEB_SEARCH_MAX_RESULTS,
    WebSearchDeps,
    create_web_search_router,
    deserialize_sources,
    merge_sources,
    normalize_sources,
    serialize_sources,
    web_search_plugin,
)
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
from backend.changelog_status import ChangelogStatusDeps, create_changelog_status_router
from backend.brainstorm import BrainstormDeps, create_brainstorm_router
from backend.lorebook import LorebookDeps, create_lorebook_router
from backend.lorebook_generate import create_lorebook_generate_router
from backend.lorebook_repair import create_lorebook_repair_router
from backend.local_access import read_secret_file, validate_base_url
from backend.writing import (
    WritingDeps,
    create_writing_router,
    insert_chapter_history_entry,
    row_to_story,
    word_diff_counts,
)


ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "dist"
TOS_PATH = ROOT_DIR / "TOS.md"
VERSION_PATH = ROOT_DIR / "version.json"
USER_DATA_ENV_VAR = "ROUTERCHAT_USER_DATA_DIR"
API_SECRET_FILE_ENV_VAR = "ROUTERCHAT_API_SECRET_FILE"
BASE_URL_ENV_VAR = "ROUTERCHAT_BASE_URL"
TRUSTED_ORIGINS_ENV_VAR = "ROUTERCHAT_TRUSTED_ORIGINS"
DEFAULT_BASE_URL = "http://127.0.0.1:8000"
SESSION_COOKIE_NAME = "routerchat_session"
BOOTSTRAP_PATH = "/api/bootstrap"
HEALTH_PATH = "/api/health"
TOS_DATE_PATTERN = re.compile(r"^\*\*Last updated:\s*(.+?)\s*\*\*$", re.MULTILINE)
TOS_EXEMPT_PATHS = {HEALTH_PATH, BOOTSTRAP_PATH, "/api/tos", "/api/tos/accept"}
MUTATION_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
API_AUTH_REQUIRED_DETAIL = {
    "code": "api_auth_required",
    "message": "Open RouterChat through its launcher to authorize this browser.",
}
INVALID_REQUEST_HOST_DETAIL = {
    "code": "invalid_request_host",
    "message": "The request Host is not allowed.",
}
INVALID_REQUEST_ORIGIN_DETAIL = {
    "code": "invalid_request_origin",
    "message": "The request origin is not allowed.",
}
TOS_MISSING_DETAIL = {
    "code": "tos_missing",
    "message": "TOS.md could not be read. Restore it from the repository to use RouterChat.",
}
TOS_REQUIRED_DETAIL = {
    "code": "tos_required",
    "message": "The current Terms of Service have not been accepted.",
}
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MAX_TOKENS = 30000
OPENROUTER_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
DEFAULT_MODEL_ID = "anthropic/claude-3.5-sonnet"
ReasoningEffort = Literal["low", "medium", "high", "max", "xhigh"]


def resolve_user_data_paths(
    environment: Mapping[str, str] | None = None,
) -> tuple[Path, Path, Path]:
    environment = os.environ if environment is None else environment

    if USER_DATA_ENV_VAR not in environment:
        dataDir = ROOT_DIR / "data"
        return dataDir, dataDir / "routerchat.sqlite3", ROOT_DIR / ".env"

    configuredPath = environment[USER_DATA_ENV_VAR]
    if not configuredPath.strip():
        raise RuntimeError(f"{USER_DATA_ENV_VAR} cannot be empty.")

    userDataDir = Path(configuredPath).expanduser().resolve(strict=False)
    return userDataDir, userDataDir / "routerchat.sqlite3", userDataDir / ".env"


def load_version_metadata() -> dict[str, str]:
    try:
        metadata = json.loads(VERSION_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("version.json is missing or invalid.") from exc

    requiredFields = ("version", "releaseTag", "minimumUpdaterVersion")
    missingField = any(
        not isinstance(metadata.get(field), str) or not metadata[field].strip()
        for field in requiredFields
    )
    if missingField:
        raise RuntimeError("version.json is missing required version fields.")

    return {field: metadata[field].strip() for field in requiredFields}


DATA_DIR, DB_PATH, ENV_PATH = resolve_user_data_paths()
VERSION_METADATA = load_version_metadata()
APP_VERSION = VERSION_METADATA["version"]

load_dotenv(ENV_PATH)

app = FastAPI(title="RouterChat", version=APP_VERSION)


@dataclass(frozen=True)
class LocalAccessConfig:
    baseUrl: str
    allowedHost: str
    trustedOrigins: frozenset[str]
    secret: str


def load_local_access_config(
    environment: Mapping[str, str] | None = None,
) -> LocalAccessConfig:
    environment = os.environ if environment is None else environment
    baseUrl = validate_base_url(environment.get(BASE_URL_ENV_VAR, DEFAULT_BASE_URL))
    allowedHost = baseUrl.removeprefix("http://")

    secretFileValue = environment.get(API_SECRET_FILE_ENV_VAR, "").strip()
    if not secretFileValue:
        raise RuntimeError(f"{API_SECRET_FILE_ENV_VAR} must point to a protected credential file.")
    secret = read_secret_file(Path(secretFileValue).expanduser())

    trustedValue = environment.get(TRUSTED_ORIGINS_ENV_VAR, baseUrl)
    trustedOrigins = frozenset(
        validate_base_url(value.strip())
        for value in trustedValue.split(",")
        if value.strip()
    )
    if not trustedOrigins:
        raise RuntimeError(f"{TRUSTED_ORIGINS_ENV_VAR} cannot be empty.")

    return LocalAccessConfig(
        baseUrl=baseUrl,
        allowedHost=allowedHost,
        trustedOrigins=trustedOrigins,
        secret=secret,
    )


def reset_local_access_config() -> None:
    if hasattr(app.state, "localAccessConfig"):
        delattr(app.state, "localAccessConfig")


def local_access_config(targetApp: FastAPI) -> LocalAccessConfig:
    config = getattr(targetApp.state, "localAccessConfig", None)
    if config is None:
        config = load_local_access_config()
        targetApp.state.localAccessConfig = config
    return config


def request_header_values(request: Request, name: bytes) -> list[str]:
    values = []
    for headerName, headerValue in request.scope.get("headers", []):
        if headerName.lower() != name:
            continue
        try:
            values.append(headerValue.decode("ascii"))
        except UnicodeDecodeError:
            values.append("")
    return values


def security_error(statusCode: int, detail: dict[str, str]) -> JSONResponse:
    return JSONResponse(
        status_code=statusCode,
        content={"detail": detail},
        headers={"Cache-Control": "no-store"},
    )


def is_api_path(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


@app.middleware("http")
async def enforce_local_api_security(request: Request, call_next: Any) -> Response:
    config = local_access_config(request.app)
    hostValues = request_header_values(request, b"host")
    if len(hostValues) != 1 or hostValues[0] != config.allowedHost:
        return security_error(400, INVALID_REQUEST_HOST_DETAIL)

    path = request.url.path
    if not is_api_path(path) or path in {HEALTH_PATH, BOOTSTRAP_PATH}:
        return await call_next(request)

    sessionSecret = request.cookies.get(SESSION_COOKIE_NAME, "")
    if not hmac.compare_digest(sessionSecret, config.secret):
        return security_error(401, API_AUTH_REQUIRED_DETAIL)

    if request.method in MUTATION_METHODS:
        originValues = request_header_values(request, b"origin")
        if len(originValues) != 1 or originValues[0] not in config.trustedOrigins:
            return security_error(403, INVALID_REQUEST_ORIGIN_DETAIL)

        fetchSiteValues = request_header_values(request, b"sec-fetch-site")
        if len(fetchSiteValues) > 1 or (
            fetchSiteValues and fetchSiteValues[0].lower() != "same-origin"
        ):
            return security_error(403, INVALID_REQUEST_ORIGIN_DETAIL)

    #guard every api route rather than the handful that talk to openrouter, so a new endpoint cant quietly skip the gate
    if path in TOS_EXEMPT_PATHS:
        return await call_next(request)

    tos = load_tos()
    if not tos:
        return JSONResponse(status_code=503, content={"detail": TOS_MISSING_DETAIL})

    if not latest_tos_acceptance(tos["hash"]):
        return JSONResponse(status_code=403, content={"detail": TOS_REQUIRED_DETAIL})

    return await call_next(request)


@app.post(BOOTSTRAP_PATH, include_in_schema=False)
async def bootstrap_local_session(request: Request) -> Response:
    contentType = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    contentLength = request.headers.get("content-length", "")
    try:
        declaredLength = int(contentLength) if contentLength else 0
    except ValueError:
        declaredLength = 513

    suppliedSecret = ""
    if contentType == "application/x-www-form-urlencoded" and declaredLength <= 512:
        body = await request.body()
        if len(body) <= 512:
            try:
                fields = parse_qs(body.decode("ascii"), keep_blank_values=True)
                secretsFound = fields.get("secret", [])
                if len(secretsFound) == 1:
                    suppliedSecret = secretsFound[0]
            except (UnicodeDecodeError, ValueError):
                suppliedSecret = ""

    config = local_access_config(request.app)
    if not hmac.compare_digest(suppliedSecret, config.secret):
        return security_error(401, API_AUTH_REQUIRED_DETAIL)

    response = RedirectResponse(url="/", status_code=303)
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(
        SESSION_COOKIE_NAME,
        config.secret,
        httponly=True,
        secure=False,
        samesite="strict",
        path="/api",
    )
    return response


class FrontendStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: dict[str, Any]) -> Any:
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404:
                response = await super().get_response("index.html", scope)
            else:
                raise

        if response.media_type == "text/html":
            response.headers["Cache-Control"] = "no-store, max-age=0"
            response.headers["Pragma"] = "no-cache"
        elif path.startswith("assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"

        return response


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


class AppSettingsPatchRequest(BaseModel):
    default_model: str | None = None
    generate_chat_name: bool | None = None
    hide_free_models: bool | None = None
    nitro_mode: bool | None = None
    cheapest_mode: bool | None = None
    privacy_mode: bool | None = None
    zdr_mode: bool | None = None
    smooth_streaming: bool | None = None


class TosAcceptRequest(BaseModel):
    hash: str = Field(min_length=1)


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


#cache the parsed TOS keyed on mtime+size so the guard middleware isnt re-hashing a file on every single request
_tos_cache: dict[str, Any] = {"stamp": None, "value": None}


def load_tos() -> dict[str, Any] | None:
    try:
        stat = TOS_PATH.stat()
    except OSError:
        _tos_cache["stamp"] = None
        _tos_cache["value"] = None
        return None

    stamp = (stat.st_mtime_ns, stat.st_size)
    if _tos_cache["stamp"] == stamp:
        return _tos_cache["value"]

    try:
        raw = TOS_PATH.read_bytes()
    except OSError:
        _tos_cache["stamp"] = None
        _tos_cache["value"] = None
        return None

    markdown = raw.decode("utf-8", errors="replace")
    if not markdown.strip():
        #an empty terms file is the same as no terms file, dont let it through
        _tos_cache["stamp"] = stamp
        _tos_cache["value"] = None
        return None

    match = TOS_DATE_PATTERN.search(markdown)
    value = {
        "markdown": markdown,
        "hash": hashlib.sha256(raw).hexdigest(),
        "date": match.group(1) if match else None,
    }

    _tos_cache["stamp"] = stamp
    _tos_cache["value"] = value
    return value


def get_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
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
              web_search_enabled INTEGER NOT NULL DEFAULT 0,
              temporary INTEGER NOT NULL DEFAULT 0,
              pinned INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_folders (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              chat_id TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              reasoning TEXT,
              sources TEXT,
              model TEXT,
              finish_reason TEXT,
              error TEXT,
              message_order INTEGER,
              created_at TEXT NOT NULL,
              FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS favicons (
              domain TEXT PRIMARY KEY,
              mime TEXT,
              image BLOB,
              fetched_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attachments (
              id TEXT PRIMARY KEY,
              chat_id TEXT,
              message_id TEXT,
              story_id TEXT,
              filename TEXT NOT NULL,
              mime TEXT NOT NULL,
              kind TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,
              stored_path TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS attachments_chat_idx
              ON attachments(chat_id);

            CREATE INDEX IF NOT EXISTS attachments_message_idx
              ON attachments(message_id);

            CREATE INDEX IF NOT EXISTS attachments_story_idx
              ON attachments(story_id);

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

            CREATE TABLE IF NOT EXISTS tos_acceptances (
              id TEXT PRIMARY KEY,
              tos_hash TEXT NOT NULL,
              tos_date TEXT,
              accepted_at TEXT NOT NULL
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
              temporary INTEGER NOT NULL DEFAULT 0,
              lorebook_auto INTEGER NOT NULL DEFAULT 0,
              lorebook_model TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chapters (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              word_count INTEGER NOT NULL DEFAULT 0,
              revision INTEGER NOT NULL DEFAULT 0,
              order_index INTEGER NOT NULL,
              disabled INTEGER NOT NULL DEFAULT 0,
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
              revision INTEGER NOT NULL DEFAULT 0,
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
              openrouter_generation_id TEXT,
              raw_output TEXT NOT NULL,
              applied_updates_json TEXT NOT NULL,
              rejected_updates_json TEXT NOT NULL DEFAULT '[]',
              cost REAL,
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
              kind TEXT,
              words_added INTEGER,
              words_removed INTEGER,
              cost REAL,
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
              reasoning TEXT,
              duration_ms REAL,
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

            CREATE INDEX IF NOT EXISTS idx_tos_acceptances_hash
            ON tos_acceptances(tos_hash);
            """
        )
        ensure_chat_folder_column(conn)
        ensure_message_order_column(conn)
        ensure_message_usage_columns(conn)
        ensure_chat_settings_columns(conn)
        ensure_story_settings_columns(conn)
        ensure_chapter_context_column(conn)
        ensure_chapter_revision_column(conn)
        ensure_lorebook_revision_column(conn)
        ensure_message_source_column(conn)
        ensure_brainstorm_generation_columns(conn)
        ensure_chapter_history_columns(conn)
        ensure_lorebook_run_usage_columns(conn)
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
    if "web_search_enabled" not in existing_columns:
        conn.execute(
            "ALTER TABLE chats ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0"
        )


def ensure_message_source_column(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(messages)").fetchall()
    }
    if "sources" not in existing_columns:
        conn.execute("ALTER TABLE messages ADD COLUMN sources TEXT")


def ensure_chat_folder_column(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(chats)").fetchall()
    }
    if "folder_id" not in existing_columns:
        conn.execute("ALTER TABLE chats ADD COLUMN folder_id TEXT")

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chats_folder ON chats(folder_id, updated_at DESC)"
    )


def ensure_story_settings_columns(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"] for row in conn.execute("PRAGMA table_info(stories)").fetchall()
    }
    if "temporary" not in existingColumns:
        conn.execute("ALTER TABLE stories ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0")
    if "lorebook_auto" not in existingColumns:
        conn.execute("ALTER TABLE stories ADD COLUMN lorebook_auto INTEGER NOT NULL DEFAULT 0")
    if "lorebook_model" not in existingColumns:
        #blank means the author never picked one, so the story's own model keeps doing the lorebook work
        conn.execute("ALTER TABLE stories ADD COLUMN lorebook_model TEXT NOT NULL DEFAULT ''")


def ensure_chapter_context_column(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"] for row in conn.execute("PRAGMA table_info(chapters)").fetchall()
    }
    if "disabled" not in existingColumns:
        conn.execute("ALTER TABLE chapters ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0")


def ensure_chapter_revision_column(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"] for row in conn.execute("PRAGMA table_info(chapters)").fetchall()
    }
    if "revision" not in existingColumns:
        conn.execute(
            "ALTER TABLE chapters ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
        )


def ensure_lorebook_revision_column(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"] for row in conn.execute("PRAGMA table_info(lorebook_entries)").fetchall()
    }
    if "revision" not in existingColumns:
        conn.execute(
            "ALTER TABLE lorebook_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
        )


def ensure_brainstorm_generation_columns(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(brainstorm_generations)").fetchall()
    }
    if "reasoning" not in existingColumns:
        conn.execute("ALTER TABLE brainstorm_generations ADD COLUMN reasoning TEXT")
    if "duration_ms" not in existingColumns:
        conn.execute("ALTER TABLE brainstorm_generations ADD COLUMN duration_ms REAL")


def ensure_chapter_history_columns(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(chapter_history_entries)").fetchall()
    }
    #these briefly shipped counting lines, rename rather than re-add so the counts already recorded survive
    if "lines_added" in existingColumns and "words_added" not in existingColumns:
        conn.execute(
            "ALTER TABLE chapter_history_entries RENAME COLUMN lines_added TO words_added"
        )
        existingColumns.add("words_added")
    if "lines_removed" in existingColumns and "words_removed" not in existingColumns:
        conn.execute(
            "ALTER TABLE chapter_history_entries RENAME COLUMN lines_removed TO words_removed"
        )
        existingColumns.add("words_removed")

    #nullable on purpose, history written before this feature has no numbers and a zero would be a lie
    if "words_added" not in existingColumns:
        conn.execute("ALTER TABLE chapter_history_entries ADD COLUMN words_added INTEGER")
    if "words_removed" not in existingColumns:
        conn.execute("ALTER TABLE chapter_history_entries ADD COLUMN words_removed INTEGER")
    if "cost" not in existingColumns:
        conn.execute("ALTER TABLE chapter_history_entries ADD COLUMN cost REAL")
    if "kind" not in existingColumns:
        conn.execute("ALTER TABLE chapter_history_entries ADD COLUMN kind TEXT")
        backfill_chapter_history_kinds(conn)


def backfill_chapter_history_kinds(conn: sqlite3.Connection) -> None:
    #one time pass so old rows stop leaning on the label text forever, ordered so the lorebook ones dont steal each others patterns
    rules = [
        ("prompt", "label = 'User prompt'"),
        ("thinking", "label LIKE '% thought for %'"),
        ("write", "label LIKE '% wrote for %'"),
        ("write_failed", "label LIKE '% could not apply the edit'"),
        (
            "lore_summary",
            "(label LIKE '%finished editing Lorebook after %'"
            " OR label LIKE '%found no Lorebook changes after %')",
        ),
        ("lore_hide", "label LIKE '% from Lorebook'"),
        ("lore_create", "label LIKE '% to Lorebook'"),
        ("lore_update", "(label LIKE '% in Lorebook' OR label LIKE '% updated Timeline')"),
    ]
    for kind, condition in rules:
        conn.execute(
            f"UPDATE chapter_history_entries SET kind = ? WHERE kind IS NULL AND {condition}",
            (kind,),
        )


def ensure_lorebook_run_usage_columns(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(lorebook_update_runs)").fetchall()
    }
    #generation_id was already taken by the story_generations fk so the openrouter one needs its own name
    if "openrouter_generation_id" not in existingColumns:
        conn.execute(
            "ALTER TABLE lorebook_update_runs ADD COLUMN openrouter_generation_id TEXT"
        )
    if "cost" not in existingColumns:
        conn.execute("ALTER TABLE lorebook_update_runs ADD COLUMN cost REAL")
    if "rejected_updates_json" not in existingColumns:
        conn.execute(
            "ALTER TABLE lorebook_update_runs ADD COLUMN rejected_updates_json TEXT NOT NULL DEFAULT '[]'"
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


def message_order_clause() -> str:
    return "message_order ASC, created_at ASC, rowid ASC"


@app.on_event("startup")
def on_startup() -> None:
    local_access_config(app)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
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
    ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
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
        "w", encoding="utf-8", dir=ENV_PATH.parent, delete=False
    ) as handle:
        handle.write("\n".join(next_lines).rstrip() + "\n")
        temp_name = handle.name

    tempPath = Path(temp_name)
    if os.name == "posix":
        tempPath.chmod(0o600)
    tempPath.replace(ENV_PATH)
    if os.name == "posix":
        ENV_PATH.chmod(0o600)

    os.environ["OPENROUTER_API_KEY"] = api_key


def headers_for_key(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "HTTP-Referer": "https://echo1097.github.io/get-routerchat/",
        "X-OpenRouter-Title": "RouterChat",
        "X-Title": "RouterChat",
    }


async def validate_key(api_key: str) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                f"{OPENROUTER_BASE_URL}/key", headers=headers_for_key(api_key)
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not reach OpenRouter. Check your network connection or local TLS certificate.",
        ) from exc
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
    normalizedModel = {
        "id": model.get("id"),
        "name": model.get("name") or model.get("id"),
        "context_length": model.get("context_length"),
        "top_provider": model.get("top_provider") or {},
        "architecture": model.get("architecture") or {},
        "pricing": model.get("pricing") or {},
        "supported_parameters": model.get("supported_parameters") or [],
        "description": model.get("description"),
    }
    if isinstance(model.get("reasoning"), dict):
        normalizedModel["reasoning"] = model["reasoning"]

    return normalizedModel


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


def latest_tos_acceptance(tos_hash: str | None = None) -> dict[str, Any] | None:
    query = "SELECT id, tos_hash, tos_date, accepted_at FROM tos_acceptances"
    params: tuple[Any, ...] = ()

    if tos_hash is not None:
        query += " WHERE tos_hash = ?"
        params = (tos_hash,)

    query += " ORDER BY accepted_at DESC, rowid DESC LIMIT 1"

    with get_db() as conn:
        row = conn.execute(query, params).fetchone()

    return dict(row) if row else None


def previous_tos_acceptance(current_hash: str) -> dict[str, Any] | None:
    #the newest acceptance of some *other* version, which is what the "terms changed" banner shows
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT tos_hash, tos_date, accepted_at
            FROM tos_acceptances
            WHERE tos_hash != ?
            ORDER BY accepted_at DESC, rowid DESC
            LIMIT 1
            """,
            (current_hash,),
        ).fetchone()

    if not row:
        return None

    #same key names as the current-version payload so the frontend can render either one the same way
    return {
        "hash": row["tos_hash"],
        "date": row["tos_date"],
        "accepted_at": row["accepted_at"],
    }


def record_tos_acceptance(tos_hash: str, tos_date: str | None) -> None:
    with get_db() as conn:
        conn.execute(
            "INSERT INTO tos_acceptances (id, tos_hash, tos_date, accepted_at) VALUES (?, ?, ?, ?)",
            (str(uuid.uuid4()), tos_hash, tos_date, utc_now()),
        )


def tos_payload(tos: dict[str, Any]) -> dict[str, Any]:
    accepted = latest_tos_acceptance(tos["hash"])
    return {
        "hash": tos["hash"],
        "date": tos["date"],
        "markdown": tos["markdown"],
        "accepted": bool(accepted),
        "accepted_at": accepted["accepted_at"] if accepted else None,
        "previous": previous_tos_acceptance(tos["hash"]) if not accepted else None,
    }


def app_settings_payload() -> dict[str, Any]:
    return {
        "default_model": default_model_id(),
        "generate_chat_name": bool(read_app_setting("generate_chat_name")),
        "hide_free_models": bool(read_app_setting("hide_free_models")),
        "nitro_mode": bool(read_app_setting("nitro_mode")),
        "cheapest_mode": bool(read_app_setting("cheapest_mode")),
        "privacy_mode": bool(read_app_setting("privacy_mode")),
        "zdr_mode": bool(read_app_setting("zdr_mode")),
        "smooth_streaming": bool(read_app_setting("smooth_streaming")),
    }


def openrouter_request_model(model_id: str, nitro_mode: bool) -> str:
    if not nitro_mode:
        return model_id
    if model_id.endswith(":nitro"):
        return model_id
    return f"{model_id}:nitro"


def openrouter_provider_options() -> dict[str, Any] | None:
    provider: dict[str, Any] = {}

    if bool(read_app_setting("cheapest_mode")):
        provider["sort"] = "price"

    #zdr is the stricter promise, so it already covers what privacy mode asks for
    if bool(read_app_setting("zdr_mode")):
        provider["zdr"] = True
        provider["data_collection"] = "deny"
    elif bool(read_app_setting("privacy_mode")):
        provider["data_collection"] = "deny"

    return provider or None


async def fetch_models_from_openrouter(api_key: str) -> list[dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                f"{OPENROUTER_BASE_URL}/models",
                headers=headers_for_key(api_key),
                params={"output_modalities": "text"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not reach OpenRouter. Check your network connection or local TLS certificate.",
        ) from exc
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
    if value == "xhigh":
        return "max"
    return value if value in {"low", "medium", "high", "max"} else "medium"


def api_reasoning_effort(value: ReasoningEffort) -> str:
    return "max" if value == "xhigh" else value


def resolved_reasoning_effort(model_id: str, value: ReasoningEffort) -> str:
    preferredEffort = api_reasoning_effort(value)
    model = model_metadata(model_id)
    supportedEfforts = (model or {}).get("reasoning", {}).get("supported_efforts")

    if not isinstance(supportedEfforts, list):
        return preferredEffort

    effortOrder = ["low", "medium", "high", "max"]
    availableEfforts = {
        "max" if effort == "xhigh" else effort
        for effort in supportedEfforts
        if effort in {*effortOrder, "xhigh"}
    }
    if preferredEffort in availableEfforts:
        return preferredEffort

    try:
        preferredIndex = effortOrder.index(preferredEffort)
    except ValueError:
        return preferredEffort

    for effort in effortOrder[preferredIndex + 1:]:
        if effort in availableEfforts:
            return effort
    for effort in reversed(effortOrder[:preferredIndex]):
        if effort in availableEfforts:
            return effort
    return preferredEffort


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


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "version": APP_VERSION,
    }


@app.get("/api/tos")
def get_tos() -> dict[str, Any]:
    tos = load_tos()
    if not tos:
        raise HTTPException(status_code=503, detail=TOS_MISSING_DETAIL)
    return tos_payload(tos)


@app.post("/api/tos/accept")
def accept_tos(payload: TosAcceptRequest) -> dict[str, Any]:
    tos = load_tos()
    if not tos:
        raise HTTPException(status_code=503, detail=TOS_MISSING_DETAIL)

    if payload.hash.strip().lower() != tos["hash"]:
        #client was holding a stale copy, make it re-read whatever is on disk now
        raise HTTPException(
            status_code=409,
            detail={
                "code": "tos_stale",
                "message": "The terms changed while you were reading them. Please read and accept the current version.",
            },
        )

    if not latest_tos_acceptance(tos["hash"]):
        record_tos_acceptance(tos["hash"], tos["date"])

    return tos_payload(tos)


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
    if payload.generate_chat_name is not None:
        write_app_setting("generate_chat_name", payload.generate_chat_name)
    if payload.hide_free_models is not None:
        write_app_setting("hide_free_models", payload.hide_free_models)
    if payload.nitro_mode is not None:
        write_app_setting("nitro_mode", payload.nitro_mode)
        if payload.nitro_mode and payload.cheapest_mode is None:
            write_app_setting("cheapest_mode", False)
    if payload.cheapest_mode is not None:
        write_app_setting("cheapest_mode", payload.cheapest_mode)
        if payload.cheapest_mode and payload.nitro_mode is None:
            write_app_setting("nitro_mode", False)
    if payload.privacy_mode is not None:
        write_app_setting("privacy_mode", payload.privacy_mode)
    if payload.zdr_mode is not None:
        write_app_setting("zdr_mode", payload.zdr_mode)
    if payload.smooth_streaming is not None:
        write_app_setting("smooth_streaming", payload.smooth_streaming)
    return app_settings_payload()


@app.get("/api/models")
async def get_models(response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
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
                  reasoning_tokens, total_tokens, cost, provider_name,
                  generation_time, latency, message_order, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        result = conn.execute(
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


def model_metadata(model_id: str) -> dict[str, Any] | None:
    normalizedModelId = str(model_id or "").removesuffix(":nitro")
    for model in cached_models():
        if model.get("id") in {model_id, normalizedModelId}:
            return model
    return None


def model_supports_reasoning(model_id: str) -> bool:
    model = model_metadata(model_id)
    if not model:
        return False
    return (
        "reasoning" in (model.get("supported_parameters") or [])
        or isinstance(model.get("reasoning"), dict)
    )


def model_requires_reasoning(model_id: str) -> bool:
    model = model_metadata(model_id)
    if not model:
        return False
    return (model.get("reasoning") or {}).get("mandatory") is True


def effective_thinking_enabled(model_id: str, thinking_enabled: bool) -> bool:
    return thinking_enabled or model_requires_reasoning(model_id)


def enabled_reasoning_config(
    model_id: str,
    thinking_enabled: bool,
    reasoning_effort: ReasoningEffort,
) -> dict[str, Any] | None:
    if not model_supports_reasoning(model_id):
        return None
    if not effective_thinking_enabled(model_id, thinking_enabled):
        return None
    return {
        "enabled": True,
        "exclude": False,
        "effort": resolved_reasoning_effort(model_id, reasoning_effort),
    }


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


def model_supports_structured_output(model_id: str) -> bool:
    model = model_metadata(model_id)
    if not model:
        return False
    return "structured_outputs" in (model.get("supported_parameters") or [])


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


def stream_event(event_type: str, value: Any, metadata: dict[str, Any] | None = None) -> bytes:
    payload = {"type": event_type, "value": value}
    if metadata:
        payload.update({key: value for key, value in metadata.items() if value is not None})
    return (json.dumps(payload) + "\n").encode("utf-8")


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
        chatSystemPrompt(payload),
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
        if payload.regenerate_message_id and (error_text or not stream_completed):
            return

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
                  reasoning_tokens, total_tokens, cost, provider_name,
                  generation_time, latency, message_order, created_at
                )
                VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

attachmentsDeps = AttachmentsDeps(
    get_db=get_db,
    utc_now=utc_now,
    data_dir=lambda: DATA_DIR,
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

configure_static_files(app, STATIC_DIR)
