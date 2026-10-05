from __future__ import annotations

import httpx

ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)
FALLBACK_MODEL_ID = "claude-sonnet-5-5"
ANTHROPIC_MAX_ENCODED_IMAGE_BYTES = 10 * 1024 * 1024
ANTHROPIC_MAX_IMAGE_BYTES = ANTHROPIC_MAX_ENCODED_IMAGE_BYTES // 4 * 3
ANTHROPIC_MAX_REQUEST_BYTES = 32 * 1024 * 1024
ANTHROPIC_TEXT_RESERVE_BYTES = 4 * 1024 * 1024
ANTHROPIC_MAX_REQUEST_ATTACHMENT_BYTES = (
    (ANTHROPIC_MAX_REQUEST_BYTES - ANTHROPIC_TEXT_RESERVE_BYTES) // 4 * 3
)


def headersForKey(apiKey: str) -> dict[str, str]:
    return {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }
