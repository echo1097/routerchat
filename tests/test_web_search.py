import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import backend.main as main
import backend.websearch as websearch
from backend.local_access import create_secret_file


def acceptCurrentTos():
    tos = main.load_tos()
    if not tos:
        raise RuntimeError("TOS.md is missing, restore it before running the tests")
    main.record_tos_acceptance(tos["hash"], tos["date"])


PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"


class WebSearchHarness:
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = main.DATA_DIR
        self.originalDbPath = main.DB_PATH
        main.DATA_DIR = Path(self.tempDir.name)
        main.DB_PATH = main.DATA_DIR / "routerchat-test.sqlite3"
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

    def createChat(self, **payload):
        response = self.client.post("/api/chats", json={"model": "test/model", **payload})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["chat"]

    def streamMessage(self, chatId, annotations=None, **payload):
        requestBody = {}
        streamedAnnotations = annotations

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                if streamedAnnotations:
                    yield (
                        "data: "
                        + json.dumps({"choices": [{"delta": {"annotations": streamedAnnotations}}]})
                    )
                yield f"data: {json.dumps({'choices': [{'delta': {'content': 'hello'}}]})}"
                yield "data: [DONE]"

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **kwargs):
                requestBody.update(kwargs.get("json") or {})
                return FakeResponse()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.main.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/chats/{chatId}/messages/stream",
                json={"message": "what happened today", "model": "test/model", **payload},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.lastStreamBody = response.text
        return requestBody


class WebSearchToggleTest(WebSearchHarness, unittest.TestCase):
    def test_web_search_off_sends_no_plugins(self):
        chat = self.createChat()
        body = self.streamMessage(chat["id"])
        self.assertNotIn("plugins", body)

    def test_web_search_on_sends_the_web_plugin(self):
        chat = self.createChat()
        body = self.streamMessage(chat["id"], web_search_enabled=True)
        self.assertEqual(
            body["plugins"],
            [{"id": "web", "max_results": main.WEB_SEARCH_MAX_RESULTS}],
        )

    def test_web_search_rides_alongside_the_pdf_parser(self):
        chat = self.createChat()
        upload = self.client.post(
            "/api/attachments",
            files=[("files", ("paper.pdf", PDF_BYTES, "application/pdf"))],
        )
        self.assertEqual(upload.status_code, 200, upload.text)
        attachmentId = upload.json()["attachments"][0]["id"]

        body = self.streamMessage(
            chat["id"],
            web_search_enabled=True,
            attachment_ids=[attachmentId],
        )
        pluginIds = [plugin["id"] for plugin in body["plugins"]]
        self.assertEqual(pluginIds, ["file-parser", "web"])

    def test_the_toggle_survives_reopening_the_chat(self):
        chat = self.createChat()
        self.assertFalse(chat["web_search_enabled"])

        self.streamMessage(chat["id"], web_search_enabled=True)
        reopened = self.client.get(f"/api/chats/{chat['id']}").json()["chat"]
        self.assertTrue(reopened["web_search_enabled"])

        self.streamMessage(chat["id"], web_search_enabled=False)
        reopened = self.client.get(f"/api/chats/{chat['id']}").json()["chat"]
        self.assertFalse(reopened["web_search_enabled"])

    def test_patching_the_chat_stores_the_toggle_as_an_integer(self):
        chat = self.createChat()
        patched = self.client.patch(
            f"/api/chats/{chat['id']}", json={"web_search_enabled": True}
        )
        self.assertEqual(patched.status_code, 200, patched.text)
        self.assertTrue(patched.json()["chat"]["web_search_enabled"])

        with main.get_db() as conn:
            stored = conn.execute(
                "SELECT web_search_enabled FROM chats WHERE id = ?", (chat["id"],)
            ).fetchone()
        self.assertEqual(stored["web_search_enabled"], 1)

    def test_an_older_database_gains_the_column(self):
        with main.get_db() as conn:
            conn.execute("ALTER TABLE chats DROP COLUMN web_search_enabled")
            columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(chats)").fetchall()
            }
            self.assertNotIn("web_search_enabled", columns)

            main.ensure_chat_settings_columns(conn)
            columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(chats)").fetchall()
            }

        self.assertIn("web_search_enabled", columns)
        chat = self.createChat()
        self.assertFalse(chat["web_search_enabled"])


