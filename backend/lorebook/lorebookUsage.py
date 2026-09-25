import asyncio
import uuid

from backend.core.database import get_db
from backend.core.utils import utc_now
from backend.providers.openrouter.usage import fetch_generation_usage


def ensureLorebookUsageTable(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS lorebook_usage (
          id TEXT PRIMARY KEY,
          story_id TEXT NOT NULL,
          chapter_id TEXT,
          action TEXT NOT NULL,
          model TEXT NOT NULL,
          generation_id TEXT,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          reasoning_tokens INTEGER,
          cached_tokens INTEGER,
          total_tokens INTEGER,
          cost REAL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
          FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_lorebook_usage_story ON lorebook_usage(story_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_lorebook_usage_chapter ON lorebook_usage(chapter_id)")
    existingColumns = {row[1] for row in conn.execute("PRAGMA table_info(lorebook_usage)").fetchall()}
    if "cached_tokens" not in existingColumns:
        conn.execute("ALTER TABLE lorebook_usage ADD COLUMN cached_tokens INTEGER")


class LorebookUsage:
    def __init__(self, apiKey, storyId, model, action, chapterId=None):
        self.apiKey = apiKey
        self.storyId = storyId
        self.chapterId = chapterId
        self.model = model
        self.action = action
        self.requestId = str(uuid.uuid4())
        self.generationId = None
        self.usage = {}

    async def __aenter__(self):
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO lorebook_usage (id, story_id, chapter_id, action, model, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (self.requestId, self.storyId, self.chapterId, self.action, self.model, utc_now()),
            )
        return self

    async def __aexit__(self, errorType, error, traceback):
        try:
            if errorType is None or issubclass(errorType, Exception):
                await self.fetchUsage()
        finally:
            self.saveUsage()
        return False

    def addUsage(self, nextUsage):
        if not nextUsage:
            return
        self.usage.update({key: value for key, value in nextUsage.items() if value is not None})

    async def fetchUsage(self):
        requiredFields = ("cost", "prompt_tokens", "completion_tokens")
        if not self.generationId or all(self.usage.get(key) is not None for key in requiredFields):
            return
        currentTask = asyncio.current_task()
        if currentTask and currentTask.cancelling():
            return
        try:
            nextUsage = await fetch_generation_usage(self.apiKey, self.generationId)
            self.addUsage(nextUsage)
        except Exception:
            pass

    def saveUsage(self):
        promptTokens = self.usage.get("prompt_tokens")
        completionTokens = self.usage.get("completion_tokens")
        if self.usage.get("total_tokens") is None and promptTokens is not None and completionTokens is not None:
            self.usage["total_tokens"] = promptTokens + completionTokens

        with get_db() as conn:
            conn.execute(
                """
                UPDATE lorebook_usage
                SET generation_id = ?, prompt_tokens = ?, completion_tokens = ?,
                    reasoning_tokens = ?, cached_tokens = ?, total_tokens = ?, cost = ?
                WHERE id = ?
                """,
                (
                    self.generationId,
                    self.usage.get("prompt_tokens"),
                    self.usage.get("completion_tokens"),
                    self.usage.get("reasoning_tokens"),
                    self.usage.get("cached_tokens"),
                    self.usage.get("total_tokens"),
                    self.usage.get("cost"),
                    self.requestId,
                ),
            )
