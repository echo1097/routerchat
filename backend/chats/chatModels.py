from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from backend.core.reasoningEffort import ReasoningEffort
from backend.providers.openrouter.client import DEFAULT_MAX_TOKENS


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