CITATIONS = [
    {
        "type": "url_citation",
        "url_citation": {
            "url": "https://support.google.com/chrome/answer/1",
            "title": "Chrome help",
        },
    },
    {
        "type": "url_citation",
        "url_citation": {
            "url": "https://www.support.google.com/chrome/answer/2",
            "title": "More Chrome help",
        },
    },
    {
        "type": "url_citation",
        "url_citation": {"url": "https://en.wikipedia.org/wiki/Chrome", "title": "Chrome"},
    },
]


class SourceCaptureTest(WebSearchHarness, unittest.TestCase):
    def test_citations_reach_the_client_as_a_sources_event(self):
        chat = self.createChat()
        self.streamMessage(chat["id"], web_search_enabled=True, annotations=CITATIONS)

        events = [
            json.loads(line)
            for line in self.lastStreamBody.splitlines()
            if line.strip()
        ]
        sourceEvents = [event for event in events if event["type"] == "sources"]
        self.assertEqual(len(sourceEvents), 1)
        self.assertEqual(
            [source["domain"] for source in sourceEvents[0]["value"]],
            ["support.google.com", "support.google.com", "en.wikipedia.org"],
        )

    def test_sources_are_stored_on_the_message(self):
        chat = self.createChat()
        self.streamMessage(chat["id"], web_search_enabled=True, annotations=CITATIONS)

        messages = self.client.get(f"/api/chats/{chat['id']}").json()["messages"]
        assistant = [message for message in messages if message["role"] == "assistant"][-1]
        self.assertEqual(len(assistant["sources"]), 3)
        self.assertEqual(
            assistant["sources"][0]["url"],
            "https://support.google.com/chrome/answer/1",
        )
        self.assertEqual(assistant["sources"][0]["title"], "Chrome help")

    def test_a_reply_without_citations_stores_nothing(self):
        chat = self.createChat()
        self.streamMessage(chat["id"], web_search_enabled=True)

        messages = self.client.get(f"/api/chats/{chat['id']}").json()["messages"]
        assistant = [message for message in messages if message["role"] == "assistant"][-1]
        self.assertEqual(assistant["sources"], [])

    def test_an_older_database_gains_the_sources_column(self):
        with main.get_db() as conn:
            conn.execute("ALTER TABLE messages DROP COLUMN sources")
            main.ensure_message_source_column(conn)
            columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(messages)").fetchall()
            }
        self.assertIn("sources", columns)


class SourceNormalizationTest(unittest.TestCase):
    def test_it_keeps_only_usable_web_citations(self):
        normalized = websearch.normalize_sources(
            [
                {"url_citation": {"url": "https://example.com/a", "title": "A"}},
                {"url_citation": {"url": "ftp://example.com/b", "title": "B"}},
                {"url_citation": {"url": "", "title": "C"}},
                "not a dict",
                {"url": "https://www.example.org/d", "title": "D"},
            ]
        )
        self.assertEqual(
            [(source["domain"], source["title"]) for source in normalized],
            [("example.com", "A"), ("example.org", "D")],
        )

    def test_merging_drops_repeats_and_keeps_order(self):
        first = websearch.normalize_sources(
            [{"url_citation": {"url": "https://a.com/1", "title": "one"}}]
        )
        second = websearch.normalize_sources(
            [
                {"url_citation": {"url": "https://a.com/1", "title": "one again"}},
                {"url_citation": {"url": "https://b.com/2", "title": "two"}},
            ]
        )
        merged = websearch.merge_sources(first, second)
        self.assertEqual([source["url"] for source in merged], ["https://a.com/1", "https://b.com/2"])

    def test_a_broken_stored_value_reads_back_as_no_sources(self):
        self.assertEqual(websearch.deserialize_sources("{not json"), [])
        self.assertEqual(websearch.deserialize_sources(None), [])


