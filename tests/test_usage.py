import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import backend.main as main
from backend.usage import createUsageRouter, getUsage


class UsageTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.dbPath = Path(self.tempDir.name) / "usage.sqlite3"
        with patch.object(main, "DATA_DIR", Path(self.tempDir.name)), patch.object(main, "DB_PATH", self.dbPath):
            main.init_db()
        self.conn = sqlite3.connect(self.dbPath)
        self.conn.row_factory = sqlite3.Row
        self.now = datetime(2026, 9, 10, 2, 0, tzinfo=timezone.utc)

    def tearDown(self):
        self.conn.close()
        self.tempDir.cleanup()

    def addRow(self, table="messages", **values):
        defaults = {
            "messages": {"id": "chat-row", "chat_id": "chat", "role": "assistant", "content": "Hello"},
            "story_generations": {"id": "story-row", "story_id": "story", "chapter_id": "chapter", "prompt": "Write", "generated_text": "Hello"},
            "brainstorm_generations": {"id": "brainstorm-row", "story_id": "story", "prompt_node_id": "node", "prompt": "Ideas"},
            "lorebook_update_runs": {"id": "lorebook-row", "story_id": "story", "chapter_id": "chapter", "raw_output": "{}", "applied_updates_json": "[]"},
        }
        row = {**defaults[table], "created_at": "2026-09-09T12:00:00Z", "cost": 0.5}
        if table != "lorebook_update_runs":
            row.update(model="test/model", prompt_tokens=100, completion_tokens=50, reasoning_tokens=20, total_tokens=150)
        row.update(values)
        columns = ", ".join(row)
        placeholders = ", ".join("?" for key in row)
        self.conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", tuple(row.values()))
        self.conn.commit()

    def summary(self, offsetMinutes=420):
        return getUsage(self.conn, offsetMinutes=offsetMinutes, now=self.now)

    def testEmptyWeekHasSevenDaysAndNoInventedRate(self):
        result = self.summary()
        self.assertEqual(result["startDate"], "2026-09-03")
        self.assertEqual(result["endDate"], "2026-09-09")
        self.assertEqual(len(result["days"]), 7)
        self.assertEqual(result["current"]["cost"], 0)
        self.assertIsNone(result["current"]["blendedCost"])
        self.assertEqual(result["models"], [])
        self.assertEqual(result["lifetimeModels"], [])

    def testAllSavedSourcesCountOnceAndReasoningIsNotAddedTwice(self):
        for table in ("messages", "story_generations", "brainstorm_generations", "lorebook_update_runs"):
            self.addRow(table)
        self.addRow(id="user-row", role="user", cost=100)
        result = self.summary()
        current = result["current"]
        self.assertEqual(current["cost"], 2)
        self.assertEqual(current["requests"], 4)
        self.assertEqual(current["totalTokens"], 450)
        self.assertEqual(current["promptTokens"], 300)
        self.assertEqual(current["outputTokens"], 90)
        self.assertEqual(current["reasoningTokens"], 60)
        self.assertEqual(current["missingTokens"], 1)
        self.assertAlmostEqual(current["blendedCost"], 1.5 / 450 * 1_000_000)
        self.assertEqual(result["models"][1]["id"], "unknown")

    def testDuplicateProviderGenerationIsNotDoubleCounted(self):
        self.addRow(generation_id="generation-1")
        self.addRow(id="imported-copy", generation_id="generation-1")
        self.assertEqual(self.summary()["current"]["requests"], 1)

    def testMissingUsageIsNotPresentedAsFree(self):
        self.addRow(cost=None, prompt_tokens=None, completion_tokens=None, reasoning_tokens=None, total_tokens=None)
        current = self.summary()["current"]
        self.assertIsNone(current["cost"])
        self.assertIsNone(current["totalTokens"])
        self.assertEqual(current["missingCost"], 1)
        self.assertEqual(current["missingTokens"], 1)

    def testFreeRequestsAndPartialTokenData(self):
        self.addRow(cost=0, total_tokens=None)
        self.addRow(id="partial", cost=None, prompt_tokens=100, completion_tokens=None, reasoning_tokens=None, total_tokens=None)
        current = self.summary()["current"]
        self.assertEqual(current["cost"], 0)
        self.assertEqual(current["totalTokens"], 150)
        self.assertEqual(current["promptTokens"], 200)
        self.assertEqual(current["blendedCost"], 0)
        self.assertEqual(current["missingTokens"], 1)

    def testLocalMidnightAndPreviousWeekBoundaries(self):
        self.addRow(id="previous", created_at="2026-09-03T06:59:59Z", cost=1)
        self.addRow(id="current", created_at="2026-09-03T07:00:00Z", cost=2)
        self.addRow(id="old", created_at="2026-08-27T06:59:59Z", cost=4)
        self.addRow(id="future", created_at="2026-09-10T03:00:00Z", cost=8)
        result = self.summary()
        self.assertEqual(result["previous"]["cost"], 1)
        self.assertEqual(result["current"]["cost"], 2)
        self.assertEqual(result["days"][0]["cost"], 2)

    def testInvalidNumbersAreMissingAndTotalsStayFinite(self):
        self.addRow(cost=float("inf"), prompt_tokens=-1, total_tokens=-1)
        current = self.summary()["current"]
        self.assertIsNone(current["cost"])
        self.assertIsNone(current["totalTokens"])
        self.assertEqual(current["promptTokens"], 0)

    def testLifetimeIncludesOldSourcesWithoutChangingWeeklyTotals(self):
        self.addRow(cost=2)
        self.addRow(id="previous", created_at="2026-09-01T12:00:00Z", cost=3)
        self.addRow("story_generations", created_at="2025-01-01T12:00:00Z", cost=4)
        self.addRow("brainstorm_generations", created_at="2025-02-01T12:00:00Z", model="old/model", cost=5)
        self.addRow("lorebook_update_runs", created_at="2025-03-01T12:00:00Z", cost=None)
        self.addRow(id="future", created_at="2027-01-01T12:00:00Z", cost=100)
        self.addRow(id="user", role="user", cost=100)

        result = self.summary()
        lifetime = {model["id"]: model for model in result["lifetimeModels"]}
        self.assertEqual(result["current"]["cost"], 2)
        self.assertEqual(result["previous"]["cost"], 3)
        self.assertEqual(len(result["models"]), 1)
        self.assertEqual(lifetime["test/model"]["cost"], 9)
        self.assertEqual(lifetime["test/model"]["requests"], 3)
        self.assertEqual(lifetime["test/model"]["totalTokens"], 450)
        self.assertEqual(lifetime["old/model"]["cost"], 5)
        self.assertIsNone(lifetime["unknown"]["cost"])
        self.assertIsNone(lifetime["unknown"]["totalTokens"])

    def testLifetimeDeduplicatesAcrossDatesAndSources(self):
        self.addRow(id="old", created_at="2025-01-01T12:00:00Z", generation_id="shared")
        self.addRow(id="recent", generation_id="shared")
        self.addRow("story_generations", generation_id="shared")
        result = self.summary()
        self.assertEqual(result["lifetimeModels"][0]["requests"], 1)
        self.assertEqual(result["lifetimeModels"][0]["cost"], 0.5)
        self.assertEqual(result["current"]["requests"], 1)

    def testEndpointValidatesOffsetAndDoesNotCallProvider(self):
        def getDb():
            conn = sqlite3.connect(self.dbPath)
            conn.row_factory = sqlite3.Row
            return conn

        app = FastAPI()
        app.include_router(createUsageRouter(getDb))
        with TestClient(app) as client, patch("httpx.AsyncClient", side_effect=AssertionError("Provider call forbidden")):
            self.assertEqual(client.get("/api/usage?offsetMinutes=420").status_code, 200)
            self.assertEqual(client.get("/api/usage?offsetMinutes=900").status_code, 422)
