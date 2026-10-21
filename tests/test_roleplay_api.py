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
from backend.roleplay.buildRoleplayMessages import buildRoleplayMessages
from backend.roleplay.roleplayCharacterRows import openingGreeting


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

    def createCharacter(self, roleplayId, **payload):
        response = self.client.post(
            f"/api/roleplays/{roleplayId}/characters",
            json={"name": "Maya", **payload},
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["character"]

    def test_characters_create_list_update_and_delete(self):
        roleplay = self.createRoleplay()
        character = self.createCharacter(
            roleplay["id"],
            name="Maya",
            description="runs the late shift",
            speech_style="all lowercase",
        )
        self.assertEqual(character["kind"], "cast")
        self.assertFalse(character["disabled"])

        listed = self.client.get(f"/api/roleplays/{roleplay['id']}/characters").json()
        self.assertEqual([item["name"] for item in listed["characters"]], ["Maya"])

        updated = self.client.patch(
            f"/api/roleplays/{roleplay['id']}/characters/{character['id']}",
            json={"name": "Maya", "personality": "dry", "disabled": True},
        ).json()["character"]
        self.assertEqual(updated["personality"], "dry")
        self.assertTrue(updated["disabled"])

        self.assertEqual(
            self.client.delete(
                f"/api/roleplays/{roleplay['id']}/characters/{character['id']}"
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.get(f"/api/roleplays/{roleplay['id']}/characters").json()["characters"],
            [],
        )

    def test_only_one_character_is_played_by_you(self):
        roleplay = self.createRoleplay()
        first = self.createCharacter(roleplay["id"], name="Alex", kind="user")
        second = self.createCharacter(roleplay["id"], name="Sam", kind="user")

        characters = self.client.get(
            f"/api/roleplays/{roleplay['id']}/characters"
        ).json()["characters"]
        kinds = {item["name"]: item["kind"] for item in characters}
        self.assertEqual(kinds, {"Alex": "cast", "Sam": "user"})

        self.client.patch(
            f"/api/roleplays/{roleplay['id']}/characters/{first['id']}",
            json={"name": "Alex", "kind": "user"},
        )
        characters = self.client.get(
            f"/api/roleplays/{roleplay['id']}/characters"
        ).json()["characters"]
        kinds = {item["name"]: item["kind"] for item in characters}
        self.assertEqual(kinds, {"Alex": "user", "Sam": "cast"})
        self.assertEqual(second["kind"], "user")

    def test_characters_stay_inside_their_own_roleplay(self):
        first = self.createRoleplay(title="First")
        second = self.createRoleplay(title="Second")
        character = self.createCharacter(first["id"], name="Maya")

        self.assertEqual(
            self.client.get(f"/api/roleplays/{second['id']}/characters").json()["characters"],
            [],
        )
        self.assertEqual(
            self.client.patch(
                f"/api/roleplays/{second['id']}/characters/{character['id']}",
                json={"name": "Maya"},
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.delete(
                f"/api/roleplays/{second['id']}/characters/{character['id']}"
            ).status_code,
            404,
        )

    def test_deleting_a_roleplay_removes_its_characters(self):
        roleplay = self.createRoleplay()
        self.createCharacter(roleplay["id"], name="Maya")

        self.client.delete(f"/api/roleplays/{roleplay['id']}")

        with getDb() as conn:
            remaining = conn.execute(
                "SELECT COUNT(*) AS total FROM roleplay_characters"
            ).fetchone()["total"]
        self.assertEqual(remaining, 0)

    def test_characters_travel_with_an_export(self):
        roleplay = self.createRoleplay(title="Night shift")
        self.createCharacter(roleplay["id"], name="Maya", description="runs the late shift")
        self.createCharacter(roleplay["id"], name="Alex", kind="user")

        exported = self.client.get(f"/api/roleplays/{roleplay['id']}/export").json()
        self.assertEqual(
            [item["name"] for item in exported["characters"]], ["Maya", "Alex"]
        )

        imported = self.client.post("/api/roleplays/import", json=exported).json()
        self.assertEqual(imported["imported_characters"], 2)

        titles = {item["title"]: item["id"] for item in self.client.get("/api/roleplays").json()["roleplays"]}
        copyId = next(
            roleplayId for title, roleplayId in titles.items() if roleplayId != roleplay["id"]
        )
        copied = self.client.get(f"/api/roleplays/{copyId}/characters").json()["characters"]
        self.assertEqual([item["name"] for item in copied], ["Maya", "Alex"])
        self.assertEqual(
            [item["kind"] for item in copied], ["cast", "user"]
        )

    def test_context_messages_carry_the_cast_and_your_name(self):
        roleplay = self.createRoleplay()
        self.createCharacter(roleplay["id"], name="Maya", description="runs the late shift")
        self.createCharacter(roleplay["id"], name="Alex", kind="user")

        with getDb() as conn:
            conn.execute(
                """
                INSERT INTO roleplay_messages (id, roleplay_id, role, content, message_order, created_at)
                VALUES (?, ?, 'user', 'hey', 0, '2026-01-01T00:00:00Z')
                """,
                ("m1", roleplay["id"]),
            )

        messages = buildRoleplayMessages(roleplay["id"], "stay in character")

        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("stay in character", messages[0]["content"])
        self.assertIn("Never write a line as Alex.", messages[0]["content"])
        self.assertEqual(messages[1], {"role": "user", "content": "Alex: hey"})

    def test_context_messages_stay_bare_without_a_cast(self):
        roleplay = self.createRoleplay()

        with getDb() as conn:
            conn.execute(
                """
                INSERT INTO roleplay_messages (id, roleplay_id, role, content, message_order, created_at)
                VALUES (?, ?, 'user', 'hey', 0, '2026-01-01T00:00:00Z')
                """,
                ("m1", roleplay["id"]),
            )

        messages = buildRoleplayMessages(roleplay["id"], "")

        self.assertEqual(messages, [{"role": "user", "content": "hey"}])

    def test_scene_fields_save_on_the_roleplay(self):
        roleplay = self.createRoleplay()

        patched = self.client.patch(
            f"/api/roleplays/{roleplay['id']}",
            json={"scenario": "A diner at 3am.", "author_note": "Keep it tense."},
        ).json()["roleplay"]

        self.assertEqual(patched["scenario"], "A diner at 3am.")
        self.assertEqual(patched["author_note"], "Keep it tense.")

        reloaded = self.client.get(f"/api/roleplays/{roleplay['id']}").json()["roleplay"]
        self.assertEqual(reloaded["scenario"], "A diner at 3am.")

    def test_the_scenario_reaches_the_system_prompt(self):
        roleplay = self.createRoleplay()
        self.createCharacter(roleplay["id"], name="Maya")
        self.client.patch(
            f"/api/roleplays/{roleplay['id']}", json={"scenario": "The power is out."}
        )

        messages = buildRoleplayMessages(roleplay["id"], "")

        self.assertIn("The power is out.", messages[0]["content"])

    def test_greetings_open_the_scene(self):
        roleplay = self.createRoleplay()
        self.createCharacter(roleplay["id"], name="Maya", greeting="you're up late")
        self.createCharacter(roleplay["id"], name="Jon", greeting="Hey. Long time.")
        self.createCharacter(roleplay["id"], name="Alex", kind="user")

        with getDb() as conn:
            opening = openingGreeting(conn, roleplay["id"])

        self.assertEqual(opening, "Maya: you're up late\nJon: Hey. Long time.")

    def test_a_silent_cast_opens_with_nothing(self):
        roleplay = self.createRoleplay()
        self.createCharacter(roleplay["id"], name="Maya")

        with getDb() as conn:
            self.assertEqual(openingGreeting(conn, roleplay["id"]), "")

    def test_a_greeting_expands_macros(self):
        roleplay = self.createRoleplay()
        self.createCharacter(roleplay["id"], name="Maya", greeting="hey {{user}}, {{char}} here")
        self.createCharacter(roleplay["id"], name="Alex", kind="user")

        with getDb() as conn:
            self.assertEqual(
                openingGreeting(conn, roleplay["id"]), "Maya: hey Alex, Maya here"
            )

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
