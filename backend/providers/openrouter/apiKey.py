from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException

from backend.providers.envKeys import readEnvKey, writeEnvKey
from backend.providers.openrouter.client import OPENROUTER_BASE_URL, headersForKey


def readOpenrouterKey() -> str | None:
    return readEnvKey("OPENROUTER_API_KEY")


def writeOpenrouterKey(api_key: str) -> None:
    writeEnvKey("OPENROUTER_API_KEY", api_key)


async def validateKey(api_key: str) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                f"{OPENROUTER_BASE_URL}/key", headers=headersForKey(api_key)
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not reach OpenRouter. Check your network connection or local TLS certificate.",
        ) from exc
    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="OpenRouter API key is invalid.")
    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"OpenRouter key validation failed: {response.text}",
        )
    return response.json().get("data", {})
