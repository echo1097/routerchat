from __future__ import annotations

import sqlite3

from backend.usage.recordUsage import saveUsageEntries, usageEntry

MIGRATED_VERSION = 1
LEGACY_PROVIDER = "openrouter"

USAGE_COLUMNS = "id, model, generation_id, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, total_tokens, cost, created_at"
TRANSCRIPTION_COLUMNS = USAGE_COLUMNS.replace("cached_tokens", "NULL AS cached_tokens")

LEGACY_QUERIES = {
    "message": f"SELECT {USAGE_COLUMNS} FROM messages WHERE role = 'assistant'",
    "story": f"SELECT {USAGE_COLUMNS} FROM story_generations",
    "brainstorm": f"SELECT {USAGE_COLUMNS} FROM brainstorm_generations",
    "lorebook": f"SELECT {USAGE_COLUMNS} FROM lorebook_usage",
    "transcription": f"SELECT {TRANSCRIPTION_COLUMNS} FROM transcription_usage",
    "lorebookRun": """
        SELECT id, NULL AS model, openrouter_generation_id AS generation_id,
               NULL AS prompt_tokens, NULL AS completion_tokens,
               NULL AS reasoning_tokens, NULL AS cached_tokens, NULL AS total_tokens,
               cost, created_at
        FROM lorebook_update_runs
        WHERE NOT EXISTS (
            SELECT 1 FROM lorebook_usage WHERE lorebook_usage.id = lorebook_update_runs.id
        )
    """,
}


def legacyEntries(mainConn: sqlite3.Connection):
    for kind, query in LEGACY_QUERIES.items():
        for row in mainConn.execute(query):
            if not row["created_at"]:
                continue
            yield usageEntry(
                kind,
                row["id"],
                LEGACY_PROVIDER,
                row["model"],
                row["generation_id"],
                dict(row),
                row["created_at"],
            )


def migrateLegacyUsage(mainConn: sqlite3.Connection, usageConn: sqlite3.Connection) -> None:
    if usageConn.execute("PRAGMA user_version").fetchone()[0] >= MIGRATED_VERSION:
        return

    with usageConn:
        saveUsageEntries(usageConn, legacyEntries(mainConn), replace=False)
        usageConn.execute(f"PRAGMA user_version = {MIGRATED_VERSION}")
