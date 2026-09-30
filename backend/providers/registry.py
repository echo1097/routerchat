from __future__ import annotations

from backend.providers.base import Provider
from backend.providers.openrouter.adapter import openRouterProvider

providers: dict[str, Provider] = {
    openRouterProvider.id: openRouterProvider,
}


def getActiveProvider() -> Provider:
    return openRouterProvider


def listProviders() -> list[Provider]:
    return list(providers.values())
