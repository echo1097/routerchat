import json
import os
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


def fakeChatStream(content):
    class FakeStreamResponse:
        status_code = 200
        headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def aiter_lines(self):
            yield f"data: {json.dumps({'choices': [{'delta': {'content': content}}]})}"
            yield "data: [DONE]"

    return FakeStreamResponse()


def fakeClientFor(calls):
    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        def stream(self, *_args, **kwargs):
            calls.append(kwargs.get("json") or {})
            return fakeChatStream("the reply")

    return FakeClient


class PromptCachingTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = main.DATA_DIR
        self.originalDbPath = main.DB_PATH
        main.DATA_DIR = Path(self.tempDir.name)
        main.DB_PATH = main.DATA_DIR / "routerchat-caching-test.sqlite3"
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

    def sendMessage(self):
        chatResponse = self.client.post("/api/chats", json={"model": "test/model"})
        self.assertEqual(chatResponse.status_code, 200)
        chat = chatResponse.json()["chat"]

        calls = []
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.main.httpx.AsyncClient", fakeClientFor(calls)
        ):
            response = self.client.post(
                f"/api/chats/{chat['id']}/messages/stream",
                json={"message": "tell me about rome", "model": "test/model"},
            )
            response.read()

        self.assertEqual(response.status_code, 200)
        return calls

    def test_the_setting_is_off_by_default_and_round_trips(self):
        self.assertFalse(self.client.get("/api/settings").json()["disable_prompt_caching"])

        patched = self.client.patch("/api/settings", json={"disable_prompt_caching": True})

        self.assertTrue(patched.json()["disable_prompt_caching"])
        self.assertTrue(self.client.get("/api/settings").json()["disable_prompt_caching"])

    def test_chat_requests_ask_for_caching_by_default(self):
        calls = self.sendMessage()

        self.assertEqual(calls[0]["cache_control"], {"type": "ephemeral"})

    def test_chat_requests_skip_caching_when_disabled(self):
        self.client.patch("/api/settings", json={"disable_prompt_caching": True})

        calls = self.sendMessage()

        self.assertNotIn("cache_control", calls[0])


if __name__ == "__main__":
    unittest.main()
