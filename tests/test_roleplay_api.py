import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import backend.core.paths as paths
import backend.main as main
import backend.tos.loadTos as loadTos
import backend.tos.tosAcceptance as tosAcceptance
from backend.core.database import getDb
from backend.local_access import createSecretFile


def acceptCurrentTos():
    tos = loadTos.loadTos()
    if not tos:
        raise RuntimeError("TOS.md is missing, restore it before running the tests")
    tosAcceptance.recordTosAcceptance(tos["hash"], tos["date"])


class RoleplayApiTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = paths.DATA_DIR
        self.originalDbPath = paths.DB_PATH
        paths.DATA_DIR = Path(self.tempDir.name)
        paths.DB_PATH = paths.DATA_DIR / "routerchat-test.sqlite3"
        self.baseUrl = "http://127.0.0.1:8000"
        self.apiSecretPath = paths.DATA_DIR / "run" / "api-secret"
        self.apiSecret = createSecretFile(self.apiSecretPath)
        self.localAccessEnvironment = patch.dict(
            os.environ,
            {
                "ROUTERCHAT_API_SECRET_FILE": str(self.apiSecretPath),
                "ROUTERCHAT_BASE_URL": self.baseUrl,
                "ROUTERCHAT_TRUSTED_ORIGINS": self.baseUrl,
            },
        )
        self.localAccessEnvironment.start()
        main.resetLocalAccessConfig()
        main.initDb()
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
        main.resetLocalAccessConfig()
        self.localAccessEnvironment.stop()
        paths.DATA_DIR = self.originalDataDir
        paths.DB_PATH = self.originalDbPath
        self.tempDir.cleanup()

    def createRoleplay(self, **payload):
        response = self.client.post(
            "/api/roleplays", json={"model": "test/model", **payload}
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["roleplay"]

    def createChat(self, **payload):
        response = self.client.post("/api/chats", json={"model": "test/model", **payload})
        self.assertEqual(response.status_code, 200)
        return response.json()["chat"]

    def createFolder(self, name="Adventures"):
        response = self.client.post("/api/roleplay-folders", json={"name": name})
        self.assertEqual(response.status_code, 200)
        return response.json()["folder"]

    def test_roleplay_create_list_rename_and_delete(self):
        roleplay = self.createRoleplay()
        self.assertEqual(roleplay["title"], "New roleplay")

        renamed = self.client.patch(
            f"/api/roleplays/{roleplay['id']}", json={"title": "Tavern Night"}
        ).json()["roleplay"]
        self.assertEqual(renamed["title"], "Tavern Night")

        listed = self.client.get("/api/roleplays").json()["roleplays"]
        self.assertEqual([item["title"] for item in listed], ["Tavern Night"])

        self.assertEqual(
            self.client.delete(f"/api/roleplays/{roleplay['id']}").status_code, 200
        )
        self.assertEqual(self.client.get("/api/roleplays").json()["roleplays"], [])

    def test_roleplays_and_chats_stay_in_separate_tables(self):
        chat = self.createChat(title="A chat")
        roleplay = self.createRoleplay(title="A roleplay")

        self.assertEqual(
            [item["title"] for item in self.client.get("/api/chats").json()["chats"]],
            ["A chat"],
        )
        self.assertEqual(
            [item["title"] for item in self.client.get("/api/roleplays").json()["roleplays"]],
            ["A roleplay"],
        )

        #an id from one mode is never reachable from the other
        self.assertEqual(self.client.get(f"/api/chats/{roleplay['id']}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/roleplays/{chat['id']}").status_code, 404)

    def test_roleplay_folders_are_separate_from_chat_folders(self):
        folder = self.createFolder("Campaigns")
        self.assertEqual(folder["roleplay_count"], 0)

        roleplay = self.createRoleplay(folder_id=folder["id"])
        self.assertEqual(roleplay["folder_id"], folder["id"])

        listed = self.client.get("/api/roleplay-folders").json()["folders"][0]
        self.assertEqual(listed["roleplay_count"], 1)

        #the chat sidebar never sees it
        self.assertEqual(self.client.get("/api/folders").json()["folders"], [])

        moved = self.client.patch(
            f"/api/roleplays/{roleplay['id']}", json={"folder_id": ""}
        ).json()["roleplay"]
        self.assertIsNone(moved["folder_id"])

    def test_deleting_a_roleplay_folder_can_remove_its_roleplays(self):
        folder = self.createFolder()
        roleplay = self.createRoleplay(folder_id=folder["id"])

        self.client.delete(f"/api/roleplay-folders/{folder['id']}?delete_roleplays=true")

        self.assertEqual(self.client.get(f"/api/roleplays/{roleplay['id']}").status_code, 404)

    def test_unknown_roleplay_folder_is_rejected(self):
        self.assertEqual(
            self.client.post("/api/roleplays", json={"folder_id": "missing"}).status_code,
            404,
        )

    def test_roleplay_messages_round_trip_and_export(self):
        roleplay = self.createRoleplay()
        with getDb() as conn:
            conn.execute(
                """
                INSERT INTO roleplay_messages (
                  id, roleplay_id, role, content, message_order, created_at
                )
                VALUES ('m1', ?, 'user', 'You enter the tavern', 0, '2026-01-01T00:00:00Z')
                """,
                (roleplay["id"],),
            )

        payload = self.client.get(f"/api/roleplays/{roleplay['id']}").json()
        self.assertEqual([item["content"] for item in payload["messages"]], ["You enter the tavern"])

        exported = self.client.get(f"/api/roleplays/{roleplay['id']}/export").json()
        self.assertEqual(exported["schema"], "routerchat.roleplays.v1")
        self.assertEqual(len(exported["roleplays"]), 1)

        imported = self.client.post(
            "/api/roleplays/import",
            json={"roleplays": exported["roleplays"], "messages": exported["messages"]},
        ).json()
        self.assertEqual(imported["imported_roleplays"], 1)
        self.assertEqual(imported["imported_messages"], 1)

        edited = self.client.patch(
            f"/api/roleplays/{roleplay['id']}/messages/m1",
            json={"content": "You push the tavern door open"},
        ).json()
        self.assertEqual(
            [item["content"] for item in edited["messages"]],
            ["You push the tavern door open"],
        )

        deleted = self.client.delete(f"/api/roleplays/{roleplay['id']}/messages/m1").json()
        self.assertEqual(deleted["messages"], [])

    def test_roleplay_system_prompt_is_its_own_setting(self):
        self.client.patch(
            "/api/settings",
            json={"chat_system_prompt": "be brief", "roleplay_system_prompt": "stay in character"},
        )
        settings = self.client.get("/api/settings").json()
        self.assertEqual(settings["chat_system_prompt"], "be brief")
        self.assertEqual(settings["roleplay_system_prompt"], "stay in character")


if __name__ == "__main__":
    unittest.main()
