from __future__ import annotations

import json
from typing import Any

import httpx
from fastapi import HTTPException

from backend.core.appSettings import read_app_setting
from backend.core.database import get_db
from backend.core.utils import utc_now
from backend.providers.anthropic.client import (
    ANTHROPIC_BASE_URL,
    ANTHROPIC_LARGE_CONTEXT_TOKENS,
    ANTHROPIC_MAX_PDF_PAGES,
    ANTHROPIC_MAX_PDF_PAGES_SMALL_CONTEXT,
    FALLBACK_MODEL_ID,
    headersForKey,
)
from backend.providers.anthropic.modelRules import (
    ADAPTIVE,
    CANNOT_DISABLE,
    ModelRules,
    rulesFor,
    supported,
)
from backend.providers.anthropic.pricing import PER_MILLION, priceFor

CACHE_ID = "anthropic_text"
DEFAULT_MODEL_SETTING = "anthropic_default_model"
PAGE_SIZE = 100
MAX_PAGES = 20
EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")
PREFERRED_DEFAULT_FAMILY = "claude-sonnet"


def supportedEfforts(capabilities: dict[str, Any]) -> list[str]:
    return [level for level in EFFORT_LEVELS if supported(capabilities, "effort", level)]


def pricingFor(modelId: str) -> dict[str, str]:
    price = priceFor(modelId)
    if price is None:
        return {}
    return {
        "prompt": f"{price.input / PER_MILLION:.10f}",
        "completion": f"{price.output / PER_MILLION:.10f}",
    }


def normalizeModel(model: dict[str, Any]) -> dict[str, Any]:
    modelId = model.get("id")
    capabilities = model.get("capabilities") or {}
    rules = rulesFor(str(modelId or ""), capabilities)

    inputModalities = ["text"]
    if supported(capabilities, "image_input"):
        inputModalities.append("image")
    if supported(capabilities, "pdf_input"):
        inputModalities.append("file")

    supportedParameters = ["max_tokens"]
    if rules.temperature:
        supportedParameters.append("temperature")
    if rules.thinking:
        supportedParameters.append("reasoning")
    if supported(capabilities, "structured_outputs"):
        supportedParameters.append("structured_outputs")

    normalizedModel: dict[str, Any] = {
        "id": modelId,
        "name": f"Anthropic: {model.get('display_name') or modelId}",
        "context_length": model.get("max_input_tokens"),
        "top_provider": {
            "context_length": model.get("max_input_tokens"),
            "max_completion_tokens": model.get("max_tokens"),
        },
        "architecture": {
            "input_modalities": inputModalities,
            "output_modalities": ["text"],
        },
        "pricing": pricingFor(str(modelId or "")),
        "supported_parameters": supportedParameters,
        "description": None,
        "temperature": rules.temperature,
        "capabilities": capabilities,
    }

    if rules.thinking:
        reasoning: dict[str, Any] = {"mandatory": rules.disable == CANNOT_DISABLE}
        efforts = supportedEfforts(capabilities)
        if rules.thinking == ADAPTIVE and efforts:
            reasoning["supported_efforts"] = efforts
        normalizedModel["reasoning"] = reasoning

    return normalizedModel


async def fetchModels(apiKey: str) -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    afterId: str | None = None

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            for _ in range(MAX_PAGES):
                params: dict[str, Any] = {"limit": PAGE_SIZE}
                if afterId:
                    params["after_id"] = afterId

                response = await client.get(
                    f"{ANTHROPIC_BASE_URL}/models",
                    headers=headersForKey(apiKey),
                    params=params,
                )
                if response.status_code >= 400:
                    raise HTTPException(
                        status_code=response.status_code,
                        detail=f"Anthropic model fetch failed: {response.text}",
                    )

                page = response.json()
                models.extend(normalizeModel(item) for item in page.get("data") or [])

                afterId = page.get("last_id")
                if not page.get("has_more") or not afterId:
                    break
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not reach Anthropic. Check your network connection or local TLS certificate.",
        ) from exc

    return [model for model in models if model.get("id")]


def cachedModels() -> list[dict[str, Any]]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT payload_json FROM models_cache WHERE id = ?", (CACHE_ID,)
        ).fetchone()
    if not row:
        return []
    return json.loads(row["payload_json"])


def cacheModels(models: list[dict[str, Any]]) -> None:
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO models_cache (id, payload_json, fetched_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              payload_json = excluded.payload_json,
              fetched_at = excluded.fetched_at
            """,
            (CACHE_ID, json.dumps(models), utc_now()),
        )


def defaultModelId() -> str:
    ids = [model["id"] for model in cachedModels() if model.get("id")]
    if not ids:
        return FALLBACK_MODEL_ID

    savedDefault = read_app_setting(DEFAULT_MODEL_SETTING)
    if isinstance(savedDefault, str) and savedDefault in ids:
        return savedDefault

    for modelId in ids:
        if modelId.startswith(PREFERRED_DEFAULT_FAMILY):
            return modelId
    return ids[0]


def modelMetadata(modelId: str) -> dict[str, Any] | None:
    for model in cachedModels():
        if model.get("id") == modelId:
            return model
    return None


def modelRules(modelId: str) -> ModelRules:
    model = modelMetadata(modelId)
    return rulesFor(modelId, (model or {}).get("capabilities"))


def modelEfforts(modelId: str) -> list[str]:
    model = modelMetadata(modelId)
    return supportedEfforts((model or {}).get("capabilities") or {})


def maxOutputTokens(modelId: str) -> int | None:
    model = modelMetadata(modelId)
    limit = ((model or {}).get("top_provider") or {}).get("max_completion_tokens")
    return limit if isinstance(limit, int) and limit > 0 else None


def maxPdfPages(modelId: str) -> int:
    model = modelMetadata(modelId)
    contextLength = (model or {}).get("context_length")
    if isinstance(contextLength, int) and 0 < contextLength < ANTHROPIC_LARGE_CONTEXT_TOKENS:
        return ANTHROPIC_MAX_PDF_PAGES_SMALL_CONTEXT
    return ANTHROPIC_MAX_PDF_PAGES


def modelSupportsReasoning(modelId: str) -> bool:
    return modelRules(modelId).thinking is not None


def modelRequiresReasoning(modelId: str) -> bool:
    rules = modelRules(modelId)
    return rules.thinking is not None and rules.disable == CANNOT_DISABLE


def modelSupportsStructuredOutput(modelId: str) -> bool:
    model = modelMetadata(modelId)
    if not model:
        return False
    return "structured_outputs" in (model.get("supported_parameters") or [])
