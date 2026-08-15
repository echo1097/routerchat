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


class FakeTitleResponse:
    def __init__(self, content, status_code=200):
        self.status_code = status_code
        self._content = content

    def json(self):
        if self._content is None:
            raise json.JSONDecodeError("no body", "", 0)
        return {"choices": [{"message": {"content": self._content}}]}


def fakeClientFor(titleResponse, calls):
    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        def stream(self, *_args, **kwargs):
            return fakeChatStream("the reply")

        async def post(self, *_args, **kwargs):
            calls.append(kwargs.get("json") or {})
            return titleResponse

    return FakeClient


class ChatTitleTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = main.DATA_DIR
        self.originalDbPath = main.DB_PATH
        main.DATA_DIR = Path(self.tempDir.name)
        main.DB_PATH = main.DATA_DIR / "routerchat-title-test.sqlite3"
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

    def createChat(self):
        response = self.client.post("/api/chats", json={"model": "test/model"})
        self.assertEqual(response.status_code, 200)
        return response.json()["chat"]

    def sendFirstMessage(self, chat, message="how do I fix this borrow checker error"):
        calls = []
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.main.httpx.AsyncClient", fakeClientFor(FakeTitleResponse("Ignored"), calls)
        ):
            response = self.client.post(
                f"/api/chats/{chat['id']}/messages/stream",
                json={"message": message, "model": "test/model"},
            )
            response.read()
        self.assertEqual(response.status_code, 200)
        return calls

    def nameChat(self, chat, titleResponse):
        calls = []
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.main.httpx.AsyncClient", fakeClientFor(titleResponse, calls)
        ):
            response = self.client.post(f"/api/chats/{chat['id']}/title")
        return response, calls

    def test_titles_still_come_from_the_first_message_when_the_setting_is_off(self):
        chat = self.createChat()
        self.sendFirstMessage(chat)

        stored = self.client.get(f"/api/chats/{chat['id']}").json()["chat"]
        self.assertEqual(stored["title"], "how do I fix this borrow")

    def test_the_placeholder_survives_the_run_when_the_setting_is_on(self):
        self.client.patch("/api/settings", json={"generate_chat_name": True})
        chat = self.createChat()
        self.sendFirstMessage(chat)

        stored = self.client.get(f"/api/chats/{chat['id']}").json()["chat"]
        self.assertEqual(stored["title"], "New chat")

    def test_the_naming_route_stores_the_model_title(self):
        self.client.patch("/api/settings", json={"generate_chat_name": True})
        chat = self.createChat()
        self.sendFirstMessage(chat)

        response, calls = self.nameChat(chat, FakeTitleResponse('"borrow checker lifetime fix"'))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["chat"]["title"], "Borrow Checker Lifetime Fix")
        self.assertEqual(len(calls), 1)
        self.assertIn("how do I fix this borrow checker error", calls[0]["messages"][0]["content"])
        self.assertFalse(calls[0]["stream"])

    def test_a_longer_reply_is_kept_rather_than_cut_to_a_word_count(self):
        self.client.patch("/api/settings", json={"generate_chat_name": True})
        chat = self.createChat()
        self.sendFirstMessage(chat)

        response, _ = self.nameChat(chat, FakeTitleResponse("Rust Borrow Checker Lifetime Error Help"))

        self.assertEqual(response.json()["chat"]["title"], "Rust Borrow Checker Lifetime Error Help")

    def test_a_failed_naming_call_falls_back_to_the_first_message_title(self):
        self.client.patch("/api/settings", json={"generate_chat_name": True})
        chat = self.createChat()
        self.sendFirstMessage(chat)

        response, _ = self.nameChat(chat, FakeTitleResponse(None, status_code=500))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["chat"]["title"], "how do I fix this borrow")

    def test_an_empty_reply_falls_back_to_the_first_message_title(self):
        self.client.patch("/api/settings", json={"generate_chat_name": True})
        chat = self.createChat()
        self.sendFirstMessage(chat)

        response, _ = self.nameChat(chat, FakeTitleResponse("   \n  "))

        self.assertEqual(response.json()["chat"]["title"], "how do I fix this borrow")

    def test_naming_leaves_a_chat_that_already_has_a_title_alone(self):
        self.client.patch("/api/settings", json={"generate_chat_name": True})
        chat = self.createChat()
        self.sendFirstMessage(chat)
        self.client.patch(f"/api/chats/{chat['id']}", json={"title": "Named By Hand"})

        response, calls = self.nameChat(chat, FakeTitleResponse("Something Else Entirely"))

        self.assertEqual(response.json()["chat"]["title"], "Named By Hand")
        self.assertEqual(calls, [])

    def test_naming_a_missing_chat_is_a_404(self):
        response, _ = self.nameChat({"id": "nope"}, FakeTitleResponse("Any Title Here"))
        self.assertEqual(response.status_code, 404)

    def test_the_naming_call_turns_reasoning_off_for_a_model_that_allows_it(self):
        self.client.patch("/api/settings", json={"generate_chat_name": True})
        chat = self.createChat()
        self.sendFirstMessage(chat)

        with patch.object(main, "model_metadata", lambda _: {"supported_parameters": ["reasoning"]}):
            _, calls = self.nameChat(chat, FakeTitleResponse("Borrow Checker Help"))

        self.assertEqual(calls[0]["reasoning"], {"enabled": False, "exclude": True})
        self.assertEqual(calls[0]["reasoning_effort"], "none")
        self.assertFalse(calls[0]["include_reasoning"])

    def test_the_naming_call_keeps_reasoning_for_a_model_that_requires_it(self):
        self.client.patch("/api/settings", json={"generate_chat_name": True})
        chat = self.createChat()
        self.sendFirstMessage(chat)

        metadata = {"supported_parameters": ["reasoning"], "reasoning": {"mandatory": True}}
        with patch.object(main, "model_metadata", lambda _: metadata):
            _, calls = self.nameChat(chat, FakeTitleResponse("Borrow Checker Help"))

        self.assertTrue(calls[0]["reasoning"]["enabled"])

    def test_the_naming_call_carries_the_privacy_provider_options(self):
        self.client.patch("/api/settings", json={"generate_chat_name": True, "zdr_mode": True})
        chat = self.createChat()
        self.sendFirstMessage(chat)

        _, calls = self.nameChat(chat, FakeTitleResponse("Borrow Checker Help"))

        self.assertEqual(calls[0]["provider"]["zdr"], True)
        self.assertEqual(calls[0]["provider"]["data_collection"], "deny")

    def test_the_setting_round_trips(self):
        self.assertFalse(self.client.get("/api/settings").json()["generate_chat_name"])
        patched = self.client.patch("/api/settings", json={"generate_chat_name": True})
        self.assertTrue(patched.json()["generate_chat_name"])
        self.assertTrue(self.client.get("/api/settings").json()["generate_chat_name"])


