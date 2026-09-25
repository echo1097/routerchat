from __future__ import annotations

import json
from typing import Any

import httpx
from fastapi import HTTPException

from backend.core.appSettings import read_app_setting
from backend.core.database import get_db
from backend.core.utils import utc_now
from backend.providers.openrouter.client import (
    DEFAULT_MODEL_ID,
    OPENROUTER_BASE_URL,
    headers_for_key,
)


def normalize_model(model: dict[str, Any]) -> dict[str, Any]:
    normalizedModel = {
        "id": model.get("id"),
        "name": model.get("name") or model.get("id"),
        "context_length": model.get("context_length"),
        "top_provider": model.get("top_provider") or {},
        "architecture": model.get("architecture") or {},
        "pricing": model.get("pricing") or {},
        "supported_parameters": model.get("supported_parameters") or [],
        "description": model.get("description"),
    }
    if isinstance(model.get("reasoning"), dict):
        normalizedModel["reasoning"] = model["reasoning"]

    return normalizedModel


def outputs_text_model(model: dict[str, Any]) -> bool:
    architecture = model.get("architecture") or {}
    output_modalities = set(architecture.get("output_modalities") or [])

    if output_modalities:
        return "text" in output_modalities

    modality = architecture.get("modality")
    if isinstance(modality, str) and "->" in modality:
        _, target = modality.split("->", 1)
        return "text" in set(target.split("+"))

    # Older cached entries may not include OpenRouter architecture metadata.
    searchable = " ".join(
        str(model.get(key) or "").lower() for key in ("id", "name")
    )
    return not any(kind in searchable for kind in ("image", "audio", "video", "vision"))


def cached_models() -> list[dict[str, Any]]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT payload_json FROM models_cache WHERE id = ?", ("openrouter_text",)
        ).fetchone()
    if not row:
        return []
    return [model for model in json.loads(row["payload_json"]) if outputs_text_model(model)]


def cache_models(models: list[dict[str, Any]]) -> None:
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO models_cache (id, payload_json, fetched_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              payload_json = excluded.payload_json,
              fetched_at = excluded.fetched_at
            """,
            ("openrouter_text", json.dumps(models), utc_now()),
        )


async def fetch_models_from_openrouter(api_key: str) -> list[dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                f"{OPENROUTER_BASE_URL}/models",
                headers=headers_for_key(api_key),
                params={"output_modalities": "text"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not reach OpenRouter. Check your network connection or local TLS certificate.",
        ) from exc
    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"OpenRouter model fetch failed: {response.text}",
        )
    models = [
        normalize_model(item)
        for item in response.json().get("data", [])
        if outputs_text_model(item)
    ]
    return [model for model in models if model.get("id")]


def default_model_id() -> str:
    models = cached_models()
    ids = {model["id"] for model in models if model.get("id")}
    saved_default = read_app_setting("default_model")
    if isinstance(saved_default, str) and saved_default in ids:
        return saved_default
    if DEFAULT_MODEL_ID in ids:
        return DEFAULT_MODEL_ID
    return models[0]["id"] if models else DEFAULT_MODEL_ID


def model_metadata(model_id: str) -> dict[str, Any] | None:
    normalizedModelId = str(model_id or "").removesuffix(":nitro")
    for model in cached_models():
        if model.get("id") in {model_id, normalizedModelId}:
            return model
    return None


def model_supports_reasoning(model_id: str) -> bool:
    model = model_metadata(model_id)
    if not model:
        return False
    return (
        "reasoning" in (model.get("supported_parameters") or [])
        or isinstance(model.get("reasoning"), dict)
    )


def model_requires_reasoning(model_id: str) -> bool:
    model = model_metadata(model_id)
    if not model:
        return False
    return (model.get("reasoning") or {}).get("mandatory") is True


def model_supports_structured_output(model_id: str) -> bool:
    model = model_metadata(model_id)
    if not model:
        return False
    return "structured_outputs" in (model.get("supported_parameters") or [])
