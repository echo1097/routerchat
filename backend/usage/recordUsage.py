from __future__ import annotations

import sqlite3
from contextlib import closing
from typing import Any

from backend.providers.registry import getActiveProvider
from backend.usage.usageDatabase import getUsageDb

FREE_PROVIDERS = {"local"}

USAGE_FIELDS = (
    "prompt_tokens",
    "completion_tokens",
    "reasoning_tokens",
    "cached_tokens",
    "total_tokens",
    "cost",
)


def usageEntry(kind, sourceId, provider, model, generationId, usage, createdAt):
    usage = usage or {}
    return (
        kind,
        sourceId,
        provider,
        model,
        generationId,
        *(usage.get(field) for field in USAGE_FIELDS),
        createdAt,
    )


def saveUsageEntries(conn: sqlite3.Connection, entries, replace=True) -> None:
    conflictAction = """DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          generation_id = excluded.generation_id,
          prompt_tokens = excluded.prompt_tokens,
          completion_tokens = excluded.completion_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          cached_tokens = excluded.cached_tokens,
          total_tokens = excluded.total_tokens,
          cost = excluded.cost,
          created_at = excluded.created_at""" if replace else "DO NOTHING"

    conn.executemany(
        f"""
        INSERT INTO usage_entries (
          kind, source_id, provider, model, generation_id, prompt_tokens,
          completion_tokens, reasoning_tokens, cached_tokens, total_tokens,
          cost, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, source_id) {conflictAction}
        """,
        entries,
    )


def recordUsage(
    kind: str,
    sourceId: str,
    model: str | None,
    usage: dict[str, Any] | None,
    createdAt: str,
    generationId: str | None = None,
    provider: str | None = None,
) -> None:
    providerId = provider or getActiveProvider().id
    if providerId in FREE_PROVIDERS:
        usage = {**(usage or {}), "cost": 0}

    entry = usageEntry(kind, sourceId, providerId, model, generationId, usage, createdAt)

    try:
        with closing(getUsageDb()) as conn, conn:
            saveUsageEntries(conn, [entry])
    except sqlite3.Error:
        pass
