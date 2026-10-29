from __future__ import annotations

import json
from typing import Any

from backend.providers.errorKinds import ProviderError, providerError, refusedError

PROVIDER_NAME = "OpenRouter"

KINDS_BY_STATUS = {
    401: "badKey",
    402: "noCredit",
    404: "modelUnavailable",
    408: "timeout",
    429: "rateLimited",
    502: "serverError",
    503: "modelUnavailable",
}

CONTEXT_PHRASES = (
    "context length",
    "context window",
    "prompt is too long",
    "too many tokens",
)


def providerDetail(error: dict) -> str:
    metadata = error.get("metadata")
    if not isinstance(metadata, dict):
        return ""
    raw = metadata.get("raw")
    if raw is None or raw == "":
        return ""
    if isinstance(raw, (dict, list)):
        return json.dumps(raw)
    return str(raw)


def errorParts(responseText: str) -> tuple[str, str]:
    try:
        payload = json.loads(responseText)
    except json.JSONDecodeError:
        return "", ""
    if not isinstance(payload, dict):
        return "", ""

    error = payload.get("error")
    error = error if isinstance(error, dict) else {}
    message = str(error.get("message") or payload.get("message") or "")
    return message, providerDetail(error)


def combinedDetail(message: str, detail: str) -> str:
    if detail and detail != message:
        return f"{message} ({detail})" if message else detail
    return message


def errorKind(statusCode: int | None, text: str) -> str:
    lowered = text.lower()
    if any(phrase in lowered for phrase in CONTEXT_PHRASES):
        return "contextTooLong"
    if statusCode == 403:
        return "contentRefused"
    if statusCode in KINDS_BY_STATUS:
        return KINDS_BY_STATUS[statusCode]
    if statusCode and statusCode >= 500:
        return "serverError"
    if statusCode and statusCode >= 400:
        return "badRequest"
    return "unknown"


def readableError(statusCode: int | None, message: str, detail: str) -> ProviderError:
    text = combinedDetail(message, detail)
    kind = errorKind(statusCode, text)
    if kind == "contentRefused":
        return refusedError(
            "OpenRouter's moderation flagged this request. Try rewording it or use another model."
        )
    return providerError(kind, PROVIDER_NAME, text)


def openrouterError(statusCode: int, responseText: str) -> ProviderError:
    message, detail = errorParts(responseText)
    return readableError(statusCode, message, detail)


def streamError(error: dict[str, Any]) -> ProviderError:
    code = error.get("code")
    statusCode = code if isinstance(code, int) else None
    if statusCode is None and str(code).isdigit():
        statusCode = int(str(code))
    if statusCode is None:
        statusCode = 500
    return readableError(statusCode, str(error.get("message") or ""), providerDetail(error))
