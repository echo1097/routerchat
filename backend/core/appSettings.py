from __future__ import annotations

import json
from typing import Any

from backend.core.database import getDb
from backend.core.utils import utcNow


def readAppSetting(key: str) -> Any:
    with getDb() as conn:
        row = conn.execute(
            "SELECT value_json FROM app_settings WHERE key = ?", (key,)
        ).fetchone()
    if not row:
        return None
    return json.loads(row["value_json"])


def writeAppSetting(key: str, value: Any) -> None:
    with getDb() as conn:
        conn.execute(
            """
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            """,
            (key, json.dumps(value), utcNow()),
        )


def hourPromptCacheEnabled() -> bool:
    return readAppSetting("hour_prompt_cache") is not False


def updateChecksEnabled() -> bool:
    return readAppSetting("update_checks") is not False


def globalChatSystemPrompt() -> str:
    return str(readAppSetting("chat_system_prompt") or "")
