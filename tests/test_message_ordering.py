import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from backend import main


class MessageOrderingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempDir = TemporaryDirectory()
        self.oldDataDir = main.DATA_DIR
        self.oldDbPath = main.DB_PATH
        self.oldReadOpenrouterKey = main.read_openrouter_key

        main.DATA_DIR = Path(self.tempDir.name) / "data"
        main.DB_PATH = main.DATA_DIR / "routerchat.sqlite3"
        main.init_db()

    def tearDown(self) -> None:
        main.DATA_DIR = self.oldDataDir
        main.DB_PATH = self.oldDbPath
        main.read_openrouter_key = self.oldReadOpenrouterKey
        self.tempDir.cleanup()

    def insertChat(self, chatId: str = "chat") -> None:
        with main.get_db() as conn:
            conn.execute(
                """
                INSERT INTO chats (
                  id, title, model, system_prompt, temperature, max_tokens,
                  thinking_enabled, reasoning_effort, created_at, updated_at
                )
                VALUES (?, 'New chat', 'model-a', '', 0.7, 30000, 0, 'medium', ?, ?)
                """,
                (chatId, "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"),
            )

    def insertMessage(
        self,
        messageId: str,
        role: str,
        content: str,
        messageOrder: int,
        createdAt: str = "2026-01-01T00:00:00+00:00",
        chatId: str = "chat",
    ) -> None:
        with main.get_db() as conn:
            conn.execute(
                """
                INSERT INTO messages (
                  id, chat_id, role, content, message_order, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (messageId, chatId, role, content, messageOrder, createdAt),
            )

    def messageIds(self, chatId: str = "chat") -> list[str]:
        return [
            item["id"]
            for item in main.get_chat(chatId)["messages"]
        ]

    def test_legacy_messages_get_stable_order_on_migration(self) -> None:
        with main.get_db() as conn:
            conn.execute("DROP TABLE messages")
            conn.execute(
                """
                CREATE TABLE messages (
                  id TEXT PRIMARY KEY,
                  chat_id TEXT NOT NULL,
                  role TEXT NOT NULL,
                  content TEXT NOT NULL,
                  reasoning TEXT,
                  model TEXT,
                  finish_reason TEXT,
                  error TEXT,
                  created_at TEXT NOT NULL,
                  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                """
                INSERT INTO chats (
                  id, title, model, system_prompt, temperature, max_tokens,
                  thinking_enabled, reasoning_effort, created_at, updated_at
                )
                VALUES ('chat', 'New chat', 'model-a', '', 0.7, 30000, 0, 'medium', ?, ?)
                """,
                ("2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"),
            )
            conn.execute(
                """
                INSERT INTO messages (id, chat_id, role, content, created_at)
                VALUES ('same-a', 'chat', 'user', 'same a', '2026-01-01T00:00:00+00:00')
                """
            )
            conn.execute(
                """
                INSERT INTO messages (id, chat_id, role, content, created_at)
                VALUES ('older', 'chat', 'user', 'older', '2025-01-01T00:00:00+00:00')
                """
            )
            conn.execute(
                """
                INSERT INTO messages (id, chat_id, role, content, created_at)
                VALUES ('same-b', 'chat', 'assistant', 'same b', '2026-01-01T00:00:00+00:00')
                """
            )

        main.init_db()

        with main.get_db() as conn:
            rows = conn.execute(
                """
                SELECT id, message_order FROM messages
                WHERE chat_id = 'chat'
                ORDER BY message_order ASC
                """
            ).fetchall()

        self.assertEqual(
            [(row["id"], row["message_order"]) for row in rows],
            [("older", 0), ("same-a", 1), ("same-b", 2)],
        )

    def test_edit_deletes_later_message_with_same_created_at(self) -> None:
        self.insertChat()
        self.insertMessage("prompt", "user", "old prompt", 0)
        self.insertMessage("reply", "assistant", "stale reply", 1)

        result = main.update_message(
            "chat",
            "prompt",
            main.MessageUpdateRequest(content="edited prompt"),
        )

        self.assertEqual([item["id"] for item in result["messages"]], ["prompt"])
        self.assertEqual(result["messages"][0]["content"], "edited prompt")

    def test_delete_uses_message_position_not_shared_created_at(self) -> None:
        self.insertChat()
        self.insertMessage("first", "user", "first prompt", 0)
        self.insertMessage("second", "user", "second prompt", 1)

        result = main.delete_message("chat", "second")

        self.assertEqual([item["id"] for item in result["messages"]], ["first"])

    def test_import_uses_payload_order_not_created_at(self) -> None:
        payload = main.ChatImportRequest(
            chats=[
                {
                    "id": "source",
                    "title": "Imported",
                    "model": "model-a",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00",
                }
            ],
            messages=[
                {
                    "id": "newer",
                    "chat_id": "source",
                    "role": "user",
                    "content": "newer first",
                    "created_at": "2026-01-02T00:00:00+00:00",
                },
                {
                    "id": "older",
                    "chat_id": "source",
                    "role": "assistant",
                    "content": "older second",
                    "created_at": "2026-01-01T00:00:00+00:00",
                },
            ],
        )

        main.import_chats(payload)

        self.assertEqual(self.messageIds("source"), ["newer", "older"])
        self.assertEqual(
            main.build_openrouter_messages("source", ""),
            [
                {"role": "user", "content": "newer first"},
                {"role": "assistant", "content": "older second"},
            ],
        )

    def test_regeneration_deletes_later_messages_by_position(self) -> None:
        self.insertChat()
        self.insertMessage("prompt", "user", "prompt", 0)
        self.insertMessage("reply", "assistant", "reply", 1)
        self.insertMessage("later", "user", "later", 2)
        main.read_openrouter_key = lambda: "test-key"

        response = asyncio.run(
            main.stream_message(
                "chat",
                main.StreamMessageRequest(
                    message="prompt",
                    model="model-a",
                    regenerate_message_id="prompt",
                ),
            )
        )

        self.assertEqual(response.headers["X-User-Message-Id"], "prompt")
        self.assertEqual(self.messageIds(), ["prompt"])

    def test_regeneration_rejects_missing_message_id(self) -> None:
        self.insertChat()
        self.insertMessage("prompt", "user", "prompt", 0)
        self.insertMessage("reply", "assistant", "reply", 1)
        main.read_openrouter_key = lambda: "test-key"

        with self.assertRaises(main.HTTPException) as error:
            asyncio.run(
                main.stream_message(
                    "chat",
                    main.StreamMessageRequest(
                        message="prompt",
                        model="model-a",
                        regenerate_message_id="missing",
                    ),
                )
            )

        self.assertEqual(error.exception.status_code, 404)
        self.assertEqual(error.exception.detail, "Message not found.")
        self.assertEqual(self.messageIds(), ["prompt", "reply"])

    def test_regeneration_rejects_assistant_message_id(self) -> None:
        self.insertChat()
        self.insertMessage("prompt", "user", "prompt", 0)
        self.insertMessage("reply", "assistant", "reply", 1)
        self.insertMessage("later", "user", "later", 2)
        main.read_openrouter_key = lambda: "test-key"

        with self.assertRaises(main.HTTPException) as error:
            asyncio.run(
                main.stream_message(
                    "chat",
                    main.StreamMessageRequest(
                        message="reply",
                        model="model-a",
                        regenerate_message_id="reply",
                    ),
                )
            )

        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(error.exception.detail, "Only user prompts can be regenerated.")
        self.assertEqual(self.messageIds(), ["prompt", "reply", "later"])


if __name__ == "__main__":
    unittest.main()
