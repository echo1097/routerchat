from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def patch_updates(payload: BaseModel) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        updates = payload.model_dump(exclude_unset=True)
    else:
        updates = payload.dict(exclude_unset=True)

    null_fields = [key for key, value in updates.items() if value is None]
    if null_fields:
        raise HTTPException(
            status_code=422,
            detail=f"Fields cannot be null: {', '.join(null_fields)}.",
        )
    return updates


def coerce_bool_int(value: Any) -> int:
    return int(bool(value))


def int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def format_duration(ms: float) -> str:
    seconds = max(1, round(ms / 1000))
    return f"{seconds} {'second' if seconds == 1 else 'seconds'}"


def display_model_name(model: str) -> str:
    name = str(model or "Model").split("/")[-1]
    name = name.replace(":free", "").replace("-", " ").replace("_", " ")
    return " ".join(part[:1].upper() + part[1:] for part in name.split())
