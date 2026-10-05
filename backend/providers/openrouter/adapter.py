from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException

from backend.providers.base import Capabilities, ChatOptions, ChatRequest, Provider
from backend.providers.openrouter import apiKey as keyStore
from backend.providers.openrouter import models as modelStore
from backend.providers.openrouter import requestOptions, usage
from backend.providers.openrouter.client import (
    OPENROUTER_BASE_URL,
    OPENROUTER_TIMEOUT,
    headers_for_key,
)
from backend.providers.openrouter.errors import openrouter_error_message
from backend.webSearch.sources import normalize_sources


class OpenRouterProvider(Provider):
    id = "openrouter"
    name = "OpenRouter"
    keyPlaceholder = "sk-or-v1-..."
    timeout = OPENROUTER_TIMEOUT
    capabilities = Capabilities(
        webSearch=True,
        pdfParsing=True,
        cost=True,
        routingOptions=True,
        transcription=True,
        freeModels=True,
    )

    def readKey(self) -> str | None:
        return keyStore.read_openrouter_key()

    def writeKey(self, apiKey: str) -> None:
        keyStore.write_openrouter_key(apiKey)

    async def validateKey(self, apiKey: str) -> dict[str, Any]:
        return await keyStore.validate_key(apiKey)

    async def keyStatus(self) -> dict[str, Any]:
        savedKey = self.readKey()
        if not savedKey:
            return self.normalizeKeyStatus(None, False)
        try:
            return self.normalizeKeyStatus(await self.validateKey(savedKey), True)
        except HTTPException:
            return self.normalizeKeyStatus(None, True)

    async def listModels(self, apiKey: str) -> list[dict[str, Any]]:
        return await modelStore.fetch_models_from_openrouter(apiKey)

    def cachedModels(self) -> list[dict[str, Any]]:
        return modelStore.cached_models()

    def cacheModels(self, models: list[dict[str, Any]]) -> None:
        modelStore.cache_models(models)

    def defaultModelId(self) -> str:
        return modelStore.default_model_id()

    def supportsReasoning(self, modelId: str) -> bool:
        return modelStore.model_supports_reasoning(modelId)

    def effectiveThinkingEnabled(self, modelId: str, thinkingEnabled: bool) -> bool:
        return requestOptions.effective_thinking_enabled(modelId, thinkingEnabled)

    def supportsStructuredOutput(self, modelId: str) -> bool:
        return modelStore.model_supports_structured_output(modelId)

    def promptCacheControl(self) -> dict[str, Any] | None:
        return requestOptions.prompt_cache_control()

    def buildRequest(
        self, messages: list[dict[str, Any]], model: str, options: ChatOptions
    ) -> ChatRequest:
        body: dict[str, Any] = {
            "model": requestOptions.openrouter_request_model(model, options.nitro),
            "messages": messages,
            "temperature": options.temperature,
            "max_tokens": options.maxTokens,
            "stream": options.stream,
        }

        providerOptions = requestOptions.openrouter_provider_options()
        if providerOptions:
            body["provider"] = providerOptions

        if options.cacheControl:
            body["cache_control"] = options.cacheControl
        if options.sessionId:
            body["session_id"] = options.sessionId

        if options.plugins:
            body["plugins"] = options.plugins

        reasoningConfig = requestOptions.enabled_reasoning_config(
            model, options.thinkingEnabled, options.reasoningEffort
        )
        if reasoningConfig:
            body["reasoning"] = reasoningConfig
            if options.explicitReasoning:
                body["reasoning_effort"] = reasoningConfig["effort"]
        elif options.explicitReasoning and self.supportsReasoning(model):
            body["reasoning"] = {"enabled": False, "exclude": True}
            body["reasoning_effort"] = "none"
            body["include_reasoning"] = False

        if options.responseFormat:
            body["response_format"] = options.responseFormat

        return ChatRequest(
            url=f"{OPENROUTER_BASE_URL}/chat/completions",
            headers={**headers_for_key(options.apiKey), "Content-Type": "application/json"},
            body=body,
        )

    def generationIdFromHeaders(self, headers: httpx.Headers) -> str | None:
        return headers.get("X-Generation-Id")

    def parseStreamChunk(self, chunk: dict[str, Any]) -> dict[str, Any]:
        parsed: dict[str, Any] = {
            "id": chunk.get("id"),
            "usage": usage.normalize_usage(chunk.get("usage")),
            "hasChoice": False,
            "finishReason": None,
            "reasoning": None,
            "content": None,
            "sources": [],
        }

        choices = chunk.get("choices") or []
        if not choices:
            return parsed

        choice = choices[0]
        delta = choice.get("delta") or {}
        message = choice.get("message") or {}
        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
        content = delta.get("content")

        parsed["hasChoice"] = True
        parsed["finishReason"] = choice.get("finish_reason")
        parsed["reasoning"] = str(reasoning) if reasoning else None
        parsed["content"] = str(content) if content else None
        parsed["sources"] = normalize_sources(
            delta.get("annotations") or message.get("annotations")
        )
        return parsed

    def completionText(self, payload: dict[str, Any]) -> str | None:
        choices = payload.get("choices") or []
        if not choices:
            return None
        return (choices[0].get("message") or {}).get("content")

    def errorMessage(self, statusCode: int, responseText: str) -> str:
        return openrouter_error_message(statusCode, responseText)

    async def fetchFinalUsage(self, apiKey: str, generationId: str) -> dict[str, Any] | None:
        return await usage.fetch_generation_usage(apiKey, generationId)


openRouterProvider = OpenRouterProvider()
