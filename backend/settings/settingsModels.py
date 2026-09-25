from __future__ import annotations

from pydantic import BaseModel, Field


class ApiKeyRequest(BaseModel):
    api_key: str = Field(min_length=1)


class AppSettingsPatchRequest(BaseModel):
    transcription_model: str | None = Field(default=None, min_length=1, max_length=200)
    default_model: str | None = None
    generate_chat_name: bool | None = None
    hide_free_models: bool | None = None
    hide_batch_models: bool | None = None
    disable_prompt_caching: bool | None = None
    nitro_mode: bool | None = None
    cheapest_mode: bool | None = None
    privacy_mode: bool | None = None
    zdr_mode: bool | None = None
    smooth_streaming: bool | None = None
    chat_system_prompt: str | None = None
    hour_prompt_cache: bool | None = None
