import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from backend.lorebook_usage import LorebookUsage, ensureLorebookUsageTable
from backend.main import normalize_generation_usage


class LorebookUsageTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempDir.cleanup)
        self.dbPath = Path(self.tempDir.name) / "usage.sqlite3"
        self.lookup = AsyncMock(return_value=None)
        self.deps = SimpleNamespace(
            get_db=self.getDb,
            utc_now=lambda: "2026-09-10T12:00:00Z",
            fetch_generation_usage=self.lookup,
        )
        with self.getDb() as conn:
            conn.execute("CREATE TABLE stories (id TEXT PRIMARY KEY)")
            conn.execute("CREATE TABLE chapters (id TEXT PRIMARY KEY)")
            conn.execute("INSERT INTO stories VALUES ('story')")
            conn.execute("INSERT INTO chapters VALUES ('chapter')")
            ensureLorebookUsageTable(conn)

    def getDb(self):
        conn = sqlite3.connect(self.dbPath)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def newRun(self, chapterId=None):
        return LorebookUsage(self.deps, "test-key", "story", "test/model", "generate", chapterId)

    def savedRows(self):
        with self.getDb() as conn:
            return [dict(row) for row in conn.execute("SELECT * FROM lorebook_usage")]

    async def testMigrationPreservesExistingRecordsAndAllowsStoryWideCalls(self):
        async with self.newRun() as run:
            run.addUsage({"prompt_tokens": 10, "completion_tokens": 4, "reasoning_tokens": 2, "cost": 0.5})
        beforeRows = self.savedRows()
        with self.getDb() as conn:
            conn.execute("CREATE TABLE lorebook_update_runs (id TEXT PRIMARY KEY, cost REAL)")
            conn.execute("INSERT INTO lorebook_update_runs VALUES ('legacy', 1.25)")
            ensureLorebookUsageTable(conn)
            ensureLorebookUsageTable(conn)
            self.assertEqual(tuple(conn.execute("SELECT id, cost FROM lorebook_update_runs").fetchone()), ("legacy", 1.25))
        self.assertEqual(self.savedRows(), beforeRows)
        self.assertIsNone(beforeRows[0]["chapter_id"])
        self.assertEqual(beforeRows[0]["total_tokens"], 14)

    async def testRequestExistsBeforeResponseAndIsUpdatedOnce(self):
        async with self.newRun("chapter") as run:
            initial = self.savedRows()
            self.assertEqual(len(initial), 1)
            self.assertEqual(initial[0]["model"], "test/model")
            self.assertIsNone(initial[0]["cost"])
            run.generationId = "provider-id"
            run.addUsage({"prompt_tokens": 10, "completion_tokens": 4, "cost": 0})
        saved = self.savedRows()
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]["id"], initial[0]["id"])
        self.assertEqual(saved[0]["generation_id"], "provider-id")
        self.assertEqual(saved[0]["total_tokens"], 14)
        self.assertEqual(saved[0]["cost"], 0)
        self.lookup.assert_not_awaited()

    async def testLookupFillsGapsWithoutErasingStreamingCounts(self):
        self.lookup.return_value = {"cost": 0, "prompt_tokens": None, "completion_tokens": 8, "reasoning_tokens": None, "total_tokens": None}
        async with self.newRun() as run:
            run.generationId = "provider-id"
            run.addUsage({"prompt_tokens": 10, "completion_tokens": 4, "reasoning_tokens": 2})
            run.addUsage({"prompt_tokens": None, "completion_tokens": 5, "reasoning_tokens": None})
        saved = self.savedRows()[0]
        self.assertEqual(saved["prompt_tokens"], 10)
        self.assertEqual(saved["completion_tokens"], 8)
        self.assertEqual(saved["reasoning_tokens"], 2)
        self.assertEqual(saved["total_tokens"], 18)
        self.assertEqual(saved["cost"], 0)
        self.lookup.assert_awaited_once_with("test-key", "provider-id")

    async def testLookupFailureKeepsAvailableUsage(self):
        self.lookup.side_effect = RuntimeError("Lookup unavailable")
        async with self.newRun() as run:
            run.generationId = "provider-id"
            run.addUsage({"prompt_tokens": 10})
        saved = self.savedRows()[0]
        self.assertEqual(saved["prompt_tokens"], 10)
        self.assertIsNone(saved["cost"])
        self.assertIsNone(saved["total_tokens"])

    async def testReportedTotalSurvivesAnIncompleteLookup(self):
        self.lookup.return_value = {"cost": 0.2, "total_tokens": None}
        async with self.newRun() as run:
            run.generationId = "provider-id"
            run.addUsage({"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 20})
        self.assertEqual(self.savedRows()[0]["total_tokens"], 20)

    async def testFailedStreamStillSavesSupplementedUsage(self):
        self.lookup.return_value = {"prompt_tokens": 10, "completion_tokens": 4, "cost": 0.2}
        with self.assertRaisesRegex(RuntimeError, "Stream failed"):
            async with self.newRun() as run:
                run.generationId = "provider-id"
                raise RuntimeError("Stream failed")
        self.assertEqual(self.savedRows()[0]["total_tokens"], 14)

    async def testCancellationAndGeneratorCloseSaveWithoutLookup(self):
        for errorType in (asyncio.CancelledError, GeneratorExit):
            with self.subTest(errorType=errorType):
                with self.assertRaises(errorType):
                    async with self.newRun() as run:
                        run.generationId = "provider-id"
                        run.addUsage({"prompt_tokens": 10})
                        raise errorType()
        self.lookup.assert_not_awaited()
        self.assertEqual(len(self.savedRows()), 2)
        for saved in self.savedRows():
            self.assertEqual(saved["prompt_tokens"], 10)
            self.assertEqual(saved["generation_id"], "provider-id")
            self.assertIsNone(saved["cost"])

    async def testCancellationDuringLookupStillSavesStreamingUsage(self):
        self.lookup.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            async with self.newRun() as run:
                run.generationId = "provider-id"
                run.addUsage({"prompt_tokens": 10})
        self.assertEqual(self.savedRows()[0]["prompt_tokens"], 10)

    async def testDeletedParentsRemoveUsageWithoutResurrectingRecords(self):
        async with self.newRun("chapter"):
            with self.getDb() as conn:
                conn.execute("DELETE FROM chapters WHERE id = 'chapter'")
        self.assertEqual(self.savedRows(), [])
        async with self.newRun():
            pass
        with self.getDb() as conn:
            conn.execute("DELETE FROM stories WHERE id = 'story'")
        self.assertEqual(self.savedRows(), [])

    def testGenerationNormalizationPreservesZeroAndFallsBackForMissingValues(self):
        result = normalize_generation_usage({
            "native_tokens_prompt": 0, "tokens_prompt": 20,
            "native_tokens_completion": 0, "tokens_completion": 10,
            "total_cost": 0, "usage": 1,
        })
        self.assertEqual(result["prompt_tokens"], 0)
        self.assertEqual(result["completion_tokens"], 0)
        self.assertEqual(result["total_tokens"], 0)
        self.assertEqual(result["cost"], 0)
        result = normalize_generation_usage({
            "native_tokens_prompt": None, "tokens_prompt": 20,
            "native_tokens_completion": None, "tokens_completion": 10,
            "total_cost": None, "usage": 1,
        })
        self.assertEqual(result["total_tokens"], 30)
        self.assertEqual(result["cost"], 1)
