from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException

from backend.core import paths
from backend.providers.openrouter.client import OPENROUTER_BASE_URL, headers_for_key


def read_openrouter_key() -> str | None:
    env_key = os.getenv("OPENROUTER_API_KEY")
    if env_key:
        return env_key.strip()
    if not paths.ENV_PATH.exists():
        return None
    for line in paths.ENV_PATH.read_text(encoding="utf-8").splitlines():
        if line.startswith("OPENROUTER_API_KEY="):
            value = line.split("=", 1)[1].strip().strip('"').strip("'")
            return value or None
    return None


def write_openrouter_key(api_key: str) -> None:
    paths.ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    replaced = False
    if paths.ENV_PATH.exists():
        lines = paths.ENV_PATH.read_text(encoding="utf-8").splitlines()

    next_lines: list[str] = []
    for line in lines:
        if line.startswith("OPENROUTER_API_KEY="):
            next_lines.append(f"OPENROUTER_API_KEY={api_key}")
            replaced = True
        else:
            next_lines.append(line)
    if not replaced:
        next_lines.append(f"OPENROUTER_API_KEY={api_key}")

    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=paths.ENV_PATH.parent, delete=False
    ) as handle:
        handle.write("\n".join(next_lines).rstrip() + "\n")
        temp_name = handle.name

    tempPath = Path(temp_name)
    if os.name == "posix":
        tempPath.chmod(0o600)
    tempPath.replace(paths.ENV_PATH)
    if os.name == "posix":
        paths.ENV_PATH.chmod(0o600)

    os.environ["OPENROUTER_API_KEY"] = api_key


async def validate_key(api_key: str) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                f"{OPENROUTER_BASE_URL}/key", headers=headers_for_key(api_key)
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


def normalize_key_status(data: dict[str, Any] | None, has_key: bool) -> dict[str, Any]:
    data = data or {}
    return {
        "has_key": has_key,
        "label": data.get("label"),
        "limit_remaining": data.get("limit_remaining"),
        "usage": data.get("usage"),
    }
