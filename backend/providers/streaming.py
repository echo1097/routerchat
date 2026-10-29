from __future__ import annotations

import json
from typing import Any, AsyncGenerator

import httpx

from backend.providers.base import ChatRequest, Provider
from backend.providers.errorKinds import providerError


async def streamChat(provider: Provider, request: ChatRequest) -> AsyncGenerator[dict[str, Any], None]:
    generationId: str | None = None

    try:
        async with httpx.AsyncClient(timeout=provider.timeout) as client:
            async with client.stream(
                "POST",
                request.url,
                headers=request.headers,
                json=request.body,
            ) as response:
                generationId = provider.generationIdFromHeaders(response.headers)

                if response.status_code >= 400:
                    rawError = (await response.aread()).decode("utf-8", errors="replace")
                    yield {
                        "type": "error",
                        "error": provider.providerError(response.status_code, rawError),
                        "generationId": generationId,
                    }
                    return

                yield {"type": "open", "generationId": generationId}
                parser = provider.createStreamParser()

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line.removeprefix("data:").strip()
                    if data == "[DONE]":
                        yield {"type": "done"}
                        return
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue

                    for parsed in parser.parse(chunk):
                        eventKind = parsed.pop("event", "chunk")
                        if eventKind == "error":
                            yield {
                                "type": "error",
                                "error": parsed["error"],
                                "generationId": generationId,
                            }
                            return
                        if eventKind == "done":
                            yield {"type": "done"}
                            return
                        yield {"type": "chunk", **parsed}
    except httpx.TimeoutException:
        yield {"type": "error", "error": providerError("timeout", provider.name), "generationId": generationId}
    except httpx.ConnectError:
        yield {"type": "error", "error": providerError("unreachable", provider.name), "generationId": generationId}
    except httpx.TransportError:
        yield {"type": "error", "error": providerError("network", provider.name), "generationId": generationId}


async def sendChat(
    provider: Provider, request: ChatRequest, timeout: httpx.Timeout
) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                request.url,
                headers=request.headers,
                json=request.body,
            )
        if response.status_code >= 400:
            return None
        return response.json()
    except (httpx.HTTPError, json.JSONDecodeError, ValueError):
        return None
