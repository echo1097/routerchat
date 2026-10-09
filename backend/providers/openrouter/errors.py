from __future__ import annotations

import json


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


def openrouterErrorMessage(status_code: int, response_text: str) -> str:
    try:
        payload = json.loads(response_text)
        error = payload.get("error") if isinstance(payload, dict) else None
        error = error if isinstance(error, dict) else {}
        message = error.get("message") or payload.get("message")
        if message:
            detail = providerDetail(error)
            if detail and detail != message:
                return f"OpenRouter error {status_code}: {message} ({detail})"
            return f"OpenRouter error {status_code}: {message}"
    except (json.JSONDecodeError, AttributeError):
        pass
    return f"OpenRouter error {status_code}: {response_text}"
