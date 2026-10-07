from __future__ import annotations

import sqlite3
from typing import Any

from backend.core.appSettings import readAppSetting, writeAppSetting
from backend.providers.anthropic.adapter import anthropicProvider
from backend.providers.base import Provider
from backend.providers.openrouter.adapter import openRouterProvider

ACTIVE_PROVIDER_SETTING = "active_provider"

providers: dict[str, Provider] = {
    openRouterProvider.id: openRouterProvider,
    anthropicProvider.id: anthropicProvider,
}


def getProvider(providerId: Any) -> Provider | None:
    return providers.get(providerId) if isinstance(providerId, str) else None


def getActiveProvider() -> Provider:
    try:
        savedId = readAppSetting(ACTIVE_PROVIDER_SETTING)
    except sqlite3.Error:
        return openRouterProvider

    return getProvider(savedId) or openRouterProvider


def providerForRow(row: Any) -> Provider:
    try:
        savedId = row["provider"]
    except (KeyError, IndexError, TypeError):
        savedId = None

    return getProvider(savedId) or getActiveProvider()


def providerIdForImport(savedId: Any, modelId: str) -> str:
    if getProvider(savedId):
        return savedId
    if modelId.startswith("claude-") and "/" not in modelId:
        return anthropicProvider.id
    return openRouterProvider.id


def setActiveProvider(providerId: str) -> Provider:
    provider = providers[providerId]
    writeAppSetting(ACTIVE_PROVIDER_SETTING, provider.id)
    return provider


def listProviders() -> list[Provider]:
    return list(providers.values())
