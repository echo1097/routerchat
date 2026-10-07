from contextlib import aclosing
from typing import Any, AsyncIterator

from backend.lorebook.lorebookUsage import LorebookUsage
from backend.providers.base import ChatRequest, Provider
from backend.providers.modelStream import ModelStream


class LorebookStream:
    def __init__(
        self,
        provider: Provider,
        request: ChatRequest,
        usageRun: LorebookUsage,
        thinkingEnabled: bool,
    ):
        self.usageRun = usageRun
        self.modelStream = ModelStream(provider, request, thinkingEnabled)

    @property
    def text(self) -> str:
        return self.modelStream.text

    @property
    def finishReason(self) -> str | None:
        return self.modelStream.finishReason

    @property
    def receivedDone(self) -> bool:
        return self.modelStream.receivedDone

    @property
    def errorMessage(self) -> str | None:
        return self.modelStream.errorMessage

    def usageEventValue(self) -> dict[str, Any] | None:
        if not self.usageRun.usage:
            return None
        return {
            "generation_id": self.usageRun.generationId,
            "model": self.usageRun.model,
            **self.usageRun.usage,
        }

    def syncUsage(self) -> None:
        self.usageRun.generationId = self.modelStream.generationId
        self.usageRun.addUsage(self.modelStream.usage)

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        async with self.usageRun:
            try:
                async with aclosing(self.modelStream.events()) as events:
                    async for event in events:
                        self.syncUsage()
                        yield event
            finally:
                self.syncUsage()
