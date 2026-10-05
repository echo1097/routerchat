from __future__ import annotations

import sqlite3

from backend.core import paths


def getUsageDb() -> sqlite3.Connection:
    usagePath = paths.usageDbPath()
    usagePath.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(usagePath)
    conn.row_factory = sqlite3.Row
    return conn


def initUsageDb(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS usage_entries (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT,
          generation_id TEXT,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          reasoning_tokens INTEGER,
          cached_tokens INTEGER,
          total_tokens INTEGER,
          cost REAL,
          created_at TEXT NOT NULL,
          UNIQUE(kind, source_id)
        );

        CREATE INDEX IF NOT EXISTS idx_usage_entries_created
        ON usage_entries(created_at);

        CREATE INDEX IF NOT EXISTS idx_usage_entries_provider
        ON usage_entries(provider, created_at);
        """
    )
