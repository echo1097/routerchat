from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from backend.providers.base import Provider
from backend.providers.registry import (
    getActiveProvider,
    getProvider,
    listProviders,
    setActiveProvider,
)

router = APIRouter()


class ActiveProviderRequest(BaseModel):
    id: str = Field(min_length=1, max_length=50)


class ProviderKeyRequest(BaseModel):
    api_key: str = Field(min_length=1)


def providersPayload() -> dict[str, Any]:
    activeProvider = getActiveProvider()
    return {
        "active": activeProvider.id,
        "providers": [
            {
                **provider.info(),
                "active": provider.id == activeProvider.id,
                "hasKey": bool(provider.readKey()),
            }
            for provider in listProviders()
        ],
    }


def requireProvider(providerId: str) -> Provider:
    provider = getProvider(providerId)
    if provider is None:
        raise HTTPException(status_code=404, detail="Unknown provider.")
    return provider


@router.get("/api/providers")
def get_providers(response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return providersPayload()


@router.post("/api/providers/active")
def choose_active_provider(payload: ActiveProviderRequest) -> dict[str, Any]:
    provider = requireProvider(payload.id)
    setActiveProvider(provider.id)
    return providersPayload()


@router.post("/api/providers/{providerId}/key")
async def save_provider_key(providerId: str, payload: ProviderKeyRequest) -> dict[str, Any]:
    provider = requireProvider(providerId)
    apiKey = payload.api_key.strip()
    data = await provider.validateKey(apiKey)
    provider.writeKey(apiKey)
    return provider.normalizeKeyStatus(data, True)
