from __future__ import annotations

from typing import Any

import httpx

from backend.core.appSettings import hourPromptCacheEnabled, readAppSetting
from backend.providers.anthropic import apiKey as keyStore
from backend.providers.anthropic import models as modelStore
from backend.providers.anthropic import requestBuilder, streamParser
from backend.providers.anthropic.client import (
    ANTHROPIC_BASE_URL,
    ANTHROPIC_MAX_IMAGE_BYTES,
    ANTHROPIC_MAX_REQUEST_ATTACHMENT_BYTES,
    ANTHROPIC_TIMEOUT,
    headersForKey,
)
from backend.providers.anthropic.errors import anthropicErrorMessage
from backend.providers.base import (
    Capabilities,
    ChatOptions,
    ChatRequest,
    Provider,
    StreamParser,
)


class AnthropicProvider(Provider):
    id = "anthropic"
    name = "Anthropic"
    keyPlaceholder = "sk-ant-..."
    timeout = ANTHROPIC_TIMEOUT
    defaultModelSetting = modelStore.DEFAULT_MODEL_SETTING
    capabilities = Capabilities(
        webSearch=False,
        pdfParsing=True,
        cost=True,
        routingOptions=False,
        transcription=False,
        freeModels=False,
        maxImageBytes=ANTHROPIC_MAX_IMAGE_BYTES,
        maxRequestAttachmentBytes=ANTHROPIC_MAX_REQUEST_ATTACHMENT_BYTES,
    )

    def readKey(self) -> str | None:
        return keyStore.readAnthropicKey()

    def writeKey(self, apiKey: str) -> None:
        keyStore.writeAnthropicKey(apiKey)

    async def validateKey(self, apiKey: str) -> dict[str, Any]:
        return await keyStore.validateKey(apiKey)

    async def keyStatus(self) -> dict[str, Any]:
        return self.normalizeKeyStatus(None, bool(self.readKey()))

    async def listModels(self, apiKey: str) -> list[dict[str, Any]]:
        return await modelStore.fetchModels(apiKey)

    def cachedModels(self) -> list[dict[str, Any]]:
        return modelStore.cachedModels()

    def cacheModels(self, models: list[dict[str, Any]]) -> None:
        modelStore.cacheModels(models)

    def defaultModelId(self) -> str:
        return modelStore.defaultModelId()

    def supportsReasoning(self, modelId: str) -> bool:
        return modelStore.modelSupportsReasoning(modelId)

    def effectiveThinkingEnabled(self, modelId: str, thinkingEnabled: bool) -> bool:
        return thinkingEnabled or modelStore.modelRequiresReasoning(modelId)

    def supportsStructuredOutput(self, modelId: str) -> bool:
        return modelStore.modelSupportsStructuredOutput(modelId)

    def maxPdfPages(self, modelId: str) -> int | None:
        return modelStore.maxPdfPages(modelId)

    def promptCacheControl(self) -> dict[str, Any] | None:
        if bool(readAppSetting("disable_prompt_caching")):
            return None
        if hourPromptCacheEnabled():
            return {"type": "ephemeral", "ttl": "1h"}
        return {"type": "ephemeral"}

    def buildRequest(
        self, messages: list[dict[str, Any]], model: str, options: ChatOptions
    ) -> ChatRequest:
        body = requestBuilder.buildBody(
            messages,
            model,
            options,
            modelStore.modelRules(model),
            modelStore.maxOutputTokens(model),
            modelStore.modelEfforts(model),
        )
        return ChatRequest(
            url=f"{ANTHROPIC_BASE_URL}/messages",
            headers=headersForKey(options.apiKey),
            body=body,
        )

    def generationIdFromHeaders(self, headers: httpx.Headers) -> str | None:
        return headers.get("request-id")

    def createStreamParser(self) -> StreamParser:
        return streamParser.AnthropicStreamParser()

    def completionText(self, payload: dict[str, Any]) -> str | None:
        return streamParser.completionText(payload)

    def errorMessage(self, statusCode: int, responseText: str) -> str:
        return anthropicErrorMessage(statusCode, responseText)


anthropicProvider = AnthropicProvider()
