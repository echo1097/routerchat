import sqlite3

from backend.core.database import getDb
from backend.providers.base import Provider
from backend.providers.registry import getActiveProvider, providerForRow


def storyProvider(storyId: str) -> Provider:
    try:
        with getDb() as conn:
            row = conn.execute("SELECT provider FROM stories WHERE id = ?", (storyId,)).fetchone()
    except sqlite3.Error:
        return getActiveProvider()

    return providerForRow(row)
