from __future__ import annotations

import json
from typing import Any

REFUSAL_CATEGORY_NOTES = {
    "general_harms": "its safety filter flagged the content",
    "cyber": "its cybersecurity filter flagged the content",
    "bio": "its biology safety filter flagged the content",
    "frontier_llm": "its model safety filter flagged the content",
    "reasoning_extraction": "the request asked it to reveal its hidden reasoning",
}


def errorDetails(responseText: str) -> tuple[str | None, str | None]:
    try:
        payload = json.loads(responseText)
    except json.JSONDecodeError:
        return None, None
    if not isinstance(payload, dict):
        return None, None

    error = payload.get("error")
    if not isinstance(error, dict):
        return None, payload.get("message")
    return error.get("type"), error.get("message")


def readableError(statusCode: int | None, errorType: str | None, message: str | None) -> str:
    if statusCode == 401 or errorType == "authentication_error":
        return "Anthropic API key is invalid. Check the key in Settings."
    if statusCode == 429 or errorType == "rate_limit_error":
        return "Anthropic rate limit reached. Wait a moment and try again."
    if statusCode == 529 or errorType == "overloaded_error":
        return "Anthropic is overloaded right now. Try again in a moment."
    if statusCode == 404 or errorType == "not_found_error":
        return (
            "Anthropic does not have this model. "
            "This chat may have been started with another provider, so pick a Claude model in a new chat."
        )

    label = f"Anthropic error {statusCode}" if statusCode else "Anthropic error"
    return f"{label}: {message}" if message else label


def anthropicErrorMessage(statusCode: int, responseText: str) -> str:
    errorType, message = errorDetails(responseText)
    return readableError(statusCode, errorType, message or responseText)


def streamErrorMessage(event: dict[str, Any]) -> str:
    error = event.get("error")
    if not isinstance(error, dict):
        return readableError(None, None, None)
    return readableError(None, error.get("type"), error.get("message"))


def refusalMessage(stopDetails: dict[str, Any] | None) -> str:
    category = (stopDetails or {}).get("category")
    note = REFUSAL_CATEGORY_NOTES.get(str(category))
    if note:
        return f"Claude declined to answer because {note}. Try rewording the request or use another model."
    return "Claude declined to answer this request. Try rewording it or use another model."
