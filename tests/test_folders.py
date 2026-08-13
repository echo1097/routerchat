import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import backend.main as main
from backend.local_access import create_secret_file


def acceptCurrentTos():
    tos = main.load_tos()
    if not tos:
        raise RuntimeError("TOS.md is missing, restore it before running the tests")
    main.record_tos_acceptance(tos["hash"], tos["date"])


class FolderApiTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = main.DATA_DIR
        self.originalDbPath = main.DB_PATH
        main.DATA_DIR = Path(self.tempDir.name)
        main.DB_PATH = main.DATA_DIR / "routerchat-test.sqlite3"
        self.baseUrl = "http://127.0.0.1:8000"
        self.apiSecretPath = main.DATA_DIR / "run" / "api-secret"
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
        main.DATA_DIR = self.originalDataDir
        main.DB_PATH = self.originalDbPath
        self.tempDir.cleanup()

    def createFolder(self, name="Work"):
        response = self.client.post("/api/folders", json={"name": name})
        self.assertEqual(response.status_code, 200)
        return response.json()["folder"]

    def createChat(self, **payload):
        response = self.client.post("/api/chats", json={"model": "test/model", **payload})
        self.assertEqual(response.status_code, 200)
        return response.json()["chat"]

    def test_folder_create_list_and_rename(self):
        folder = self.createFolder("Work")
        self.assertEqual(folder["name"], "Work")
        self.assertEqual(folder["chat_count"], 0)

        renamed = self.client.patch(
            f"/api/folders/{folder['id']}", json={"name": "Research"}
        ).json()["folder"]
        self.assertEqual(renamed["name"], "Research")

        folders = self.client.get("/api/folders").json()["folders"]
        self.assertEqual([item["name"] for item in folders], ["Research"])

    def test_chat_can_be_created_in_a_folder_and_moved_out(self):
        folder = self.createFolder()
        chat = self.createChat(folder_id=folder["id"])
        self.assertEqual(chat["folder_id"], folder["id"])

        listed = self.client.get("/api/folders").json()["folders"][0]
        self.assertEqual(listed["chat_count"], 1)

        moved = self.client.patch(
            f"/api/chats/{chat['id']}", json={"folder_id": ""}
        ).json()["chat"]
        self.assertIsNone(moved["folder_id"])

        listed = self.client.get("/api/folders").json()["folders"][0]
        self.assertEqual(listed["chat_count"], 0)

    def test_deleting_a_folder_keeps_its_chats_by_default(self):
        folder = self.createFolder()
        chat = self.createChat(folder_id=folder["id"])

        self.client.delete(f"/api/folders/{folder['id']}")

        remaining = self.client.get(f"/api/chats/{chat['id']}").json()["chat"]
        self.assertIsNone(remaining["folder_id"])
        self.assertEqual(self.client.get("/api/folders").json()["folders"], [])

    def test_deleting_a_folder_with_chats_can_remove_them_too(self):
        folder = self.createFolder()
        chat = self.createChat(folder_id=folder["id"])

        self.client.delete(f"/api/folders/{folder['id']}?delete_chats=true")

        self.assertEqual(self.client.get(f"/api/chats/{chat['id']}").status_code, 404)

    def test_unknown_folder_is_rejected(self):
        self.assertEqual(
            self.client.post("/api/chats", json={"folder_id": "missing"}).status_code, 404
        )
        chat = self.createChat()
        self.assertEqual(
            self.client.patch(
                f"/api/chats/{chat['id']}", json={"folder_id": "missing"}
            ).status_code,
            404,
        )

    def test_folder_column_migration_upgrades_an_old_chats_table(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            CREATE TABLE chats (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              model TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO chats (id, title, model, updated_at) VALUES ('a', 'Old', 'm', 'now')"
        )

        main.ensure_chat_folder_column(conn)
        main.ensure_chat_folder_column(conn)

        row = conn.execute("SELECT * FROM chats WHERE id = 'a'").fetchone()
        self.assertIsNone(row["folder_id"])
        conn.close()


if __name__ == "__main__":
    unittest.main()
