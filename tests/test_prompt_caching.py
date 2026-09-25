import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import backend.main as main
import backend.tos.loadTos as loadTos
import backend.tos.tosAcceptance as tosAcceptance
import backend.providers.openrouter.usage as usage
import backend.core.paths as paths
from backend.local_access import create_secret_file


def acceptCurrentTos():
    tos = loadTos.load_tos()
    if not tos:
        raise RuntimeError("TOS.md is missing, restore it before running the tests")
    tosAcceptance.record_tos_acceptance(tos["hash"], tos["date"])


def fakeChatStream(content, usage=None):
    class FakeStreamResponse:
        status_code = 200
        headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def aiter_lines(self):
            yield f"data: {json.dumps({'choices': [{'delta': {'content': content}}]})}"
            if usage:
                yield f"data: {json.dumps({'choices': [], 'usage': usage})}"
            yield "data: [DONE]"

    return FakeStreamResponse()


def fakeClientFor(calls, usage=None):
    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        def stream(self, *_args, **kwargs):
            calls.append(kwargs.get("json") or {})
            return fakeChatStream("the reply", usage)

    return FakeClient


class PromptCachingTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = paths.DATA_DIR
        self.originalDbPath = paths.DB_PATH
        paths.DATA_DIR = Path(self.tempDir.name)
        paths.DB_PATH = paths.DATA_DIR / "routerchat-caching-test.sqlite3"
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

    def sendMessage(self, usage=None):
        chatResponse = self.client.post("/api/chats", json={"model": "test/model"})
        self.assertEqual(chatResponse.status_code, 200)
        chat = chatResponse.json()["chat"]

        calls = []
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.chats.streamMessage.httpx.AsyncClient", fakeClientFor(calls, usage)
        ):
            response = self.client.post(
                f"/api/chats/{chat['id']}/messages/stream",
                json={"message": "tell me about rome", "model": "test/model"},
            )
            response.read()

        self.assertEqual(response.status_code, 200)
        return chat, calls

    def test_the_setting_is_off_by_default_and_round_trips(self):
        self.assertFalse(self.client.get("/api/settings").json()["disable_prompt_caching"])

        patched = self.client.patch("/api/settings", json={"disable_prompt_caching": True})

        self.assertTrue(patched.json()["disable_prompt_caching"])
        self.assertTrue(self.client.get("/api/settings").json()["disable_prompt_caching"])

    def test_chat_requests_ask_for_caching_by_default(self):
        chat, calls = self.sendMessage()

        self.assertEqual(calls[0]["cache_control"], {"type": "ephemeral", "ttl": "1h"})
        self.assertEqual(calls[0]["session_id"], chat["id"])

    def test_the_hour_cache_is_on_by_default_and_round_trips(self):
        self.assertTrue(self.client.get("/api/settings").json()["hour_prompt_cache"])

        patched = self.client.patch("/api/settings", json={"hour_prompt_cache": False})

        self.assertFalse(patched.json()["hour_prompt_cache"])
        self.assertFalse(self.client.get("/api/settings").json()["hour_prompt_cache"])

    def test_chat_requests_use_the_short_cache_when_the_hour_cache_is_off(self):
        self.client.patch("/api/settings", json={"hour_prompt_cache": False})

        _, calls = self.sendMessage()

        self.assertEqual(calls[0]["cache_control"], {"type": "ephemeral"})

    def test_cached_reads_are_read_from_both_usage_shapes(self):
        streamUsage = main.normalize_usage({"prompt_tokens": 900, "prompt_tokens_details": {"cached_tokens": 700}})
        generationUsage = usage.normalize_generation_usage({"native_tokens_prompt": 900, "native_tokens_cached": 700})

        self.assertEqual(streamUsage["cached_tokens"], 700)
        self.assertEqual(generationUsage["cached_tokens"], 700)
        self.assertIsNone(main.normalize_usage({"prompt_tokens": 900})["cached_tokens"])

    def test_chat_replies_save_their_cached_reads(self):
        usage = {"prompt_tokens": 900, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 700}}

        chat, _ = self.sendMessage(usage)

        messages = self.client.get(f"/api/chats/{chat['id']}").json()["messages"]
        self.assertEqual(messages[-1]["cached_tokens"], 700)

    def test_chat_requests_skip_caching_when_disabled(self):
        self.client.patch("/api/settings", json={"disable_prompt_caching": True})

        _, calls = self.sendMessage()

        self.assertNotIn("cache_control", calls[0])
        self.assertNotIn("session_id", calls[0])


if __name__ == "__main__":
    unittest.main()
