import sqlite3
import unittest

import backend.core.migrations as migrations
from tests.localApiHarness import LocalApiHarness


class FolderApiTest(LocalApiHarness, unittest.TestCase):
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


class FolderMigrationTest(unittest.TestCase):
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

        migrations.ensureChatFolderColumn(conn)
        migrations.ensureChatFolderColumn(conn)

        row = conn.execute("SELECT * FROM chats WHERE id = 'a'").fetchone()
        self.assertIsNone(row["folder_id"])
        conn.close()


if __name__ == "__main__":
    unittest.main()
