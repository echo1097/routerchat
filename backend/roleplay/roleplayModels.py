from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from backend.core.reasoningEffort import ReasoningEffort
from backend.providers.base import DEFAULT_MAX_TOKENS


class RoleplayCreateRequest(BaseModel):
    title: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    roleplay_system_prompt: str | None = None
    temperature: float = 0.7
    max_tokens: int = DEFAULT_MAX_TOKENS
    thinking_enabled: bool = False
    reasoning_effort: ReasoningEffort = "medium"
    web_search_enabled: bool = False
    nitro_mode: bool = False
    temporary: bool = False
    folder_id: str | None = None


class RoleplayPatchRequest(BaseModel):
    title: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    roleplay_system_prompt: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    thinking_enabled: bool | None = None
    reasoning_effort: ReasoningEffort | None = None
    web_search_enabled: bool | None = None
    pinned: bool | None = None
    folder_id: str | None = None
    scenario: str | None = None
    author_note: str | None = None


class RoleplayCharacterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: str = "cast"
    description: str = ""
    appearance: str = ""
    personality: str = ""
    speech_style: str = ""
    greeting: str = ""
    example_dialogue: str = ""
    color: str = ""
    disabled: bool = False


class RoleplayFolderCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class RoleplayFolderPatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)


class StreamRoleplayMessageRequest(BaseModel):
    message: str = Field(default="")
    model: str
    temperature: float = 0.7
    max_tokens: int = DEFAULT_MAX_TOKENS
    system_prompt: str = ""
    roleplay_system_prompt: str | None = None
    thinking_enabled: bool = False
    reasoning_effort: ReasoningEffort = "medium"
    web_search_enabled: bool = False
    nitro_mode: bool = False
    regenerate_message_id: str | None = None
    attachment_ids: list[str] = Field(default_factory=list)


class RoleplayMessageUpdateRequest(BaseModel):
    content: str = Field(min_length=1)


class RoleplayImportRequest(BaseModel):
    roleplays: list[dict[str, Any]] = Field(default_factory=list)
    messages: list[dict[str, Any]] = Field(default_factory=list)
    characters: list[dict[str, Any]] = Field(default_factory=list)
