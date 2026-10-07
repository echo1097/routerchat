from contextlib import aclosing
from typing import Any, AsyncIterator

from backend.lorebook.lorebookUsage import LorebookUsage
from backend.providers.base import ChatRequest, Provider
from backend.providers.streaming import streamChat


class LorebookStream:
    def __init__(
        self,
        provider: Provider,
        request: ChatRequest,
        usageRun: LorebookUsage,
        thinkingEnabled: bool,
    ):
        self.provider = provider
        self.request = request
        self.usageRun = usageRun
        self.thinkingEnabled = thinkingEnabled
        self.textParts: list[str] = []
        self.finishReason: str | None = None
        self.receivedDone = False
        self.errorMessage: str | None = None

    @property
    def text(self) -> str:
        return "".join(self.textParts)

    def usageEventValue(self) -> dict[str, Any] | None:
        if not self.usageRun.usage:
            return None
        return {
            "generation_id": self.usageRun.generationId,
            "model": self.usageRun.model,
            **self.usageRun.usage,
        }

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        contentStarted = False

        async with self.usageRun:
            async with aclosing(streamChat(self.provider, self.request)) as events:
                async for event in events:
                    if event["type"] in ("error", "open"):
                        self.usageRun.generationId = event["generationId"]
                    if event["type"] == "error":
                        self.errorMessage = event["message"]
                        continue
                    if event["type"] == "open":
                        continue
                    if event["type"] == "done":
                        self.receivedDone = True
                        continue

                    self.usageRun.generationId = self.usageRun.generationId or event["id"]
                    self.usageRun.addUsage(event["usage"])

                    if not event["hasChoice"]:
                        continue
                    self.finishReason = event["finishReason"] or self.finishReason
                    if event["reasoning"] and self.thinkingEnabled:
                        yield {"type": "reasoning", "value": event["reasoning"]}
                    if event["content"]:
                        if not contentStarted:
                            contentStarted = True
                            yield {"type": "contentStart"}
                        self.textParts.append(event["content"])
                        yield {"type": "content", "value": event["content"]}
