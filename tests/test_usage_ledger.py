import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import backend.core.paths as paths
import backend.main as main
import backend.tos.loadTos as loadTos
import backend.tos.tosAcceptance as tosAcceptance
import backend.usage.migrateLegacyUsage as migrateLegacyUsage
from backend.chats.chatModels import StreamMessageRequest
from backend.chats.streamMessage import saveAssistantReply
from backend.local_access import create_secret_file
from backend.usage.recordUsage import recordUsage


def acceptCurrentTos():
    tos = loadTos.load_tos()
    if not tos:
        raise RuntimeError("TOS.md is missing, restore it before running the tests")
    tosAcceptance.record_tos_acceptance(tos["hash"], tos["date"])


class UsageLedgerTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = paths.DATA_DIR
        self.originalDbPath = paths.DB_PATH
        paths.DATA_DIR = Path(self.tempDir.name)
        paths.DB_PATH = paths.DATA_DIR / "routerchat.sqlite3"
        self.baseUrl = "http://127.0.0.1:8000"
        self.apiSecretPath = paths.DATA_DIR / "run" / "api-secret"
        self.apiSecret = create_secret_file(self.apiSecretPath)
        self.localAccessEnvironment = patch.dict(
            os.environ,
            {
                "ROUTERCHAT_API_SECRET_FILE": str(self.apiSecretPath),
                "ROUTERCHAT_BASE_URL": self.baseUrl,
                "ROUTERCHAT_TRUSTED_ORIGINS": self.baseUrl,
            },
        )
        self.localAccessEnvironment.start()
        main.reset_local_access_config()
        main.init_db()
        acceptCurrentTos()
        self.client = TestClient(
            main.app,
            base_url=self.baseUrl,
            headers={"Origin": self.baseUrl, "Sec-Fetch-Site": "same-origin"},
        )
        bootstrapResponse = self.client.post(
            "/api/bootstrap",
            data={"secret": self.apiSecret},
            headers={"Origin": "null", "Sec-Fetch-Site": "cross-site"},
            follow_redirects=False,
        )
        if bootstrapResponse.status_code != 303:
            raise RuntimeError("test client could not bootstrap local API access")

    def tearDown(self):
        self.client.close()
        main.reset_local_access_config()
        self.localAccessEnvironment.stop()
        paths.DATA_DIR = self.originalDataDir
        paths.DB_PATH = self.originalDbPath
        self.tempDir.cleanup()

    def query(self, databasePath, sql, parameters=()):
        conn = sqlite3.connect(databasePath)
        try:
            return conn.execute(sql, parameters).fetchall()
        finally:
            conn.close()

    def ledgerRows(self):
        return self.query(paths.usageDbPath(), "SELECT kind, source_id, provider, cost FROM usage_entries ORDER BY source_id")

    def migrationFlag(self):
        return [row for row in self.query(paths.usageDbPath(), "PRAGMA user_version") if row[0]]

    def addLegacyMessage(self, messageId, cost):
        chat = self.client.post("/api/chats", json={"title": "Legacy"}).json()["chat"]
        conn = sqlite3.connect(paths.DB_PATH)
        with conn:
            conn.execute(
                """
                INSERT INTO messages (id, chat_id, role, content, model, cost, total_tokens, created_at)
                VALUES (?, ?, 'assistant', 'Hello', 'test/model', ?, 10, '2026-09-01T12:00:00Z')
                """,
                (messageId, chat["id"], cost),
            )
        conn.close()
        return chat

    def usageTotals(self, provider=None):
        query = f"?provider={provider}" if provider else ""
        response = self.client.get(f"/api/usage{query}")
        self.assertEqual(response.status_code, 200)
        return response.json()["lifetimeModels"]

    def resetLedger(self):
        conn = sqlite3.connect(paths.usageDbPath())
        with conn:
            conn.execute("DELETE FROM usage_entries")
            conn.execute("PRAGMA user_version = 0")
        conn.close()

    def testUsageDatabaseSitsNextToTheMainDatabase(self):
        self.assertEqual(paths.usageDbPath(), paths.DATA_DIR / "usage.sqlite3")
        self.assertTrue(paths.usageDbPath().exists())

    def testLegacyUsageIsCopiedOnceAsOpenRouter(self):
        self.resetLedger()
        self.addLegacyMessage("legacy-1", 0.5)
        main.init_db()
        self.assertEqual(self.ledgerRows(), [("message", "legacy-1", "openrouter", 0.5)])
        self.assertEqual(len(self.migrationFlag()), 1)

        self.addLegacyMessage("legacy-2", 0.25)
        main.init_db()
        self.assertEqual([row[1] for row in self.ledgerRows()], ["legacy-1"])

    def testFailedMigrationLeavesNoFlagAndRetriesNextStart(self):
        self.resetLedger()
        self.addLegacyMessage("legacy-1", 0.5)
        with patch.object(migrateLegacyUsage, "saveUsageEntries", side_effect=sqlite3.OperationalError("disk full")):
            main.init_db()
        self.assertEqual(self.ledgerRows(), [])
        self.assertEqual(self.migrationFlag(), [])

        main.init_db()
        self.assertEqual([row[1] for row in self.ledgerRows()], ["legacy-1"])

    def testDeletedChatKeepsItsCost(self):
        chat = self.client.post("/api/chats", json={"title": "Paid"}).json()["chat"]
        usage = {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150, "cost": 0.4}
        saveAssistantReply(chat["id"], StreamMessageRequest(model="test/model"), "reply-1", ["Hi"], [], [], "stop", None, "gen-1", usage)
        self.assertEqual(self.client.delete(f"/api/chats/{chat['id']}").status_code, 200)

        lifetime = self.usageTotals()
        self.assertEqual(lifetime[0]["cost"], 0.4)
        self.assertEqual(lifetime[0]["totalTokens"], 150)

    def testProviderFilterSeparatesTotals(self):
        recordUsage("message", "open-1", "test/model", {"cost": 1.0, "total_tokens": 10}, "2026-09-01T12:00:00Z", provider="openrouter")
        recordUsage("message", "claude-1", "claude/model", {"cost": 2.0, "total_tokens": 20}, "2026-09-01T12:00:00Z", provider="anthropic")

        self.assertEqual({model["id"] for model in self.usageTotals()}, {"test/model", "claude/model"})
        self.assertEqual([model["cost"] for model in self.usageTotals("anthropic")], [2.0])
        self.assertEqual(self.usageTotals("openai"), [])
        self.assertEqual(self.client.get("/api/usage?provider=nope").status_code, 422)

    def testLocalUsageIsFreeSoAllTotalsStayComplete(self):
        recordUsage("message", "open-1", "test/model", {"cost": 1.0, "total_tokens": 10}, "2026-09-01T12:00:00Z", provider="openrouter")
        recordUsage("message", "local-1", "local/model", {"total_tokens": 20}, "2026-09-01T12:00:00Z", provider="local")

        lifetime = {model["id"]: model for model in self.usageTotals()}
        self.assertEqual(lifetime["local/model"]["cost"], 0)
        self.assertFalse(lifetime["local/model"]["partialCost"])
        self.assertEqual(lifetime["test/model"]["cost"], 1.0)

    def testSettledUsageReplacesThePendingEntry(self):
        recordUsage("story", "story-1", "test/model", None, "2026-09-01T12:00:00Z")
        recordUsage("story", "story-1", "test/model", {"cost": 0.3}, "2026-09-01T12:00:05Z")
        self.assertEqual(self.ledgerRows(), [("story", "story-1", "openrouter", 0.3)])

    def testImportedChatsAreNotRecorded(self):
        chat = self.addLegacyMessage("imported-source", 0.9)
        self.resetLedger()
        exported = self.client.get(f"/api/chats/{chat['id']}/export").json()
        self.assertEqual(self.client.post("/api/chats/import", json=exported).status_code, 200)
        self.assertEqual(self.ledgerRows(), [])


if __name__ == "__main__":
    unittest.main()
