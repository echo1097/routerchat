from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException

from backend.providers.anthropic.client import ANTHROPIC_BASE_URL, headersForKey
from backend.providers.envKeys import readEnvKey, writeEnvKey

KEY_NAME = "ANTHROPIC_API_KEY"


def readAnthropicKey() -> str | None:
    return readEnvKey(KEY_NAME)


def writeAnthropicKey(apiKey: str) -> None:
    writeEnvKey(KEY_NAME, apiKey)


async def validateKey(apiKey: str) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                f"{ANTHROPIC_BASE_URL}/models",
                headers=headersForKey(apiKey),
                params={"limit": 1},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not reach Anthropic. Check your network connection or local TLS certificate.",
        ) from exc

    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="Anthropic API key is invalid.")
    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"Anthropic key validation failed: {response.text}",
        )
    return {}
