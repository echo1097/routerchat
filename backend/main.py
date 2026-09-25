from __future__ import annotations

from dotenv import load_dotenv
from fastapi import FastAPI

from backend.attachments import attachmentRoutes
from backend.brainstorm import BrainstormDeps, create_brainstorm_router
from backend.changelog import changelogRoutes
from backend.chats import (
    chatImportExport,
    chatRoutes,
    chatTitles,
    folderRoutes,
    messageRoutes,
    streamMessage,
)
from backend.chats.chatModels import StreamMessageRequest
from backend.chats.systemPrompts import writeSystemPrompt
from backend.core import paths
from backend.core.database import get_db
from backend.core.paths import APP_VERSION
from backend.core.schema import init_db
from backend.core.startupCleanup import delete_temporary_items
from backend.core.streamEvents import stream_event
from backend.core.utils import utc_now
from backend.frontend.staticFiles import configure_static_files
from backend.lorebook import LorebookDeps, create_lorebook_router
from backend.lorebook_generate import create_lorebook_generate_router
from backend.lorebook_repair import create_lorebook_repair_router
from backend.providers.openrouter.apiKey import read_openrouter_key
from backend.providers.openrouter.client import OPENROUTER_BASE_URL, headers_for_key
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
from backend.transcription import transcriptionRoutes
from backend.usage import usageRoutes
from backend.webSearch import faviconRoutes
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
app.include_router(folderRoutes.router)
app.include_router(chatRoutes.router)
app.include_router(chatImportExport.router)
app.include_router(chatTitles.router)
app.include_router(messageRoutes.router)
app.include_router(streamMessage.router)


@app.on_event("startup")
def on_startup() -> None:
    local_access_config(app)
    paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    delete_temporary_items()


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

app.include_router(faviconRoutes.router)
app.include_router(usageRoutes.router)
app.include_router(attachmentRoutes.router)
app.include_router(create_writing_router(writingDeps, lorebookDeps))
app.include_router(changelogRoutes.router)
app.include_router(create_lorebook_router(lorebookDeps))
app.include_router(create_lorebook_repair_router(lorebookDeps))
app.include_router(create_lorebook_generate_router(lorebookDeps))
app.include_router(create_brainstorm_router(brainstormDeps))
app.include_router(transcriptionRoutes.router)

configure_static_files(app, paths.STATIC_DIR)
