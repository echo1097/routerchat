from __future__ import annotations

from typing import Any

from backend.providers.anthropic.modelRules import (
    ADAPTIVE,
    BUDGET,
    CANNOT_DISABLE,
    DISABLE_WITH_BETWEEN_TOOLS,
    DISABLE_WITH_DISABLED,
    ModelRules,
)
from backend.providers.anthropic.schemaCleaner import cleanSchema
from backend.providers.base import ChatOptions

MIN_THINKING_BUDGET = 1024
ALWAYS_THINKING_MIN_TOKENS = 2048
THINKING_BUDGETS = {"low": 2048, "medium": 8192, "high": 16384, "max": 32000}
EFFORT_ORDER = ("low", "medium", "high", "max")
HIGHEST_EFFORT_WITHOUT_THINKING = "high"
LOWEST_EFFORT = "low"
FIRST_TURN_PLACEHOLDER = "Continue."
THINKING_ON_TYPES = {"enabled", "adaptive"}


def apiEffort(value: str) -> str:
    effort = "max" if value == "xhigh" else value
    return effort if effort in EFFORT_ORDER else "medium"


def clampEffort(effort: str, ceiling: str) -> str:
    if EFFORT_ORDER.index(effort) > EFFORT_ORDER.index(ceiling):
        return ceiling
    return effort


def parseDataUrl(url: str) -> tuple[str, str] | None:
    if not url.startswith("data:") or "," not in url:
        return None
    header, data = url.split(",", 1)
    mediaType = header.removeprefix("data:").split(";", 1)[0]
    return mediaType, "".join(data.split())


def withCacheControl(block: dict[str, Any], part: dict[str, Any]) -> dict[str, Any]:
    if part.get("cache_control"):
        block["cache_control"] = part["cache_control"]
    return block


def imageBlock(part: dict[str, Any]) -> dict[str, Any] | None:
    url = str((part.get("image_url") or {}).get("url") or "")
    if not url:
        return None

    parsed = parseDataUrl(url)
    if parsed is None:
        return {"type": "image", "source": {"type": "url", "url": url}}

    mediaType, data = parsed
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": mediaType, "data": data},
    }


def documentBlock(part: dict[str, Any]) -> dict[str, Any] | None:
    parsed = parseDataUrl(str((part.get("file") or {}).get("file_data") or ""))
    if parsed is None:
        return None

    _, data = parsed
    return {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": data},
    }


def convertPart(part: Any) -> dict[str, Any] | None:
    if isinstance(part, str):
        return {"type": "text", "text": part} if part.strip() else None
    if not isinstance(part, dict):
        return None

    partType = part.get("type")
    if partType == "text":
        text = str(part.get("text") or "")
        if not text.strip():
            return None
        return withCacheControl({"type": "text", "text": text}, part)
    if partType == "image_url":
        block = imageBlock(part)
        return withCacheControl(block, part) if block else None
    if partType == "file":
        block = documentBlock(part)
        return withCacheControl(block, part) if block else None
    return None


def convertContent(content: Any) -> str | list[dict[str, Any]] | None:
    if isinstance(content, str):
        return content if content.strip() else None
    if not isinstance(content, list):
        return None

    blocks = [block for block in (convertPart(part) for part in content) if block]
    if not blocks:
        return None

    documents = [block for block in blocks if block["type"] == "document"]
    others = [block for block in blocks if block["type"] != "document"]
    return documents + others


def systemField(systemContents: list[Any]) -> str | list[dict[str, Any]] | None:
    converted = [convertContent(content) for content in systemContents]
    converted = [content for content in converted if content]
    if not converted:
        return None

    if all(isinstance(content, str) for content in converted):
        return "\n\n".join(content.strip() for content in converted)

    blocks: list[dict[str, Any]] = []
    for content in converted:
        if isinstance(content, str):
            blocks.append({"type": "text", "text": content})
        else:
            blocks.extend(block for block in content if block["type"] == "text")
    return blocks