class FaviconDomainTest(unittest.TestCase):
    def test_it_accepts_a_plain_hostname(self):
        self.assertEqual(websearch.safe_favicon_domain("Support.Google.com."), "support.google.com")

    def test_it_refuses_anything_that_could_reach_the_local_network(self):
        for hostile in [
            "localhost",
            "127.0.0.1",
            "0.0.0.0",
            "::1",
            "router.local",
            "vault.internal",
            "example.com/../secret",
            "example.com:8000",
            "user@example.com",
            "",
            "singlelabel",
        ]:
            with self.subTest(hostile=hostile):
                self.assertIsNone(websearch.safe_favicon_domain(hostile))


ICON_BYTES = b"\x00\x00\x01\x00fake icon"


def fakeFaviconClient(responses, calls):
    class FakeResponse:
        def __init__(self, payload):
            self.status_code = payload.get("status", 200)
            self.headers = payload.get("headers", {})
            self.content = payload.get("content", b"")
            self.text = payload.get("text", "")
            self.url = payload.get("url", "")

    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def get(self, url, **_kwargs):
            calls.append(url)
            if url not in responses:
                raise httpx.ConnectError("no route")
            return FakeResponse(responses[url])

    return FakeClient


class FaviconRouteTest(WebSearchHarness, unittest.TestCase):
    def fetchFavicon(self, domain, responses, calls):
        with patch(
            "backend.websearch.httpx.AsyncClient", fakeFaviconClient(responses, calls)
        ):
            return self.client.get(f"/api/favicon?domain={domain}")

    def test_it_serves_and_then_caches_a_site_icon(self):
        calls = []
        responses = {
            "https://example.com/favicon.ico": {
                "headers": {"content-type": "image/x-icon"},
                "content": ICON_BYTES,
            }
        }

        first = self.fetchFavicon("example.com", responses, calls)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.content, ICON_BYTES)
        self.assertEqual(first.headers["content-type"], "image/x-icon")

        second = self.fetchFavicon("example.com", responses, calls)
        self.assertEqual(second.content, ICON_BYTES)
        self.assertEqual(calls, ["https://example.com/favicon.ico"])

    def test_it_falls_back_to_the_icon_declared_in_the_page(self):
        calls = []
        responses = {
            "https://example.com/favicon.ico": {"status": 404, "headers": {}},
            "https://example.com/": {
                "headers": {"content-type": "text/html"},
                "text": '<html><head><link rel="apple-touch-icon" href="/icon.png"></head></html>',
                "url": "https://example.com/",
            },
            "https://example.com/icon.png": {
                "headers": {"content-type": "image/png"},
                "content": ICON_BYTES,
            },
        }

        response = self.fetchFavicon("example.com", responses, calls)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, ICON_BYTES)

    def test_a_site_with_no_icon_answers_empty_and_is_not_asked_twice(self):
        calls = []
        first = self.fetchFavicon("example.com", {}, calls)
        self.assertEqual(first.status_code, 204)

        second = self.fetchFavicon("example.com", {}, calls)
        self.assertEqual(second.status_code, 204)
        self.assertEqual(len(calls), 2)

    def test_it_refuses_a_non_image_answer(self):
        calls = []
        responses = {
            "https://example.com/favicon.ico": {
                "headers": {"content-type": "application/json"},
                "content": b'{"token": "secret"}',
            },
            "https://example.com/": {"status": 500, "headers": {}},
        }
        response = self.fetchFavicon("example.com", responses, calls)
        self.assertEqual(response.status_code, 204)

    def test_it_refuses_an_oversized_image(self):
        calls = []
        responses = {
            "https://example.com/favicon.ico": {
                "headers": {"content-type": "image/png"},
                "content": b"x" * (websearch.FAVICON_MAX_BYTES + 1),
            },
            "https://example.com/": {"status": 500, "headers": {}},
        }
        response = self.fetchFavicon("example.com", responses, calls)
        self.assertEqual(response.status_code, 204)

    def test_it_rejects_a_local_target_without_making_a_request(self):
        calls = []
        response = self.fetchFavicon("127.0.0.1", {}, calls)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
