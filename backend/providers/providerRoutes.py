from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from backend.providers.registry import getActiveProvider, listProviders

router = APIRouter()


@router.get("/api/providers")
def get_providers(response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    activeProvider = getActiveProvider()
    return {
        "active": activeProvider.id,
        "providers": [
            {**provider.info(), "active": provider.id == activeProvider.id}
            for provider in listProviders()
        ],
    }
