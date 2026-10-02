from __future__ import annotations

import sqlite3

from fastapi import HTTPException

from backend.attachments.attachmentFiles import readable_size
from backend.providers.base import Provider


def checkAttachmentLimits(
    conn: sqlite3.Connection,
    attachmentIds: list[str],
    provider: Provider,
) -> None:
    maxImageBytes = provider.capabilities.maxImageBytes
    if not attachmentIds or maxImageBytes is None:
        return

    placeholders = ", ".join("?" for _ in attachmentIds)
    oversized = conn.execute(
        f"""
        SELECT filename FROM attachments
        WHERE id IN ({placeholders}) AND kind = 'image' AND size_bytes > ?
        ORDER BY created_at ASC
        """,
        (*attachmentIds, maxImageBytes),
    ).fetchone()

    if oversized:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{oversized['filename']} is larger than {readable_size(maxImageBytes)}, "
                f"the most {provider.name} accepts for an image."
            ),
        )
