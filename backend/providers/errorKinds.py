from __future__ import annotations

import json
from typing import Any

MAX_DETAIL_LENGTH = 200

ERROR_TEXT = {
    "badKey": (
        "API key isn't working",
        "{provider} rejected your API key. It may have been deleted or mistyped. Update it in Settings.",
    ),
    "noCredit": (
        "Out of {provider} credit",
        "Your {provider} account doesn't have enough credit for this model. Add credit, then try again.",
    ),
    "rateLimited": (
        "Too many requests",
        "{provider} is limiting how fast you can send. Wait a moment, then try again.",
    ),
    "modelUnavailable": (
        "Model isn't available",
        "{provider} can't run this model right now. It may have been removed or be temporarily offline. Pick another model.",
    ),
    "contextTooLong": (
        "Conversation is too long",
        "This chat is longer than the model can read at once. Start a new chat or pick a model with a bigger context window.",
    ),
    "contentRefused": (
        "Model declined",
        "The model declined to answer this request. Try rewording it or use another model.",
    ),
    "badRequest": (
        "Request wasn't accepted",
        "{provider} couldn't accept this request: {detail}",
    ),
    "serverError": (
        "{provider} is having trouble",
        "{provider} returned an error on their side. This is usually temporary, so try again shortly.",
    ),
    "network": (
        "Lost connection to {provider}",
        "The connection dropped before the reply finished. Check your internet connection, then try again.",
    ),
    "unreachable": (
        "Couldn't reach {provider}",
        "RouterChat couldn't connect to {provider}. Check your internet connection, then try again.",
    ),
    "timeout": (
        "{provider} took too long",
        "{provider} stopped responding. Try again, or pick a faster model.",
    ),
    "incomplete": (
        "Reply didn't finish",
        "The model stopped before it finished. Try again.",
    ),
    "unknown": (
        "Something went wrong",
        "RouterChat hit an unexpected problem. Try again, and if it keeps happening check the logs.",
    ),
}


class ProviderError(Exception):
    def __init__(self, kind: str, title: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.title = title
        self.message = message

    def toEvent(self) -> dict[str, str]:
        return {"kind": self.kind, "title": self.title, "message": self.message}

    def toJson(self) -> str:
        return json.dumps(self.toEvent())


def shortDetail(detail: Any) -> str:
    text = " ".join(str(detail or "").split())
    if len(text) > MAX_DETAIL_LENGTH:
        text = text[: MAX_DETAIL_LENGTH - 3].rstrip() + "..."
    return text


def providerError(kind: str, provider: str, detail: Any = None) -> ProviderError:
    title, message = ERROR_TEXT.get(kind, ERROR_TEXT["unknown"])
    detailText = shortDetail(detail) or "no reason was given"
    if kind == "badRequest" and not detailText.endswith((".", "!", "?")):
        detailText += "."
    return ProviderError(
        kind if kind in ERROR_TEXT else "unknown",
        title.format(provider=provider),
        message.format(provider=provider, detail=detailText),
    )


def refusedError(message: str) -> ProviderError:
    title, _ = ERROR_TEXT["contentRefused"]
    return ProviderError("contentRefused", title, message)


def appError(title: str, message: str, kind: str = "unknown") -> ProviderError:
    return ProviderError(kind, title, message)


def unexpectedError() -> ProviderError:
    title, message = ERROR_TEXT["unknown"]
    return ProviderError("unknown", title, message)
