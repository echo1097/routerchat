import logging
import sqlite3
from contextlib import closing

from backend.core.database import get_db
from backend.core.schema import initCoreTables
from backend.lorebook.lorebookUsage import ensureLorebookUsageTable
from backend.transcription.transcriptionUsage import ensureTranscriptionUsageTable
from backend.usage.migrateLegacyUsage import migrateLegacyUsage
from backend.usage.usageDatabase import getUsageDb, initUsageDb

logger = logging.getLogger("uvicorn.error")


def init_db() -> None:
    initCoreTables()

    with get_db() as conn:
        ensureLorebookUsageTable(conn)
        ensureTranscriptionUsageTable(conn)

    with closing(get_db()) as mainConn, closing(getUsageDb()) as usageConn:
        initUsageDb(usageConn)
        try:
            migrateLegacyUsage(mainConn, usageConn)
        except sqlite3.Error:
            logger.exception("Could not move usage history into usage.sqlite3. It will be retried on the next start.")
