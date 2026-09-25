from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response

from backend.core.appSettings import (
    globalChatSystemPrompt,
    hourPromptCacheEnabled,
    read_app_setting,
    write_app_setting,
)
from backend.core.utils import patch_updates
from backend.providers.openrouter.apiKey import (
    normalize_key_status,
    read_openrouter_key,
    validate_key,
    write_openrouter_key,
)
from backend.providers.openrouter.models import (
    cache_models,
    cached_models,
    default_model_id,
    fetch_models_from_openrouter,
)
from backend.settings.settingsModels import ApiKeyRequest, AppSettingsPatchRequest

router = APIRouter()


def app_settings_payload() -> dict[str, Any]:
    return {
        "transcription_model": read_app_setting("transcription_model") or "openai/whisper-1",
        "default_model": default_model_id(),
        "generate_chat_name": bool(read_app_setting("generate_chat_name")),
        "hide_free_models": bool(read_app_setting("hide_free_models")),
        "hide_batch_models": bool(read_app_setting("hide_batch_models")),
        "disable_prompt_caching": bool(read_app_setting("disable_prompt_caching")),
        "nitro_mode": bool(read_app_setting("nitro_mode")),
        "cheapest_mode": bool(read_app_setting("cheapest_mode")),
        "privacy_mode": bool(read_app_setting("privacy_mode")),
        "zdr_mode": bool(read_app_setting("zdr_mode")),
        "smooth_streaming": bool(read_app_setting("smooth_streaming")),
        "chat_system_prompt": globalChatSystemPrompt(),
        "hour_prompt_cache": hourPromptCacheEnabled(),
    }


@router.get("/api/settings/key-status")
async def key_status() -> dict[str, Any]:
    api_key = read_openrouter_key()
    if not api_key:
        return normalize_key_status(None, False)
    try:
        return normalize_key_status(await validate_key(api_key), True)
    except HTTPException:
        return {"has_key": True, "label": None, "limit_remaining": None, "usage": None}


@router.post("/api/settings/openrouter-key")
async def save_openrouter_key(payload: ApiKeyRequest) -> dict[str, Any]:
    api_key = payload.api_key.strip()
    data = await validate_key(api_key)
    write_openrouter_key(api_key)
    return normalize_key_status(data, True)


@router.get("/api/settings")
def get_app_settings() -> dict[str, Any]:
    return app_settings_payload()


@router.patch("/api/settings")
def update_app_settings(payload: AppSettingsPatchRequest) -> dict[str, Any]:
    patch_updates(payload)
    if payload.transcription_model is not None:
        modelId = payload.transcription_model.strip()
        modelIds = {model["id"] for model in (read_app_setting("transcription_models") or [])}
        if not modelId or modelId not in modelIds | {"openai/whisper-1"}:
            raise HTTPException(400, "Choose an available transcription model.")
        write_app_setting("transcription_model", modelId)
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
    if payload.hide_batch_models is not None:
        write_app_setting("hide_batch_models", payload.hide_batch_models)
    if payload.disable_prompt_caching is not None:
        write_app_setting("disable_prompt_caching", payload.disable_prompt_caching)
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
    if payload.chat_system_prompt is not None:
        write_app_setting("chat_system_prompt", payload.chat_system_prompt)
    if payload.hour_prompt_cache is not None:
        write_app_setting("hour_prompt_cache", payload.hour_prompt_cache)
    return app_settings_payload()


@router.get("/api/models")
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