def splitMessages(
    messages: list[dict[str, Any]],
) -> tuple[str | list[dict[str, Any]] | None, list[dict[str, Any]]]:
    leadingCount = 0
    for message in messages:
        if message.get("role") != "system":
            break
        leadingCount += 1

    system = systemField([message.get("content") for message in messages[:leadingCount]])

    converted: list[dict[str, Any]] = []
    for message in messages[leadingCount:]:
        content = convertContent(message.get("content"))
        if content is None:
            continue
        role = "assistant" if message.get("role") == "assistant" else "user"
        converted.append({"role": role, "content": content})

    if not converted or converted[0]["role"] != "user":
        converted.insert(0, {"role": "user", "content": FIRST_TURN_PLACEHOLDER})

    return system, converted


def thinkingBudget(effort: str, maxTokens: int) -> int | None:
    budget = min(THINKING_BUDGETS[effort], maxTokens - 1)
    return budget if budget >= MIN_THINKING_BUDGET else None


def applyThinking(
    body: dict[str, Any], rules: ModelRules, options: ChatOptions
) -> None:
    effort = apiEffort(options.reasoningEffort)
    outputConfig: dict[str, Any] = body.setdefault("output_config", {})

    if rules.thinking == BUDGET:
        budget = thinkingBudget(effort, body["max_tokens"]) if options.thinkingEnabled else None
        if budget:
            body["thinking"] = {"type": "enabled", "budget_tokens": budget}
        return

    if rules.thinking != ADAPTIVE:
        return

    if options.thinkingEnabled:
        body["thinking"] = {"type": "adaptive", "display": "summarized"}
        outputConfig["effort"] = effort
        return

    if rules.disable == CANNOT_DISABLE:
        body["thinking"] = {"type": "adaptive", "display": "summarized"}
        outputConfig["effort"] = LOWEST_EFFORT
        return

    if rules.disable == DISABLE_WITH_BETWEEN_TOOLS:
        body["thinking"] = {"type": "between_tools"}
    elif rules.disable == DISABLE_WITH_DISABLED:
        body["thinking"] = {"type": "disabled"}
    outputConfig["effort"] = clampEffort(effort, HIGHEST_EFFORT_WITHOUT_THINKING)


def outputFormat(responseFormat: dict[str, Any]) -> dict[str, Any] | None:
    if responseFormat.get("type") != "json_schema":
        return None
    schema = (responseFormat.get("json_schema") or {}).get("schema")
    if not isinstance(schema, dict):
        return None
    return {"type": "json_schema", "schema": cleanSchema(schema)}


def resolvedMaxTokens(rules: ModelRules, options: ChatOptions, modelLimit: int | None) -> int:
    maxTokens = options.maxTokens
    if rules.disable == CANNOT_DISABLE and rules.thinking:
        maxTokens = max(maxTokens, ALWAYS_THINKING_MIN_TOKENS)
    if modelLimit:
        maxTokens = min(maxTokens, modelLimit)
    return maxTokens


def buildBody(
    messages: list[dict[str, Any]],
    model: str,
    options: ChatOptions,
    rules: ModelRules,
    modelLimit: int | None = None,
) -> dict[str, Any]:
    system, converted = splitMessages(messages)

    body: dict[str, Any] = {
        "model": model,
        "max_tokens": resolvedMaxTokens(rules, options, modelLimit),
        "messages": converted,
        "stream": options.stream,
    }
    if system:
        body["system"] = system
    if options.cacheControl:
        body["cache_control"] = options.cacheControl

    applyThinking(body, rules, options)

    thinkingActive = (body.get("thinking") or {}).get("type") in THINKING_ON_TYPES
    if rules.temperature and not thinkingActive:
        body["temperature"] = min(max(options.temperature, 0.0), 1.0)

    if options.responseFormat:
        formatConfig = outputFormat(options.responseFormat)
        if formatConfig:
            body["output_config"]["format"] = formatConfig

    if not body["output_config"]:
        del body["output_config"]

    return body
