from __future__ import annotations

from dataclasses import dataclass
from typing import Any

FIVE_MINUTE_WRITE_MULTIPLIER = 1.25
ONE_HOUR_WRITE_MULTIPLIER = 2.0
PER_MILLION = 1_000_000


@dataclass(frozen=True)
class ModelPrice:
    input: float
    output: float
    cacheRead: float

    @property
    def cacheWrite5m(self) -> float:
        return self.input * FIVE_MINUTE_WRITE_MULTIPLIER

    @property
    def cacheWrite1h(self) -> float:
        return self.input * ONE_HOUR_WRITE_MULTIPLIER


PRICES_BY_PREFIX: tuple[tuple[str, ModelPrice], ...] = (
    ("claude-fable-5-1", ModelPrice(10.0, 50.0, 0.25)),
    ("claude-mythos-5-1", ModelPrice(10.0, 50.0, 0.25)),
    ("claude-fable-5", ModelPrice(10.0, 50.0, 1.0)),
    ("claude-mythos-5", ModelPrice(10.0, 50.0, 1.0)),
    ("claude-opus-5-5", ModelPrice(4.0, 20.0, 0.20)),
    ("claude-opus-5", ModelPrice(5.0, 25.0, 0.50)),
    ("claude-opus-4-8", ModelPrice(5.0, 25.0, 0.50)),
    ("claude-opus-4-7", ModelPrice(5.0, 25.0, 0.50)),
    ("claude-opus-4-6", ModelPrice(5.0, 25.0, 0.50)),
    ("claude-opus-4-5", ModelPrice(5.0, 25.0, 0.50)),
    ("claude-sonnet-5-5", ModelPrice(2.0, 10.0, 0.20)),
    ("claude-sonnet-5", ModelPrice(2.0, 10.0, 0.20)),
    ("claude-sonnet-4-6", ModelPrice(3.0, 15.0, 0.30)),
    ("claude-sonnet-4-5", ModelPrice(3.0, 15.0, 0.30)),
    ("claude-haiku-4-5", ModelPrice(1.0, 5.0, 0.10)),
)


def priceFor(modelId: str | None) -> ModelPrice | None:
    cleanId = str(modelId or "")
    for prefix, price in PRICES_BY_PREFIX:
        if cleanId.startswith(prefix):
            return price
    return None


def tokenCount(value: Any) -> int:
    return value if isinstance(value, int) and value > 0 else 0


def costFor(modelId: str | None, usage: dict[str, Any]) -> float | None:
    price = priceFor(modelId)
    if price is None:
        return None

    cacheWrites = tokenCount(usage.get("cache_creation_input_tokens"))
    breakdown = usage.get("cache_creation")
    if isinstance(breakdown, dict):
        oneHourWrites = tokenCount(breakdown.get("ephemeral_1h_input_tokens"))
        fiveMinuteWrites = tokenCount(breakdown.get("ephemeral_5m_input_tokens"))
    else:
        oneHourWrites = 0
        fiveMinuteWrites = cacheWrites

    total = (
        tokenCount(usage.get("input_tokens")) * price.input
        + tokenCount(usage.get("cache_read_input_tokens")) * price.cacheRead
        + fiveMinuteWrites * price.cacheWrite5m
        + oneHourWrites * price.cacheWrite1h
        + tokenCount(usage.get("output_tokens")) * price.output
    )
    return total / PER_MILLION
