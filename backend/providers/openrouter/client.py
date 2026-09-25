from __future__ import annotations

import httpx

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MAX_TOKENS = 30000
OPENROUTER_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5"


def headers_for_key(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "HTTP-Referer": "https://echo1097.github.io/get-routerchat/",
        "X-OpenRouter-Title": "RouterChat",
        "X-Title": "RouterChat",
    }
