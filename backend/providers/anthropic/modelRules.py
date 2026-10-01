from __future__ import annotations

from dataclasses import dataclass
from typing import Any

ADAPTIVE = "adaptive"
BUDGET = "budget"

DISABLE_WITH_DISABLED = "disabled"
DISABLE_WITH_BETWEEN_TOOLS = "betweenTools"
DISABLE_BY_OMITTING = "omit"
CANNOT_DISABLE = "never"


@dataclass(frozen=True)
class ModelRules:
    thinking: str | None
    disable: str
    temperature: bool


ALWAYS_THINKING = ModelRules(thinking=ADAPTIVE, disable=CANNOT_DISABLE, temperature=False)
ADAPTIVE_STRICT = ModelRules(thinking=ADAPTIVE, disable=DISABLE_WITH_DISABLED, temperature=False)
ADAPTIVE_BETWEEN_TOOLS = ModelRules(
    thinking=ADAPTIVE, disable=DISABLE_WITH_BETWEEN_TOOLS, temperature=False
)
ADAPTIVE_CLASSIC = ModelRules(thinking=ADAPTIVE, disable=DISABLE_WITH_DISABLED, temperature=True)
BUDGET_THINKING = ModelRules(thinking=BUDGET, disable=DISABLE_BY_OMITTING, temperature=True)
NO_THINKING = ModelRules(thinking=None, disable=DISABLE_BY_OMITTING, temperature=True)

RULES_BY_PREFIX: tuple[tuple[str, ModelRules], ...] = (
    ("claude-fable-5", ALWAYS_THINKING),
    ("claude-mythos-5", ALWAYS_THINKING),
    ("claude-opus-5-5", ALWAYS_THINKING),
    ("claude-opus-5", ADAPTIVE_STRICT),
    ("claude-opus-4-8", ADAPTIVE_STRICT),
    ("claude-opus-4-7", ADAPTIVE_STRICT),
    ("claude-sonnet-5-5", ADAPTIVE_BETWEEN_TOOLS),
    ("claude-sonnet-5", ADAPTIVE_STRICT),
    ("claude-opus-4-6", ADAPTIVE_CLASSIC),
    ("claude-sonnet-4-6", ADAPTIVE_CLASSIC),
)


def supported(capabilities: dict[str, Any], *path: str) -> bool:
    node: Any = capabilities
    for key in path:
        if not isinstance(node, dict):
            return False
        node = node.get(key)
    return isinstance(node, dict) and node.get("supported") is True


def rulesFromCapabilities(capabilities: dict[str, Any] | None) -> ModelRules:
    capabilities = capabilities or {}
    if supported(capabilities, "thinking", "types", "adaptive"):
        return ALWAYS_THINKING
    if supported(capabilities, "thinking", "types", "enabled"):
        return BUDGET_THINKING
    if supported(capabilities, "thinking"):
        return BUDGET_THINKING
    return NO_THINKING


def rulesFor(modelId: str, capabilities: dict[str, Any] | None = None) -> ModelRules:
    cleanId = str(modelId or "")
    for prefix, rules in RULES_BY_PREFIX:
        if cleanId.startswith(prefix):
            return rules

    if capabilities is None and cleanId.startswith("claude-"):
        return BUDGET_THINKING
    return rulesFromCapabilities(capabilities)
