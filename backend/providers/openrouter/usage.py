from __future__ import annotations

import asyncio
from typing import Any

import httpx

from backend.core.utils import floatOrNone, intOrNone
from backend.providers.openrouter.client import OPENROUTER_BASE_URL, headersForKey


def normalizeUsage(usage: dict[str, Any] | None) -> dict[str, Any] | None:
    if not usage:
        return None
    completion_details = usage.get("completion_tokens_details") or {}
    promptDetails = usage.get("prompt_tokens_details") or {}
    # Context meter reference math, kept here for future backend-side use:
    # prompt_tokens = int_or_none(usage.get("prompt_tokens"))
    # completion_tokens = int_or_none(usage.get("completion_tokens"))
    # current_context_tokens = int_or_none(usage.get("total_tokens"))
    # if current_context_tokens is None and prompt_tokens is not None and completion_tokens is not None:
    #     current_context_tokens = prompt_tokens + completion_tokens
    return {
        "prompt_tokens": intOrNone(usage.get("prompt_tokens")),
        "completion_tokens": intOrNone(usage.get("completion_tokens")),
        "reasoning_tokens": intOrNone(completion_details.get("reasoning_tokens")),
        "cached_tokens": intOrNone(promptDetails.get("cached_tokens")),
        "total_tokens": intOrNone(usage.get("total_tokens")),
        "cost": floatOrNone(usage.get("cost")),
        "provider_name": usage.get("provider_name"),
        "generation_time": floatOrNone(usage.get("generation_time")),
        "latency": floatOrNone(usage.get("latency")),
    }


def normalizeGenerationUsage(data: dict[str, Any] | None) -> dict[str, Any] | None:
    if not data:
        return None
    promptTokens = intOrNone(data.get("native_tokens_prompt"))
    if promptTokens is None:
        promptTokens = intOrNone(data.get("tokens_prompt"))
    completionTokens = intOrNone(data.get("native_tokens_completion"))
    if completionTokens is None:
        completionTokens = intOrNone(data.get("tokens_completion"))
    cost = floatOrNone(data.get("total_cost"))
    if cost is None:
        cost = floatOrNone(data.get("usage"))
    totalTokens = (
        promptTokens + completionTokens
        if promptTokens is not None and completionTokens is not None
        else None
    )
    return {
        "prompt_tokens": promptTokens,
        "completion_tokens": completionTokens,
        "reasoning_tokens": intOrNone(data.get("native_tokens_reasoning")),
        "cached_tokens": intOrNone(data.get("native_tokens_cached")),
        "total_tokens": totalTokens,
        "cost": cost,
        "provider_name": data.get("provider_name"),
        "generation_time": floatOrNone(data.get("generation_time")),
        "latency": floatOrNone(data.get("latency")),
    }


async def fetchGenerationUsage(
    api_key: str, generation_id: str
) -> dict[str, Any] | None:
    retry_delays = [0.0, 0.35, 0.8, 1.5]
    async with httpx.AsyncClient(timeout=15.0) as client:
        for delay in retry_delays:
            if delay:
                await asyncio.sleep(delay)
            response = await client.get(
                f"{OPENROUTER_BASE_URL}/generation",
                headers=headersForKey(api_key),
                params={"id": generation_id},
            )
            if response.status_code == 404:
                continue
            if response.status_code >= 400:
                return None
            return normalizeGenerationUsage(response.json().get("data"))
    return None
