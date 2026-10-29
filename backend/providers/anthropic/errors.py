from __future__ import annotations

import json
from typing import Any

from backend.providers.errorKinds import ProviderError, providerError, refusedError

PROVIDER_NAME = "Anthropic"

REFUSAL_CATEGORY_NOTES = {
    "general_harms": "its safety filter flagged the content",
    "cyber": "its cybersecurity filter flagged the content",
    "bio": "its biology safety filter flagged the content",
    "frontier_llm": "its model safety filter flagged the content",
    "reasoning_extraction": "the request asked it to reveal its hidden reasoning",
}

KINDS_BY_TYPE = {
    "authentication_error": "badKey",
    "permission_error": "badKey",
    "billing_error": "noCredit",
    "rate_limit_error": "rateLimited",
    "not_found_error": "modelUnavailable",
    "overloaded_error": "serverError",
    "api_error": "serverError",
}

KINDS_BY_STATUS = {
    401: "badKey",
    402: "noCredit",
    403: "badKey",
    404: "modelUnavailable",
    429: "rateLimited",
    529: "serverError",
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


def errorKind(statusCode: int | None, errorType: str | None, message: str | None) -> str:
    lowered = (message or "").lower()
    if "credit balance" in lowered:
        return "noCredit"
    if "prompt is too long" in lowered or "context window" in lowered:
        return "contextTooLong"
    if errorType in KINDS_BY_TYPE:
        return KINDS_BY_TYPE[errorType]
    if statusCode in KINDS_BY_STATUS:
        return KINDS_BY_STATUS[statusCode]
    if statusCode and statusCode >= 500:
        return "serverError"
    if statusCode and statusCode >= 400:
        return "badRequest"
    return "unknown"


def readableError(statusCode: int | None, errorType: str | None, message: str | None) -> ProviderError:
    kind = errorKind(statusCode, errorType, message)
    return providerError(kind, PROVIDER_NAME, message)


def anthropicError(statusCode: int, responseText: str) -> ProviderError:
    errorType, message = errorDetails(responseText)
    return readableError(statusCode, errorType, message)


def streamError(event: dict[str, Any]) -> ProviderError:
    error = event.get("error")
    if not isinstance(error, dict):
        return readableError(None, None, None)
    return readableError(None, error.get("type"), error.get("message"))


def refusalError(stopDetails: dict[str, Any] | None) -> ProviderError:
    category = (stopDetails or {}).get("category")
    note = REFUSAL_CATEGORY_NOTES.get(str(category))
    if note:
        return refusedError(f"Claude declined to answer because {note}. Try rewording the request or use another model.")
    return refusedError("Claude declined to answer this request. Try rewording it or use another model.")
