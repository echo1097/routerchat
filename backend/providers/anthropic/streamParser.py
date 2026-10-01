from __future__ import annotations

from typing import Any

from backend.providers.anthropic.errors import refusalMessage, streamErrorMessage
from backend.providers.anthropic.pricing import costFor

FINISH_REASONS = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "model_context_window_exceeded": "length",
}
USAGE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_creation",
)


def emptyChunk(messageId: str | None) -> dict[str, Any]:
    return {
        "id": messageId,
        "usage": None,
        "hasChoice": False,
        "finishReason": None,
        "reasoning": None,
        "content": None,
        "sources": [],
    }


def mergeUsage(current: dict[str, Any], update: dict[str, Any] | None) -> dict[str, Any]:
    merged = dict(current)
    for field in USAGE_FIELDS:
        value = (update or {}).get(field)
        if value is not None:
            merged[field] = value
    return merged


def normalizeUsage(model: str | None, usage: dict[str, Any]) -> dict[str, Any]:
    cacheRead = usage.get("cache_read_input_tokens") or 0
    cacheWrite = usage.get("cache_creation_input_tokens") or 0
    promptTokens = (usage.get("input_tokens") or 0) + cacheRead + cacheWrite
    completionTokens = usage.get("output_tokens") or 0

    return {
        "prompt_tokens": promptTokens,
        "completion_tokens": completionTokens,
        "reasoning_tokens": None,
        "cached_tokens": cacheRead,
        "total_tokens": promptTokens + completionTokens,
        "cost": costFor(model, usage),
        "provider_name": "Anthropic",
        "generation_time": None,
        "latency": None,
    }


class AnthropicStreamParser:
    def __init__(self) -> None:
        self.messageId: str | None = None
        self.model: str | None = None
        self.usage: dict[str, Any] = {}

    def parse(self, chunk: dict[str, Any]) -> list[dict[str, Any]]:
        eventType = chunk.get("type")

        if eventType == "message_start":
            return self.messageStart(chunk)
        if eventType == "content_block_delta":
            return self.contentDelta(chunk)
        if eventType == "message_delta":
            return self.messageDelta(chunk)
        if eventType == "message_stop":
            return [{"event": "done"}]
        if eventType == "error":
            return [{"event": "error", "message": streamErrorMessage(chunk)}]
        return []

    def messageStart(self, chunk: dict[str, Any]) -> list[dict[str, Any]]:
        message = chunk.get("message") or {}
        self.messageId = message.get("id")
        self.model = message.get("model")
        self.usage = mergeUsage({}, message.get("usage"))
        return [emptyChunk(self.messageId)]

    def contentDelta(self, chunk: dict[str, Any]) -> list[dict[str, Any]]:
        delta = chunk.get("delta") or {}
        deltaType = delta.get("type")
        parsed = emptyChunk(self.messageId)
        parsed["hasChoice"] = True

        if deltaType == "text_delta" and delta.get("text"):
            parsed["content"] = str(delta["text"])
            return [parsed]
        if deltaType == "thinking_delta" and delta.get("thinking"):
            parsed["reasoning"] = str(delta["thinking"])
            return [parsed]
        return []

    def messageDelta(self, chunk: dict[str, Any]) -> list[dict[str, Any]]:
        delta = chunk.get("delta") or {}
        stopReason = delta.get("stop_reason")
        self.usage = mergeUsage(self.usage, chunk.get("usage"))

        events: list[dict[str, Any]] = []
        if self.usage:
            usageChunk = emptyChunk(self.messageId)
            usageChunk["usage"] = normalizeUsage(self.model, self.usage)
            events.append(usageChunk)

        if stopReason == "refusal":
            events.append({"event": "error", "message": refusalMessage(delta.get("stop_details"))})
            return events

        if stopReason:
            finishChunk = emptyChunk(self.messageId)
            finishChunk["hasChoice"] = True
            finishChunk["finishReason"] = FINISH_REASONS.get(stopReason, stopReason)
            events.append(finishChunk)
        return events


def completionText(payload: dict[str, Any]) -> str | None:
    if payload.get("stop_reason") == "refusal":
        return None

    texts = [
        str(block.get("text") or "")
        for block in payload.get("content") or []
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    joined = "".join(texts)
    return joined or None
