import sqlite3
import tempfile
import unittest
import zoneinfo
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import backend.main as main
import backend.core.paths as paths
from backend.usage import createUsageRouter, getUsage


class UsageTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.dbPath = Path(self.tempDir.name) / "usage.sqlite3"
        with patch.object(paths, "DATA_DIR", Path(self.tempDir.name)), patch.object(paths, "DB_PATH", self.dbPath):
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
            "transcription_usage": {"id": "transcription-row"},
            "lorebook_usage": {"id": "usage-row", "story_id": "story", "action": "generate"},
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
        self.assertTrue(current["partialTokens"])
        self.assertFalse(current["partialCost"])
        self.assertIsNone(current["promptTokens"])
        self.assertIsNone(current["outputTokens"])
        self.assertIsNone(current["reasoningTokens"])
        self.assertEqual(current["missingTokens"], 1)
        self.assertIsNone(current["blendedCost"])
        self.assertEqual(result["models"][1]["id"], "unknown")

    def testCachedReadsAreSplitOutOfInputForEverySource(self):
        for table in ("messages", "story_generations", "brainstorm_generations", "lorebook_usage"):
            self.addRow(table, cached_tokens=80)
        current = self.summary()["current"]
        self.assertEqual(current["promptTokens"], 80)
        self.assertEqual(current["cachedTokens"], 320)
        self.assertEqual(current["totalTokens"], 600)

    def testRowsWithoutCachedCountsKeepTheirFullInput(self):
        self.addRow()
        self.addRow("transcription_usage", model="openai/whisper-1")
        current = self.summary()["current"]
        self.assertEqual(current["promptTokens"], 200)
        self.assertEqual(current["cachedTokens"], 0)

    def testCachedReadsNeverExceedTheInput(self):
        self.addRow(cached_tokens=500)
        current = self.summary()["current"]
        self.assertEqual(current["promptTokens"], 0)
        self.assertEqual(current["cachedTokens"], 100)

    def testDuplicateProviderGenerationIsNotDoubleCounted(self):
        self.addRow(generation_id="generation-1")
        self.addRow(id="imported-copy", generation_id="generation-1")
        self.assertEqual(self.summary()["current"]["requests"], 1)

    def testLorebookUsageIncludesEveryActionUnderItsModel(self):
        for action in ("update", "generate", "repair", "timeline_repair"):
            self.addRow("lorebook_usage", id=action, action=action)
        result = self.summary()
        for totals in (result["current"], result["days"][-1], result["models"][0], result["lifetimeModels"][0]):
            self.assertEqual(totals["requests"], 4)
            self.assertEqual(totals["cost"], 2)
            self.assertEqual(totals["totalTokens"], 600)
            self.assertEqual(totals["outputTokens"], 120)
            self.assertEqual(totals["reasoningTokens"], 80)
            self.assertFalse(totals["partialCost"])
            self.assertFalse(totals["partialTokens"])
        self.assertEqual(result["models"][0]["id"], "test/model")

    def testLorebookHistoryIsCountedOnceEvenWithoutProviderId(self):
        for generationId in (None, "provider-id"):
            with self.subTest(generationId=generationId):
                self.conn.execute("DELETE FROM lorebook_usage")
                self.conn.execute("DELETE FROM lorebook_update_runs")
                self.addRow("lorebook_update_runs", id="new-run", openrouter_generation_id=generationId)
                self.addRow("lorebook_usage", id="new-run", generation_id=generationId)
                self.addRow("lorebook_update_runs", id="legacy-run", cost=0.25)
                result = self.summary()
                self.assertEqual(result["current"]["requests"], 2)
                self.assertEqual(result["current"]["cost"], 0.75)
                self.assertEqual(result["current"]["totalTokens"], 150)
                self.assertTrue(result["current"]["partialTokens"])
                self.assertEqual({model["id"] for model in result["lifetimeModels"]}, {"test/model", "unknown"})

    def testLorebookProviderIdsAreDeduplicatedAgainstOtherSources(self):
        self.addRow(generation_id="shared-provider-id")
        self.addRow("lorebook_usage", generation_id="shared-provider-id")
        result = self.summary()
        self.assertEqual(result["current"]["requests"], 1)
        self.assertEqual(result["current"]["cost"], 0.5)

    def testLorebookUsageRespectsDatesAndMissingValues(self):
        self.addRow("lorebook_usage", id="complete")
        self.addRow("lorebook_usage", id="failed", cost=None, prompt_tokens=None, completion_tokens=None, total_tokens=None)
        self.addRow("lorebook_usage", id="old", created_at="2025-01-01T12:00:00Z", cost=2)
        self.addRow("lorebook_usage", id="previous", created_at="2026-09-01T12:00:00Z", cost=1)
        self.addRow("lorebook_usage", id="future", created_at="2027-01-01T12:00:00Z", cost=100)
        result = self.summary()
        self.assertEqual(result["current"]["requests"], 2)
        self.assertTrue(result["current"]["partialCost"])
        self.assertTrue(result["current"]["partialTokens"])
        self.assertEqual(result["previous"]["cost"], 1)
        self.assertEqual(result["lifetimeModels"][0]["cost"], 3.5)
        self.assertEqual(result["lifetimeModels"][0]["requests"], 4)

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
        self.assertTrue(current["partialCost"])
        self.assertTrue(current["partialTokens"])
        self.assertIsNone(current["promptTokens"])
        self.assertIsNone(current["blendedCost"])
        self.assertEqual(current["missingTokens"], 1)

    def testMixedMissingUsageKeepsRecordedTotalsAcrossAggregates(self):
        self.addRow()
        self.addRow(id="missing", cost=None, prompt_tokens=None, completion_tokens=None, total_tokens=None)
        result = self.summary()
        for totals in (result["current"], result["days"][-1], result["models"][0], result["lifetimeModels"][0]):
            self.assertEqual(totals["cost"], 0.5)
            self.assertEqual(totals["totalTokens"], 150)
            self.assertTrue(totals["partialCost"])
            self.assertTrue(totals["partialTokens"])
            self.assertIsNone(totals["promptTokens"])
            self.assertEqual(totals["requests"], 2)
        self.assertIsNone(result["days"][-1]["models"]["test/model"])

    def testFreeUsageAndKnownTotalRemainAvailable(self):
        self.addRow(cost=0, prompt_tokens=None, total_tokens=150)
        current = self.summary()["current"]
        self.assertEqual(current["cost"], 0)
        self.assertEqual(current["totalTokens"], 150)
        self.assertIsNone(current["promptTokens"])

    def testLocalMidnightAndPreviousWeekBoundaries(self):
        self.addRow(id="previous", created_at="2026-09-03T06:59:59Z", cost=1)
        self.addRow(id="current", created_at="2026-09-03T07:00:00Z", cost=2)
        self.addRow(id="old", created_at="2026-08-27T06:59:59Z", cost=4)
        self.addRow(id="future", created_at="2026-09-10T03:00:00Z", cost=8)
        result = self.summary()
        self.assertEqual(result["previous"]["cost"], 1)
        self.assertEqual(result["current"]["cost"], 2)
        self.assertEqual(result["days"][0]["cost"], 2)

    def testDaylightSavingTransitionsUseHistoricalOffsets(self):
        for currentTime, rowTime, expectedDate in (
            ("2026-11-07T12:00:00+00:00", "2026-11-01T07:30:00Z", "2026-11-01"),
            ("2026-03-14T12:00:00+00:00", "2026-03-08T07:30:00Z", "2026-03-07"),
        ):
            with self.subTest(currentTime=currentTime):
                self.conn.execute("DELETE FROM messages")
                self.addRow(created_at=rowTime)
                result = getUsage(self.conn, now=datetime.fromisoformat(currentTime), timeZone="America/Los_Angeles")
                if expectedDate < result["startDate"]:
                    self.assertEqual(result["previous"]["requests"], 1)
                    self.assertEqual(result["current"]["requests"], 0)
                else:
                    self.assertEqual(result["current"]["requests"], 1)
                    self.assertEqual(next(day for day in result["days"] if day["date"] == expectedDate)["requests"], 1)

    def testInvalidNumbersAreMissingAndTotalsStayFinite(self):
        self.addRow(cost=float("inf"), prompt_tokens=-1, total_tokens=-1)
        current = self.summary()["current"]
        self.assertIsNone(current["cost"])
        self.assertIsNone(current["totalTokens"])
        self.assertIsNone(current["promptTokens"])

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

    def testMalformedImportedDatesAreSkippedBeforeDeduplication(self):
        for index, value in enumerate(("0", "now", "not-a-date", "2026-02-30T12:00:00Z", "0001-01-01T00:00:00Z")):
            self.addRow(id=f"invalid-{index}", created_at=value, generation_id="shared")
        self.addRow(id="valid", generation_id="shared")
        result = self.summary()
        self.assertEqual(result["current"]["requests"], 1)
        self.assertEqual(result["current"]["cost"], 0.5)
        self.assertEqual(result["lifetimeModels"][0]["requests"], 1)
        self.assertEqual(result["lifetimeModels"][0]["cost"], 0.5)

    def testBundledTimezonesWorkWithoutSystemDatabase(self):
        originalPath = zoneinfo.TZPATH
        try:
            zoneinfo.reset_tzpath(())
            zoneinfo.ZoneInfo.clear_cache()
            self.testDaylightSavingTransitionsUseHistoricalOffsets()
            self.testEndpointValidatesOffsetAndDoesNotCallProvider()
        finally:
            zoneinfo.reset_tzpath(originalPath)
            zoneinfo.ZoneInfo.clear_cache()

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
            self.assertEqual(client.get("/api/usage?timeZone=America%2FLos_Angeles").status_code, 200)
            self.assertEqual(client.get("/api/usage?timeZone=Invalid%2FZone").status_code, 422)

    def testTranscriptionCountsInDailyWeeklyAndLifetimeSpend(self):
        self.addRow("transcription_usage", model="openai/whisper-1", cost=0.03,
                    prompt_tokens=None, completion_tokens=None, reasoning_tokens=None, total_tokens=None)
        self.addRow("transcription_usage", id="older", model="openai/whisper-1", cost=0.02,
                    created_at="2026-09-01T12:00:00Z")
        self.addRow(cost=0.5)
        result = self.summary()
        self.assertAlmostEqual(result["current"]["cost"], 0.53)
        self.assertEqual(result["current"]["requests"], 2)
        self.assertEqual(result["previous"]["cost"], 0.02)
        self.assertEqual(result["days"][-1]["models"]["openai/whisper-1"], 0.03)
        weekly = next(model for model in result["models"] if model["id"] == "openai/whisper-1")
        self.assertEqual(weekly["cost"], 0.03)
        self.assertIsNone(weekly["totalTokens"])
        lifetime = next(model for model in result["lifetimeModels"] if model["id"] == "openai/whisper-1")
        self.assertAlmostEqual(lifetime["cost"], 0.05)
        self.assertEqual(lifetime["requests"], 2)

    def testTranscriptionCatalogNamesAreIncludedWithoutProviderRequests(self):
        self.addRow("transcription_usage", model="openai/whisper-1")
        def getDb():
            conn = sqlite3.connect(self.dbPath)
            conn.row_factory = sqlite3.Row
            return conn

        app = FastAPI()
        app.include_router(createUsageRouter(getDb, lambda key: [{"id": "openai/whisper-1", "name": "Whisper"}]))
        with TestClient(app) as client, patch("httpx.AsyncClient", side_effect=AssertionError("Provider call forbidden")):
            result = client.get("/api/usage").json()
        self.assertEqual(result["lifetimeModels"][0]["name"], "Whisper")
