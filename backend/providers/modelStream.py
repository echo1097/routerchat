from contextlib import aclosing
from typing import Any, AsyncIterator

from backend.providers.base import ChatRequest, Provider
from backend.providers.streaming import streamChat


class ModelStream:
    def __init__(self, provider: Provider, request: ChatRequest, thinkingEnabled: bool = True):
        self.provider = provider
        self.request = request
        self.thinkingEnabled = thinkingEnabled
        self.textParts: list[str] = []
        self.reasoningParts: list[str] = []
        self.generationId: str | None = None
        self.usage: dict[str, Any] = {}
        self.finishReason: str | None = None
        self.receivedDone = False
        self.errorMessage: str | None = None

    @property
    def text(self) -> str:
        return "".join(self.textParts)

    async def fetchFinalUsage(self, apiKey: str) -> None:
        if not self.generationId:
            return
        finalUsage = await self.provider.fetchFinalUsage(apiKey, self.generationId)
        if finalUsage:
            self.usage.update(finalUsage)

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        contentStarted = False

        async with aclosing(streamChat(self.provider, self.request)) as events:
            async for event in events:
                if event["type"] == "error":
                    self.generationId = event["generationId"] or self.generationId
                    self.errorMessage = str(event["message"])
                    continue
                if event["type"] == "open":
                    self.generationId = event["generationId"] or self.generationId
                    continue
                if event["type"] == "done":
                    self.receivedDone = True
                    continue

                self.generationId = self.generationId or event["id"]
                if event["usage"]:
                    self.usage.update(event["usage"])
                if not event["hasChoice"]:
                    continue
                self.finishReason = event["finishReason"] or self.finishReason
                if event["sources"]:
                    yield {"type": "sources", "value": event["sources"]}
                if event["reasoning"] and self.thinkingEnabled:
                    self.reasoningParts.append(event["reasoning"])
                    yield {"type": "reasoning", "value": event["reasoning"]}
                if event["content"]:
                    if not contentStarted:
                        contentStarted = True
                        yield {"type": "contentStart"}
                    self.textParts.append(event["content"])
                    yield {"type": "content", "value": event["content"]}
