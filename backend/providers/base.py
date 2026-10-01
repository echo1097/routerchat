from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

import httpx

from backend.core.reasoningEffort import ReasoningEffort

DEFAULT_MAX_TOKENS = 30000


@dataclass(frozen=True)
class Capabilities:
    reasoning: bool = False
    reasoningEfforts: tuple[str, ...] = ()
    webSearch: bool = False
    pdfParsing: bool = False
    cost: bool = False
    structuredOutput: bool = False
    needsKey: bool = True
    needsBaseUrl: bool = False
    routingOptions: bool = False
    transcription: bool = False
    freeModels: bool = False

    def toDict(self) -> dict[str, Any]:
        values = asdict(self)
        values["reasoningEfforts"] = list(self.reasoningEfforts)
        return values


@dataclass
class ChatOptions:
    apiKey: str
    temperature: float
    maxTokens: int
    stream: bool = True
    nitro: bool = False
    thinkingEnabled: bool = False
    reasoningEffort: ReasoningEffort = "medium"
    explicitReasoning: bool = False
    responseFormat: dict[str, Any] | None = None
    plugins: list[dict[str, Any]] = field(default_factory=list)
    cacheControl: dict[str, Any] | None = None
    sessionId: str | None = None


@dataclass
class ChatRequest:
    url: str
    headers: dict[str, str]
    body: dict[str, Any]


class StreamParser(Protocol):
    def parse(self, chunk: dict[str, Any]) -> list[dict[str, Any]]: ...


class SingleChunkParser:
    def __init__(self, parseChunk) -> None:
        self.parseChunk = parseChunk

    def parse(self, chunk: dict[str, Any]) -> list[dict[str, Any]]:
        return [self.parseChunk(chunk)]


class Provider(ABC):
    id: str
    name: str
    capabilities: Capabilities
    timeout: httpx.Timeout
    keyPlaceholder: str = ""
    defaultModelSetting: str = "default_model"

    @property
    def missingKeyMessage(self) -> str:
        return f"Add an {self.name} API key first."

    def info(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "keyPlaceholder": self.keyPlaceholder,
            "capabilities": self.capabilities.toDict(),
        }

    @abstractmethod
    def readKey(self) -> str | None: ...

    @abstractmethod
    def writeKey(self, apiKey: str) -> None: ...

    @abstractmethod
    async def validateKey(self, apiKey: str) -> dict[str, Any]: ...

    @abstractmethod
    def normalizeKeyStatus(self, data: dict[str, Any] | None, hasKey: bool) -> dict[str, Any]: ...

    @abstractmethod
    async def keyStatus(self) -> dict[str, Any]: ...

    @abstractmethod
    async def listModels(self, apiKey: str) -> list[dict[str, Any]]: ...

    @abstractmethod
    def cachedModels(self) -> list[dict[str, Any]]: ...

    @abstractmethod
    def cacheModels(self, models: list[dict[str, Any]]) -> None: ...

    @abstractmethod
    def defaultModelId(self) -> str: ...

    @abstractmethod
    def supportsReasoning(self, modelId: str) -> bool: ...

    @abstractmethod
    def effectiveThinkingEnabled(self, modelId: str, thinkingEnabled: bool) -> bool: ...

    @abstractmethod
    def supportsStructuredOutput(self, modelId: str) -> bool: ...

    @abstractmethod
    def promptCacheControl(self) -> dict[str, Any] | None: ...

    @abstractmethod
    def buildRequest(
        self, messages: list[dict[str, Any]], model: str, options: ChatOptions
    ) -> ChatRequest: ...

    @abstractmethod
    def generationIdFromHeaders(self, headers: httpx.Headers) -> str | None: ...

    def parseStreamChunk(self, chunk: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def createStreamParser(self) -> StreamParser:
        return SingleChunkParser(self.parseStreamChunk)

    @abstractmethod
    def completionText(self, payload: dict[str, Any]) -> str | None: ...

    @abstractmethod
    def errorMessage(self, statusCode: int, responseText: str) -> str: ...

    async def fetchFinalUsage(self, apiKey: str, generationId: str) -> dict[str, Any] | None:
        return None
