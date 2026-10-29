import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import backend.main as main
import backend.tos.loadTos as loadTos
import backend.tos.tosAcceptance as tosAcceptance
import backend.core.paths as paths
from backend.local_access import createSecretFile


def acceptCurrentTos():
    tos = loadTos.loadTos()
    if not tos:
        raise RuntimeError("TOS.md is missing, restore it before running the tests")
    tosAcceptance.recordTosAcceptance(tos["hash"], tos["date"])


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


class ChatErrorTest(unittest.TestCase):
    def setUp(self):
        modelLookup = patch("backend.providers.openrouter.models.lookUpMissingModel", return_value=None)
        modelLookup.start()
        self.addCleanup(modelLookup.stop)
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = paths.DATA_DIR
        self.originalDbPath = paths.DB_PATH
        paths.DATA_DIR = Path(self.tempDir.name)
        paths.DB_PATH = paths.DATA_DIR / "routerchat-chat-errors-test.sqlite3"
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
