from __future__ import annotations

from typing import Any

from backend.core.appSettings import hourPromptCacheEnabled, read_app_setting
from backend.core.reasoningEffort import ReasoningEffort
from backend.providers.openrouter.models import (
    model_metadata,
    model_requires_reasoning,
    model_supports_reasoning,
)


def openrouter_request_model(model_id: str, nitro_mode: bool) -> str:
    if not nitro_mode:
        return model_id
    if model_id.endswith(":nitro"):
        return model_id
    return f"{model_id}:nitro"


def openrouter_provider_options() -> dict[str, Any] | None:
    provider: dict[str, Any] = {}

    if bool(read_app_setting("cheapest_mode")):
        provider["sort"] = "price"

    #zdr is the stricter promise, so it already covers what privacy mode asks for
    if bool(read_app_setting("zdr_mode")):
        provider["zdr"] = True
        provider["data_collection"] = "deny"
    elif bool(read_app_setting("privacy_mode")):
        provider["data_collection"] = "deny"

    return provider or None


def prompt_cache_control() -> dict[str, Any] | None:
    if bool(read_app_setting("disable_prompt_caching")):
        return None
    if hourPromptCacheEnabled():
        return {"type": "ephemeral", "ttl": "1h"}
    return {"type": "ephemeral"}


def api_reasoning_effort(value: ReasoningEffort) -> str:
    return "max" if value == "xhigh" else value


def resolved_reasoning_effort(model_id: str, value: ReasoningEffort) -> str:
    preferredEffort = api_reasoning_effort(value)
    model = model_metadata(model_id)
    supportedEfforts = (model or {}).get("reasoning", {}).get("supported_efforts")

    if not isinstance(supportedEfforts, list):
        return preferredEffort

    effortOrder = ["low", "medium", "high", "max"]
    availableEfforts = {
        "max" if effort == "xhigh" else effort
        for effort in supportedEfforts
        if effort in {*effortOrder, "xhigh"}
    }
    if preferredEffort in availableEfforts:
        return preferredEffort

    try:
        preferredIndex = effortOrder.index(preferredEffort)
    except ValueError:
        return preferredEffort

    for effort in effortOrder[preferredIndex + 1:]:
        if effort in availableEfforts:
            return effort
    for effort in reversed(effortOrder[:preferredIndex]):
        if effort in availableEfforts:
            return effort
    return preferredEffort


def effective_thinking_enabled(model_id: str, thinking_enabled: bool) -> bool:
    return thinking_enabled or model_requires_reasoning(model_id)


def enabled_reasoning_config(
    model_id: str,
    thinking_enabled: bool,
    reasoning_effort: ReasoningEffort,
) -> dict[str, Any] | None:
    if not model_supports_reasoning(model_id):
        return None
    if not effective_thinking_enabled(model_id, thinking_enabled):
        return None
    return {
        "enabled": True,
        "exclude": False,
        "effort": resolved_reasoning_effort(model_id, reasoning_effort),
    }
