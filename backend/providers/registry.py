from __future__ import annotations

import sqlite3

from backend.core.appSettings import read_app_setting, write_app_setting
from backend.providers.anthropic.adapter import anthropicProvider
from backend.providers.base import Provider
from backend.providers.openrouter.adapter import openRouterProvider

ACTIVE_PROVIDER_SETTING = "active_provider"

providers: dict[str, Provider] = {
    openRouterProvider.id: openRouterProvider,
    anthropicProvider.id: anthropicProvider,
}


def getProvider(providerId: str) -> Provider | None:
    return providers.get(providerId)


def getActiveProvider() -> Provider:
    try:
        savedId = read_app_setting(ACTIVE_PROVIDER_SETTING)
    except sqlite3.Error:
        return openRouterProvider

    if isinstance(savedId, str) and savedId in providers:
        return providers[savedId]
    return openRouterProvider


def setActiveProvider(providerId: str) -> Provider:
    provider = providers[providerId]
    write_app_setting(ACTIVE_PROVIDER_SETTING, provider.id)
    return provider


def listProviders() -> list[Provider]:
    return list(providers.values())
