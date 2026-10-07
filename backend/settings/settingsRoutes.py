from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response

from backend.core.appSettings import (
    globalChatSystemPrompt,
    hourPromptCacheEnabled,
    readAppSetting,
    updateChecksEnabled,
    writeAppSetting,
)
from backend.core.utils import patchUpdates
from backend.providers.registry import getActiveProvider, getProvider
from backend.settings.settingsModels import ApiKeyRequest, AppSettingsPatchRequest

router = APIRouter()


def appSettingsPayload() -> dict[str, Any]:
    return {
        "transcription_model": readAppSetting("transcription_model") or "openai/whisper-1",
        "default_model": getActiveProvider().defaultModelId(),
        "generate_chat_name": bool(readAppSetting("generate_chat_name")),
        "hide_free_models": bool(readAppSetting("hide_free_models")),
        "hide_batch_models": bool(readAppSetting("hide_batch_models")),
        "disable_prompt_caching": bool(readAppSetting("disable_prompt_caching")),
        "nitro_mode": bool(readAppSetting("nitro_mode")),
        "cheapest_mode": bool(readAppSetting("cheapest_mode")),
        "privacy_mode": bool(readAppSetting("privacy_mode")),
        "zdr_mode": bool(readAppSetting("zdr_mode")),
        "smooth_streaming": bool(readAppSetting("smooth_streaming")),
        "chat_system_prompt": globalChatSystemPrompt(),
        "hour_prompt_cache": hourPromptCacheEnabled(),
        "update_checks": updateChecksEnabled(),
    }


@router.get("/api/settings/key-status")
async def keyStatus() -> dict[str, Any]:
    return await getActiveProvider().keyStatus()


@router.post("/api/settings/openrouter-key")
async def saveOpenrouterKey(payload: ApiKeyRequest) -> dict[str, Any]:
    provider = getActiveProvider()
    api_key = payload.api_key.strip()
    data = await provider.validateKey(api_key)
    provider.writeKey(api_key)
    return provider.normalizeKeyStatus(data, True)


@router.get("/api/settings")
def getAppSettings() -> dict[str, Any]:
    return appSettingsPayload()


@router.patch("/api/settings")
def updateAppSettings(payload: AppSettingsPatchRequest) -> dict[str, Any]:
    patchUpdates(payload)
    if payload.transcription_model is not None:
        modelId = payload.transcription_model.strip()
        modelIds = {model["id"] for model in (readAppSetting("transcription_models") or [])}
        if not modelId or modelId not in modelIds | {"openai/whisper-1"}:
            raise HTTPException(400, "Choose an available transcription model.")
        writeAppSetting("transcription_model", modelId)
    if payload.default_model is not None:
        model_id = payload.default_model.strip()
        provider = getActiveProvider()
        ids = {model["id"] for model in provider.cachedModels() if model.get("id")}
        if ids and model_id not in ids:
            raise HTTPException(status_code=400, detail="Unknown model.")
        writeAppSetting(provider.defaultModelSetting, model_id)
    if payload.generate_chat_name is not None:
        writeAppSetting("generate_chat_name", payload.generate_chat_name)
    if payload.hide_free_models is not None:
        writeAppSetting("hide_free_models", payload.hide_free_models)
    if payload.hide_batch_models is not None:
        writeAppSetting("hide_batch_models", payload.hide_batch_models)
    if payload.disable_prompt_caching is not None:
        writeAppSetting("disable_prompt_caching", payload.disable_prompt_caching)
    if payload.nitro_mode is not None:
        writeAppSetting("nitro_mode", payload.nitro_mode)
        if payload.nitro_mode and payload.cheapest_mode is None:
            writeAppSetting("cheapest_mode", False)
    if payload.cheapest_mode is not None:
        writeAppSetting("cheapest_mode", payload.cheapest_mode)
        if payload.cheapest_mode and payload.nitro_mode is None:
            writeAppSetting("nitro_mode", False)
    if payload.privacy_mode is not None:
        writeAppSetting("privacy_mode", payload.privacy_mode)
    if payload.zdr_mode is not None:
        writeAppSetting("zdr_mode", payload.zdr_mode)
    if payload.smooth_streaming is not None:
        writeAppSetting("smooth_streaming", payload.smooth_streaming)
    if payload.chat_system_prompt is not None:
        writeAppSetting("chat_system_prompt", payload.chat_system_prompt)
    if payload.hour_prompt_cache is not None:
        writeAppSetting("hour_prompt_cache", payload.hour_prompt_cache)
    if payload.update_checks is not None:
        writeAppSetting("update_checks", payload.update_checks)
    return appSettingsPayload()


@router.get("/api/models")
async def getModels(response: Response, provider: str | None = None) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    provider = getProvider(provider or "") or getActiveProvider()
    api_key = provider.readKey()
    if not api_key:
        models = provider.cachedModels()
        if models:
            return {"models": models, "cached": True}
        raise HTTPException(status_code=401, detail=provider.missingKeyMessage)

    try:
        models = await provider.listModels(api_key)
        provider.cacheModels(models)
        return {"models": models, "cached": False}
    except HTTPException:
        models = provider.cachedModels()
        if models:
            return {"models": models, "cached": True}
        raise
