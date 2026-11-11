from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from backend.core.database import getDb

INACTIVITY_LIMIT = timedelta(days=30)
LAST_SEEN_STEP = timedelta(hours=1)
MAX_DEVICES = 10
MAX_TOKEN_LENGTH = 256
MAX_NAME_LENGTH = 40
DEFAULT_DEVICE_NAME = "Phone"


def hashToken(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def cleanDeviceName(name: str) -> str:
    cleaned = " ".join(str(name or "").split())[:MAX_NAME_LENGTH].strip()
    return cleaned or DEFAULT_DEVICE_NAME


def devicePayload(row: Any) -> dict[str, str]:
    return {
        "id": row["id"],
        "name": row["name"],
        "createdAt": row["created_at"],
        "lastSeenAt": row["last_seen_at"],
    }


def deviceLimitReached() -> bool:
    removeInactiveDevices()
    with getDb() as conn:
        row = conn.execute("SELECT COUNT(*) AS total FROM paired_devices").fetchone()
    return int(row["total"]) >= MAX_DEVICES


def createDevice(name: str) -> tuple[dict[str, str], str]:
    token = secrets.token_urlsafe(48)
    now = datetime.now(timezone.utc).isoformat()
    deviceId = uuid.uuid4().hex

    with getDb() as conn:
        conn.execute(
            """
            INSERT INTO paired_devices (id, name, token_hash, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (deviceId, cleanDeviceName(name), hashToken(token), now, now),
        )
        row = conn.execute(
            "SELECT * FROM paired_devices WHERE id = ?", (deviceId,)
        ).fetchone()

    return devicePayload(row), token


def findActiveDevice(token: str) -> dict[str, str] | None:
    if not token or len(token) > MAX_TOKEN_LENGTH:
        return None

    now = datetime.now(timezone.utc)
    with getDb() as conn:
        row = conn.execute(
            "SELECT * FROM paired_devices WHERE token_hash = ?", (hashToken(token),)
        ).fetchone()
        if not row:
            return None

        idleTime = now - datetime.fromisoformat(row["last_seen_at"])
        if idleTime > INACTIVITY_LIMIT:
            conn.execute("DELETE FROM paired_devices WHERE id = ?", (row["id"],))
            return None

        if idleTime > LAST_SEEN_STEP:
            conn.execute(
                "UPDATE paired_devices SET last_seen_at = ? WHERE id = ?",
                (now.isoformat(), row["id"]),
            )

    return devicePayload(row)


def removeInactiveDevices() -> None:
    cutoff = (datetime.now(timezone.utc) - INACTIVITY_LIMIT).isoformat()
    with getDb() as conn:
        conn.execute("DELETE FROM paired_devices WHERE last_seen_at < ?", (cutoff,))


def listDevices() -> list[dict[str, str]]:
    removeInactiveDevices()
    with getDb() as conn:
        rows = conn.execute(
            "SELECT * FROM paired_devices ORDER BY created_at ASC"
        ).fetchall()
    return [devicePayload(row) for row in rows]


def removeDevice(deviceId: str) -> bool:
    with getDb() as conn:
        cursor = conn.execute("DELETE FROM paired_devices WHERE id = ?", (deviceId,))
    return cursor.rowcount > 0