class ChatTitleSanitizerTest(unittest.TestCase):
    def test_quotes_and_trailing_punctuation_come_off(self):
        self.assertEqual(
            main.chat_title_from_model_output('"Weekend Pasta Recipe."'),
            "Weekend Pasta Recipe",
        )

    def test_a_preamble_line_is_dropped_in_favor_of_the_name(self):
        self.assertEqual(
            main.chat_title_from_model_output("Sure! Here you go:\nTax Deduction Questions"),
            "Tax Deduction Questions",
        )

    def test_a_label_prefix_is_stripped(self):
        self.assertEqual(
            main.chat_title_from_model_output("Title: Budget Planning Ideas"),
            "Budget Planning Ideas",
        )

    def test_lowercase_output_is_title_cased(self):
        self.assertEqual(
            main.chat_title_from_model_output("weekend pasta recipe"),
            "Weekend Pasta Recipe",
        )

    def test_an_acronym_keeps_its_own_casing(self):
        self.assertEqual(
            main.chat_title_from_model_output("SQL Query Optimization"),
            "SQL Query Optimization",
        )

    def test_a_very_long_name_is_trimmed_on_a_word_boundary(self):
        raw = "Extremely Detailed Conversation About Distributed Database Replication"
        title = main.chat_title_from_model_output(raw)
        self.assertLessEqual(len(title), main.CHAT_TITLE_MAX_LENGTH)
        self.assertFalse(title.endswith(" "))
        self.assertTrue(raw.startswith(title))

    def test_empty_output_has_no_title(self):
        self.assertIsNone(main.chat_title_from_model_output(""))
        self.assertIsNone(main.chat_title_from_model_output(None))
        self.assertIsNone(main.chat_title_from_model_output("  \n  "))


if __name__ == "__main__":
    unittest.main()
