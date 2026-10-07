from __future__ import annotations

import uuid
from typing import Any

from backend.core.database import getDb
from backend.core.utils import utcNow


def latestTosAcceptance(tos_hash: str | None = None) -> dict[str, Any] | None:
    query = "SELECT id, tos_hash, tos_date, accepted_at FROM tos_acceptances"
    params: tuple[Any, ...] = ()

    if tos_hash is not None:
        query += " WHERE tos_hash = ?"
        params = (tos_hash,)

    query += " ORDER BY accepted_at DESC, rowid DESC LIMIT 1"

    with getDb() as conn:
        row = conn.execute(query, params).fetchone()

    return dict(row) if row else None


def previousTosAcceptance(current_hash: str) -> dict[str, Any] | None:
    #the newest acceptance of some *other* version, which is what the "terms changed" banner shows
    with getDb() as conn:
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


def recordTosAcceptance(tos_hash: str, tos_date: str | None) -> None:
    with getDb() as conn:
        conn.execute(
            "INSERT INTO tos_acceptances (id, tos_hash, tos_date, accepted_at) VALUES (?, ?, ?, ?)",
            (str(uuid.uuid4()), tos_hash, tos_date, utcNow()),
        )


def tosPayload(tos: dict[str, Any]) -> dict[str, Any]:
    accepted = latestTosAcceptance(tos["hash"])
    return {
        "hash": tos["hash"],
        "date": tos["date"],
        "markdown": tos["markdown"],
        "accepted": bool(accepted),
        "accepted_at": accepted["accepted_at"] if accepted else None,
        "previous": previousTosAcceptance(tos["hash"]) if not accepted else None,
    }
