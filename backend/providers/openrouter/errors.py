from __future__ import annotations

import json


def openrouter_error_message(status_code: int, response_text: str) -> str:
    try:
        payload = json.loads(response_text)
        message = payload.get("error", {}).get("message") or payload.get("message")
        if message:
            return f"OpenRouter error {status_code}: {message}"
    except json.JSONDecodeError:
        pass
    return f"OpenRouter error {status_code}: {response_text}"
