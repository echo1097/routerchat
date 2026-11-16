import asyncio
import json
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from backend.chats.chatModels import StreamMessageRequest
from backend.chats.chatRevision import ensureChatRevisionColumn
from backend.chats.streamMessage import streamMessage
from backend.core.database import getDb
from backend.providers.base import ChatRequest
from backend.providers.registry import getActiveProvider
from backend.usage.usageDatabase import getUsageDb
import tests.test_phone_access as phoneAccessTests


class FakeModelStream:
    def __init__(self, provider, request, thinkingEnabled):
        self.request = request
        self.textParts = []
        self.reasoningParts = []
        self.error = None
        self.receivedDone = False
        self.finishReason = None
        self.generationId = "fake-generation"
        self.usage = {"cost": 0.25, "total_tokens": 10}

    async def events(self):
        prompt = self.request.body["messages"][-1]["content"]
        self.textParts.append("answer to " + prompt)
        yield {"type": "content", "value": self.textParts[0]}
        self.receivedDone = True
        self.finishReason = "stop"

    async def fetchFinalUsage(self, apiKey):
        return None


class ChatConflictTest(unittest.TestCase):
    def setUp(self):
        self.fixture = phoneAccessTests.PhoneAccessTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.fixture.pairPhone()
        self.computer = self.fixture.computer
        self.phone = self.fixture.phone
        self.chat = self.computer.post("/api/chats", json={"model": "test/model"}).json()["chat"]
        self.chatId = self.chat["id"]
        self.chatPath = f"/api/chats/{self.chatId}"
        provider = getActiveProvider()
        patches = [
            patch.object(provider, "readKey", return_value="fake-key"),
            patch.object(provider, "buildRequest", side_effect=lambda messages, *args: ChatRequest(
                url="https://example.invalid", headers={}, body={"messages": messages}
            )),
            patch("backend.providers.openrouter.models.lookUpMissingModel", return_value=None),
            patch("backend.chats.streamMessage.ModelStream", FakeModelStream),
            patch("socket.socket.connect", side_effect=AssertionError("Network forbidden")),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

        asyncio.run(self.send("original prompt"))
        self.original = self.computer.get(self.chatPath).json()
        self.userId = self.original["messages"][0]["id"]

    async def send(self, prompt, regenerateId=None, revision=None):
        response = await streamMessage(self.chatId, StreamMessageRequest(
            message=prompt,
            model="test/model",
            regenerate_message_id=regenerateId,
            chat_revision=revision,
        ))
        return [json.loads(part) async for part in response.body_iterator]

    async def startRegeneration(self):
        response = await streamMessage(self.chatId, StreamMessageRequest(
            message="replacement prompt",
            model="test/model",
            regenerate_message_id=self.userId,
            chat_revision=self.original["chat"]["message_revision"],
        ))
        firstEvent = json.loads(await anext(response.body_iterator))
        self.assertEqual(firstEvent["type"], "content")
        return response.body_iterator

    async def finishRegeneration(self, stream):
        return [json.loads(part) async for part in stream]

    def assertConflict(self, events):
        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(events[-1]["value"]["code"], "chat_revision_conflict")

    def testPhoneMessageAndAttachmentSurviveRegeneration(self):
        async def scenario():
            stream = await self.startRegeneration()
            response = self.phone.post(f"{self.chatPath}/messages/stream", json={
                "message": "new phone message", "model": "test/model",
            })
            self.assertEqual(response.status_code, 200)
            latest = self.phone.get(self.chatPath).json()
            phoneUserId = latest["messages"][-2]["id"]
            attachmentPath = Path(self.fixture.tempDir.name) / "phone.txt"
            attachmentPath.write_text("keep this attachment")
            with closing(getDb()) as conn, conn:
                conn.execute(
                    """
                    INSERT INTO attachments (
                      id, chat_id, message_id, filename, mime, kind,
                      size_bytes, stored_path, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    ("phone-file", self.chatId, phoneUserId, "phone.txt", "text/plain",
                     "text", 20, str(attachmentPath), "2026-11-15T00:00:00Z"),
                )
            beforeFinish = self.phone.get(self.chatPath).json()
            self.assertConflict(await self.finishRegeneration(stream))
            saved = self.phone.get(self.chatPath).json()
            self.assertEqual(saved, beforeFinish)
            self.assertEqual([row["content"] for row in saved["messages"]], [
                "original prompt", "answer to original prompt",
                "new phone message", "answer to new phone message",
            ])
            self.assertEqual(saved["messages"][-2]["attachments"][0]["id"], "phone-file")
            self.assertTrue(attachmentPath.exists())
            with closing(getUsageDb()) as conn:
                entries = conn.execute("SELECT cost FROM usage_entries WHERE kind = 'message'").fetchall()
            self.assertEqual(len(entries), 3)
            self.assertEqual(sum(row["cost"] for row in entries), 0.75)

        asyncio.run(scenario())

    def testEditedPromptSurvivesRegeneration(self):
        async def scenario():
            stream = await self.startRegeneration()
            response = self.phone.patch(f"{self.chatPath}/messages/{self.userId}", json={"content": "phone edit"})
            self.assertEqual(response.status_code, 200)
            self.assertConflict(await self.finishRegeneration(stream))
            self.assertEqual(self.phone.get(self.chatPath).json()["messages"], response.json()["messages"])

        asyncio.run(scenario())

    def testDeletedPromptIsNotRestored(self):
        async def scenario():
            stream = await self.startRegeneration()
            self.assertEqual(self.phone.delete(f"{self.chatPath}/messages/{self.userId}").status_code, 200)
            self.assertConflict(await self.finishRegeneration(stream))
            self.assertEqual(self.phone.get(self.chatPath).json()["messages"], [])

        asyncio.run(scenario())

    def testDeletedChatIsNotRestored(self):
        async def scenario():
            stream = await self.startRegeneration()
            self.assertEqual(self.phone.delete(self.chatPath).status_code, 200)
            self.assertConflict(await self.finishRegeneration(stream))
            self.assertEqual(self.phone.get(self.chatPath).status_code, 404)

        asyncio.run(scenario())

    def testOnlyOneConcurrentRegenerationReplacesHistory(self):
        async def scenario():
            firstStream = await self.startRegeneration()
            secondStream = await self.startRegeneration()
            firstEvents = await self.finishRegeneration(firstStream)
            self.assertFalse(any(event["type"] == "error" for event in firstEvents))
            firstSaved = self.computer.get(self.chatPath).json()
            self.assertConflict(await self.finishRegeneration(secondStream))
            self.assertEqual(self.computer.get(self.chatPath).json(), firstSaved)

        asyncio.run(scenario())

    def testRegenerationSucceedsWithoutAConflict(self):
        events = asyncio.run(self.send(
            "replacement prompt", self.userId, self.original["chat"]["message_revision"]
        ))
        self.assertFalse(any(event["type"] == "error" for event in events))
        saved = self.computer.get(self.chatPath).json()
        self.assertEqual([row["content"] for row in saved["messages"]], [
            "replacement prompt", "answer to replacement prompt",
        ])
        self.assertGreater(saved["chat"]["message_revision"], self.original["chat"]["message_revision"])

    def testStaleBrowserIsRejectedBeforeGeneration(self):
        asyncio.run(self.send("phone followup"))
        latest = self.computer.get(self.chatPath).json()
        with patch("backend.chats.streamMessage.ModelStream", side_effect=AssertionError("Model forbidden")):
            response = self.computer.post(f"{self.chatPath}/messages/stream", json={
                "message": "stale replacement", "model": "test/model",
                "regenerate_message_id": self.userId,
                "chat_revision": self.original["chat"]["message_revision"],
            })
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "chat_revision_conflict")
        self.assertEqual(self.computer.get(self.chatPath).json(), latest)

    def testRenamingChatDoesNotCauseAConflict(self):
        async def scenario():
            stream = await self.startRegeneration()
            self.assertEqual(self.phone.patch(self.chatPath, json={"title": "Renamed"}).status_code, 200)
            events = await self.finishRegeneration(stream)
            self.assertFalse(any(event["type"] == "error" for event in events))
            self.assertEqual(self.phone.get(self.chatPath).json()["chat"]["title"], "Renamed")

        asyncio.run(scenario())

    def testLegacyClientStillDetectsChangesDuringRegeneration(self):
        async def scenario():
            response = await streamMessage(self.chatId, StreamMessageRequest(
                message="replacement prompt", model="test/model",
                regenerate_message_id=self.userId,
            ))
            await anext(response.body_iterator)
            await self.send("phone followup")
            latest = self.phone.get(self.chatPath).json()
            self.assertConflict(await self.finishRegeneration(response.body_iterator))
            self.assertEqual(self.phone.get(self.chatPath).json(), latest)

        asyncio.run(scenario())

    def testCancelledRegenerationLeavesHistoryUntouched(self):
        async def scenario():
            stream = await self.startRegeneration()
            startedSnapshot = self.computer.get(self.chatPath).json()
            await stream.aclose()
            self.assertEqual(self.computer.get(self.chatPath).json(), startedSnapshot)

        asyncio.run(scenario())

    def testRevisionMigrationPreservesExistingChatsAndIsRepeatable(self):
        with sqlite3.connect(":memory:") as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("CREATE TABLE chats (id TEXT PRIMARY KEY)")
            conn.execute("INSERT INTO chats (id) VALUES ('existing')")
            ensureChatRevisionColumn(conn)
            conn.execute("UPDATE chats SET message_revision = 7")
            ensureChatRevisionColumn(conn)
            row = conn.execute("SELECT * FROM chats").fetchone()
            self.assertEqual(dict(row), {"id": "existing", "message_revision": 7})
