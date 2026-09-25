from __future__ import annotations

import json
from typing import Any

from backend.core.database import get_db
from backend.core.utils import utc_now


def read_app_setting(key: str) -> Any:
    with get_db() as conn:
        row = conn.execute(
            "SELECT value_json FROM app_settings WHERE key = ?", (key,)
        ).fetchone()
    if not row:
        return None
    return json.loads(row["value_json"])


def write_app_setting(key: str, value: Any) -> None:
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            """,
            (key, json.dumps(value), utc_now()),
        )


def hourPromptCacheEnabled() -> bool:
    return read_app_setting("hour_prompt_cache") is not False


def globalChatSystemPrompt() -> str:
    return str(read_app_setting("chat_system_prompt") or "")
