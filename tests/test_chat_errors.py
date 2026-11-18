import json
import os
import unittest
from unittest.mock import patch

import httpx
from tests.localApiHarness import LocalApiHarness



def fakeClient(statusCode=200, lines=(), body="", failure=None):
    class FakeStreamResponse:
        status_code = statusCode
        headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def aread(self):
            return body.encode("utf-8")

        async def aiter_lines(self):
            for line in lines:
                yield line
            if failure:
                raise failure

    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        def stream(self, *_args, **_kwargs):
            return FakeStreamResponse()

    return FakeClient


class ChatErrorTest(LocalApiHarness, unittest.TestCase):
    databaseFile = "routerchat-chat-errors-test.sqlite3"

    def sendWith(self, client):
        chat = self.client.post("/api/chats", json={"model": "test/model"}).json()["chat"]

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.providers.streaming.httpx.AsyncClient", client
        ):
            response = self.client.post(
                f"/api/chats/{chat['id']}/messages/stream",
                json={"message": "tell me about rome", "model": "test/model"},
            )
            response.read()

        events = [json.loads(line) for line in response.text.splitlines() if line]
        messages = self.client.get(f"/api/chats/{chat['id']}").json()["messages"]
        return events, messages[-1]

    def test_a_provider_error_is_sent_with_a_kind_title_and_message(self):
        body = json.dumps({"error": {"message": "Insufficient credits"}})
        events, _ = self.sendWith(fakeClient(402, body=body))

        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(events[-1]["value"]["kind"], "noCredit")
        self.assertEqual(events[-1]["value"]["title"], "Out of OpenRouter credit")
        self.assertIn("Add credit", events[-1]["value"]["message"])

    def test_the_error_is_saved_apart_from_the_reply_text(self):
        body = json.dumps({"error": {"message": "Insufficient credits"}})
        _, saved = self.sendWith(fakeClient(402, body=body))

        self.assertEqual(saved["role"], "assistant")
        self.assertEqual(saved["content"], "")
        self.assertEqual(json.loads(saved["error"])["kind"], "noCredit")

    def test_text_received_before_a_drop_is_kept(self):
        lines = [f"data: {json.dumps({'choices': [{'delta': {'content': 'Rome was'}}]})}"]
        events, saved = self.sendWith(
            fakeClient(lines=lines, failure=httpx.RemoteProtocolError("peer closed connection"))
        )

        self.assertEqual(events[-1]["value"]["kind"], "network")
        self.assertEqual(saved["content"], "Rome was")
        self.assertEqual(json.loads(saved["error"])["kind"], "network")

    def test_unexpected_crashes_hide_the_exception_text(self):
        with patch(
            "backend.chats.streamMessage.ModelStream.fetchFinalUsage",
            side_effect=RuntimeError("secret internal detail"),
        ), self.assertLogs("uvicorn.error", level="ERROR"):
            lines = [
                f"data: {json.dumps({'choices': [{'delta': {'content': 'hi'}, 'finish_reason': 'stop'}]})}",
                "data: [DONE]",
            ]
            events, saved = self.sendWith(fakeClient(lines=lines))

        self.assertEqual(events[-1]["value"]["kind"], "unknown")
        self.assertNotIn("secret internal detail", json.dumps(events))
        self.assertNotIn("secret internal detail", saved["content"])


if __name__ == "__main__":
    unittest.main()
