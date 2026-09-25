from __future__ import annotations

import uuid
from typing import Any

from backend.core.database import get_db
from backend.core.utils import utc_now


def latest_tos_acceptance(tos_hash: str | None = None) -> dict[str, Any] | None:
    query = "SELECT id, tos_hash, tos_date, accepted_at FROM tos_acceptances"
    params: tuple[Any, ...] = ()

    if tos_hash is not None:
        query += " WHERE tos_hash = ?"
        params = (tos_hash,)

    query += " ORDER BY accepted_at DESC, rowid DESC LIMIT 1"

    with get_db() as conn:
        row = conn.execute(query, params).fetchone()

    return dict(row) if row else None


def previous_tos_acceptance(current_hash: str) -> dict[str, Any] | None:
    #the newest acceptance of some *other* version, which is what the "terms changed" banner shows
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT tos_hash, tos_date, accepted_at
            FROM tos_acceptances
            WHERE tos_hash != ?
            ORDER BY accepted_at DESC, rowid DESC
            LIMIT 1
            """,
            (current_hash,),
        ).fetchone()

    if not row:
        return None

    #same key names as the current-version payload so the frontend can render either one the same way
    return {
        "hash": row["tos_hash"],
        "date": row["tos_date"],
        "accepted_at": row["accepted_at"],
    }


def record_tos_acceptance(tos_hash: str, tos_date: str | None) -> None:
    with get_db() as conn:
        conn.execute(
            "INSERT INTO tos_acceptances (id, tos_hash, tos_date, accepted_at) VALUES (?, ?, ?, ?)",
            (str(uuid.uuid4()), tos_hash, tos_date, utc_now()),
        )


def tos_payload(tos: dict[str, Any]) -> dict[str, Any]:
    accepted = latest_tos_acceptance(tos["hash"])
    return {
        "hash": tos["hash"],
        "date": tos["date"],
        "markdown": tos["markdown"],
        "accepted": bool(accepted),
        "accepted_at": accepted["accepted_at"] if accepted else None,
        "previous": previous_tos_acceptance(tos["hash"]) if not accepted else None,
    }
