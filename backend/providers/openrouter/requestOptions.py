from __future__ import annotations

from typing import Any

from backend.core.appSettings import hourPromptCacheEnabled, readAppSetting
from backend.core.reasoningEffort import ReasoningEffort
from backend.providers.openrouter.models import (
    modelMetadata,
    modelRequiresReasoning,
    modelSupportsReasoning,
)


def openrouterRequestModel(model_id: str, nitro_mode: bool) -> str:
    if not nitro_mode:
        return model_id
    if model_id.endswith(":nitro"):
        return model_id
    return f"{model_id}:nitro"


def openrouterProviderOptions() -> dict[str, Any] | None:
    provider: dict[str, Any] = {}

    if bool(readAppSetting("cheapest_mode")):
        provider["sort"] = "price"

    #zdr is the stricter promise, so it already covers what privacy mode asks for
    if bool(readAppSetting("zdr_mode")):
        provider["zdr"] = True
        provider["data_collection"] = "deny"
    elif bool(readAppSetting("privacy_mode")):
        provider["data_collection"] = "deny"

    return provider or None


def promptCacheControl() -> dict[str, Any] | None:
    if bool(readAppSetting("disable_prompt_caching")):
        return None
    if hourPromptCacheEnabled():
        return {"type": "ephemeral", "ttl": "1h"}
    return {"type": "ephemeral"}


def apiReasoningEffort(value: ReasoningEffort) -> str:
    return "max" if value == "xhigh" else value


def resolvedReasoningEffort(model_id: str, value: ReasoningEffort) -> str:
    preferredEffort = apiReasoningEffort(value)
    model = modelMetadata(model_id)
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


def effectiveThinkingEnabled(model_id: str, thinking_enabled: bool) -> bool:
    return thinking_enabled or modelRequiresReasoning(model_id)


def enabledReasoningConfig(
    model_id: str,
    thinking_enabled: bool,
    reasoning_effort: ReasoningEffort,
) -> dict[str, Any] | None:
    if not modelSupportsReasoning(model_id):
        return None
    if not effectiveThinkingEnabled(model_id, thinking_enabled):
        return None
    return {
        "enabled": True,
        "exclude": False,
        "effort": resolvedReasoningEffort(model_id, reasoning_effort),
    }
