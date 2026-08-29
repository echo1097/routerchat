import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import backend.attachments as attachments
import backend.main as main
from backend.local_access import create_secret_file


def acceptCurrentTos():
    tos = main.load_tos()
    if not tos:
        raise RuntimeError("TOS.md is missing, restore it before running the tests")
    main.record_tos_acceptance(tos["hash"], tos["date"])


PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100ffff03000006000557bfabd400"
    "00000049454e44ae426082"
)


class AttachmentApiTest(unittest.TestCase):
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

    def upload(self, files):
        return self.client.post("/api/attachments", files=files)

    def uploadText(self, filename="notes.md", body=b"# Heading\n\nSome prose."):
        response = self.upload([("files", (filename, body, "text/markdown"))])
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["attachments"][0]

    def uploadImage(self, filename="shot.png"):
        response = self.upload([("files", (filename, PNG_BYTES, "image/png"))])
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["attachments"][0]

    def createChat(self, **payload):
        response = self.client.post("/api/chats", json={"model": "test/model", **payload})
        self.assertEqual(response.status_code, 200)
        return response.json()["chat"]

    def test_upload_stores_the_file_and_reports_its_kind(self):
        attachment = self.uploadText()

        self.assertEqual(attachment["filename"], "notes.md")
        self.assertEqual(attachment["kind"], "text")
        self.assertEqual(attachment["mime"], "text/markdown")
        self.assertGreater(attachment["size_bytes"], 0)

        stored = list((main.DATA_DIR / "attachments").iterdir())
        self.assertEqual(len(stored), 1)

    def test_upload_rejects_an_unsupported_file_type(self):
        response = self.upload([("files", ("archive.zip", b"PK\x03\x04", "application/zip"))])

        self.assertEqual(response.status_code, 400)
        self.assertIn("not a supported file type", response.json()["detail"])
        self.assertEqual(list((main.DATA_DIR / "attachments").iterdir()), [])

    def test_upload_rejects_an_oversized_file(self):
        oversized = b"x" * (attachments.MAX_TEXT_BYTES + 1)
        response = self.upload([("files", ("big.txt", oversized, "text/plain"))])

        self.assertEqual(response.status_code, 400)
        self.assertIn("larger than", response.json()["detail"])

    def test_upload_rejects_more_files_than_the_limit(self):
        payload = [
            ("files", (f"note{index}.txt", b"body", "text/plain"))
            for index in range(attachments.MAX_FILES_PER_MESSAGE + 1)
        ]
        response = self.upload(payload)

        self.assertEqual(response.status_code, 400)
        self.assertIn("at most", response.json()["detail"])

    def test_a_rejected_file_in_a_batch_leaves_nothing_behind(self):
        response = self.upload([
            ("files", ("good.txt", b"body", "text/plain")),
            ("files", ("bad.zip", b"PK\x03\x04", "application/zip")),
        ])

        self.assertEqual(response.status_code, 400)
        stored = main.DATA_DIR / "attachments"
        self.assertEqual(list(stored.iterdir()) if stored.exists() else [], [])

        with main.get_db() as conn:
            rows = conn.execute("SELECT COUNT(*) AS total FROM attachments").fetchone()
        self.assertEqual(rows["total"], 0)

    def test_raw_route_serves_the_original_bytes(self):
        attachment = self.uploadImage()

        response = self.client.get(f"/api/attachments/{attachment['id']}/raw")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertEqual(response.content, PNG_BYTES)

    def test_raw_route_survives_a_filename_the_http_header_cannot_hold(self):
        screenshotName = "Screenshot 2026-08-29 at 1.06.01\u202fPM.png"
        attachment = self.uploadImage(screenshotName)

        response = self.client.get(f"/api/attachments/{attachment['id']}/raw")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, PNG_BYTES)

        disposition = response.headers["content-disposition"]
        disposition.encode("latin-1")
        self.assertIn('filename="Screenshot 2026-08-29 at 1.06.01 PM.png"', disposition)
        self.assertIn("filename*=UTF-8''", disposition)
        self.assertIn("%E2%80%AF", disposition)

    def test_content_disposition_is_always_latin_1_encodable(self):
        for filename in [
            "Screenshot 2026-08-29 at 1.06.01\u202fPM.png",
            "r\u00e9sum\u00e9 notes.pdf",
            "\u6f22\u5b57.png",
            'quote"and\\\\slash.txt',
            "plain.md",
        ]:
            header = attachments.content_disposition(filename)
            header.encode("latin-1")
            self.assertIn('filename="', header)
            self.assertNotIn('filename=""', header)

    def test_delete_removes_the_row_and_the_file(self):
        attachment = self.uploadText()

        response = self.client.delete(f"/api/attachments/{attachment['id']}")
        self.assertEqual(response.status_code, 200)

        with main.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM attachments WHERE id = ?", (attachment["id"],)
            ).fetchone()
        self.assertIsNone(row)
        self.assertEqual(list((main.DATA_DIR / "attachments").iterdir()), [])

    def test_text_attachment_becomes_a_fenced_text_part(self):
        attachment = self.uploadText("script.py", b"print('hello')\n")

        with main.get_db() as conn:
            parts = attachments.attachment_content_parts(conn, [attachment["id"]])

        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0]["type"], "text")
        self.assertIn("script.py", parts[0]["text"])
        self.assertIn("```python", parts[0]["text"])
        self.assertIn("print('hello')", parts[0]["text"])

    def test_image_attachment_becomes_a_data_url_image_part(self):
        attachment = self.uploadImage()

        with main.get_db() as conn:
            parts = attachments.attachment_content_parts(conn, [attachment["id"]])

        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0]["type"], "image_url")
        self.assertTrue(parts[0]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_a_long_text_attachment_is_truncated_with_a_note(self):
        body = ("line\n" * 26000).encode("utf-8")
        attachment = self.uploadText("long.txt", body)

        with main.get_db() as conn:
            parts = attachments.attachment_content_parts(conn, [attachment["id"]])

        self.assertIn("truncated", parts[0]["text"])
        self.assertLess(len(parts[0]["text"]), len(body.decode("utf-8")))

    def test_content_parts_keep_the_order_they_were_asked_for(self):
        first = self.uploadText("a.txt", b"first")
        second = self.uploadText("b.txt", b"second")

        with main.get_db() as conn:
            parts = attachments.attachment_content_parts(
                conn, [second["id"], first["id"]]
            )

        self.assertIn("b.txt", parts[0]["text"])
        self.assertIn("a.txt", parts[1]["text"])

    def test_a_missing_attachment_id_is_skipped_rather_than_raising(self):
        attachment = self.uploadText()

        with main.get_db() as conn:
            parts = attachments.attachment_content_parts(
                conn, [attachment["id"], "not-a-real-id"]
            )

        self.assertEqual(len(parts), 1)

    def test_user_content_stays_a_plain_string_without_attachments(self):
        with main.get_db() as conn:
            content = attachments.user_content_with_attachments(conn, [], "hello")

        self.assertEqual(content, "hello")

    def test_user_content_puts_the_prompt_after_the_files(self):
        attachment = self.uploadText()

        with main.get_db() as conn:
            content = attachments.user_content_with_attachments(
                conn, [attachment["id"]], "what is this"
            )

        self.assertIsInstance(content, list)
        self.assertEqual(content[-1], {"type": "text", "text": "what is this"})

    def test_user_content_omits_an_empty_prompt(self):
        attachment = self.uploadText()

        with main.get_db() as conn:
            content = attachments.user_content_with_attachments(
                conn, [attachment["id"]], "   "
            )

        self.assertEqual(len(content), 1)
        self.assertEqual(content[0]["type"], "text")

    def test_a_sent_message_claims_its_attachments_and_reports_them_back(self):
        chat = self.createChat()
        attachment = self.uploadImage()

        with main.get_db() as conn:
            main.claim_attachments(
                conn,
                [attachment["id"]],
                chat_id=chat["id"],
                message_id="message-1",
            )
            conn.execute(
                """
                INSERT INTO messages (
                  id, chat_id, role, content, reasoning, model, finish_reason,
                  error, message_order, created_at
                )
                VALUES ('message-1', ?, 'user', 'look at this', NULL, ?, NULL, NULL, 0, ?)
                """,
                (chat["id"], "test/model", main.utc_now()),
            )

        payload = self.client.get(f"/api/chats/{chat['id']}").json()
        message = payload["messages"][0]

        self.assertEqual(len(message["attachments"]), 1)
        self.assertEqual(message["attachments"][0]["id"], attachment["id"])

    def test_history_resends_the_attachment_on_later_turns(self):
        chat = self.createChat()
        attachment = self.uploadImage()

        with main.get_db() as conn:
            main.claim_attachments(
                conn,
                [attachment["id"]],
                chat_id=chat["id"],
                message_id="message-1",
            )
            for index, (messageId, role, content) in enumerate([
                ("message-1", "user", "look at this"),
                ("message-2", "assistant", "a tiny image"),
                ("message-3", "user", "and now"),
            ]):
                conn.execute(
                    """
                    INSERT INTO messages (
                      id, chat_id, role, content, reasoning, model, finish_reason,
                      error, message_order, created_at
                    )
                    VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)
                    """,
                    (messageId, chat["id"], role, content, "test/model", index, main.utc_now()),
                )

        messages = main.build_openrouter_messages(chat["id"], "")

        self.assertEqual(len(messages), 3)
        self.assertIsInstance(messages[0]["content"], list)
        self.assertEqual(messages[0]["content"][0]["type"], "image_url")
        self.assertEqual(messages[1]["content"], "a tiny image")
        self.assertEqual(messages[2]["content"], "and now")

    def test_deleting_a_chat_removes_its_attachment_files(self):
        chat = self.createChat()
        attachment = self.uploadText()

        with main.get_db() as conn:
            main.claim_attachments(
                conn,
                [attachment["id"]],
                chat_id=chat["id"],
                message_id="message-1",
            )

        self.client.delete(f"/api/chats/{chat['id']}")

        with main.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM attachments WHERE id = ?", (attachment["id"],)
            ).fetchone()
        self.assertIsNone(row)
        self.assertEqual(list((main.DATA_DIR / "attachments").iterdir()), [])

    def test_deleting_a_user_message_removes_its_attachment_files(self):
        chat = self.createChat()
        kept = self.uploadText("kept.txt")
        dropped = self.uploadText("dropped.txt")

        with main.get_db() as conn:
            for index, (messageId, role, attachmentId) in enumerate([
                ("message-1", "user", kept["id"]),
                ("message-2", "assistant", None),
                ("message-3", "user", dropped["id"]),
            ]):
                conn.execute(
                    """
                    INSERT INTO messages (
                      id, chat_id, role, content, reasoning, model, finish_reason,
                      error, message_order, created_at
                    )
                    VALUES (?, ?, ?, 'body', NULL, ?, NULL, NULL, ?, ?)
                    """,
                    (messageId, chat["id"], role, "test/model", index, main.utc_now()),
                )
                if attachmentId:
                    main.claim_attachments(
                        conn, [attachmentId], chat_id=chat["id"], message_id=messageId
                    )

        response = self.client.delete(f"/api/chats/{chat['id']}/messages/message-3")
        self.assertEqual(response.status_code, 200, response.text)

        with main.get_db() as conn:
            remaining = {
                row["id"] for row in conn.execute("SELECT id FROM attachments").fetchall()
            }

        self.assertEqual(remaining, {kept["id"]})
        self.assertEqual(len(list((main.DATA_DIR / "attachments").iterdir())), 1)

    def test_deleting_a_folder_with_its_chats_removes_attachment_files(self):
        folder = self.client.post("/api/folders", json={"name": "Work"}).json()["folder"]
        chat = self.createChat(folder_id=folder["id"])
        attachment = self.uploadText()

        with main.get_db() as conn:
            main.claim_attachments(
                conn, [attachment["id"]], chat_id=chat["id"], message_id="message-1"
            )

        response = self.client.delete(
            f"/api/folders/{folder['id']}?delete_chats=true"
        )
        self.assertEqual(response.status_code, 200, response.text)

        with main.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM attachments WHERE id = ?", (attachment["id"],)
            ).fetchone()

        self.assertIsNone(row)
        self.assertEqual(list((main.DATA_DIR / "attachments").iterdir()), [])

    def test_the_orphan_sweep_only_takes_unclaimed_and_stale_uploads(self):
        claimed = self.uploadText("claimed.txt")
        staleOrphan = self.uploadText("stale.txt")
        freshOrphan = self.uploadText("fresh.txt")

        with main.get_db() as conn:
            main.claim_attachments(conn, [claimed["id"]], story_id="story-1")
            conn.execute(
                "UPDATE attachments SET created_at = ? WHERE id = ?",
                ("2020-01-01T00:00:00Z", staleOrphan["id"]),
            )
            removed = attachments.delete_orphaned_attachments(conn)
            remaining = {
                row["id"] for row in conn.execute("SELECT id FROM attachments").fetchall()
            }

        self.assertEqual(removed, 1)
        self.assertEqual(remaining, {claimed["id"], freshOrphan["id"]})

    def test_pdf_plugin_is_only_requested_when_a_pdf_is_attached(self):
        chat = self.createChat()
        textAttachment = self.uploadText()

        with main.get_db() as conn:
            main.claim_attachments(
                conn,
                [textAttachment["id"]],
                chat_id=chat["id"],
                message_id="message-1",
            )
            self.assertFalse(main.chat_has_pdf_attachment(conn, chat["id"]))

        pdfResponse = self.upload([("files", ("paper.pdf", b"%PDF-1.4 fake", "application/pdf"))])
        self.assertEqual(pdfResponse.status_code, 200)
        pdfAttachment = pdfResponse.json()["attachments"][0]
        self.assertEqual(pdfAttachment["kind"], "pdf")

        with main.get_db() as conn:
            main.claim_attachments(
                conn,
                [pdfAttachment["id"]],
                chat_id=chat["id"],
                message_id="message-2",
            )
            self.assertTrue(main.chat_has_pdf_attachment(conn, chat["id"]))
            parts = attachments.attachment_content_parts(conn, [pdfAttachment["id"]])

        self.assertEqual(parts[0]["type"], "file")
        self.assertEqual(parts[0]["file"]["filename"], "paper.pdf")
        self.assertEqual(
            main.pdf_parser_plugins(),
            [{"id": "file-parser", "pdf": {"engine": "pdf-text"}}],
        )

    def test_a_filename_cannot_escape_the_attachments_directory(self):
        response = self.upload([
            ("files", ("../../escape.txt", b"body", "text/plain")),
        ])

        self.assertEqual(response.status_code, 200, response.text)
        attachment = response.json()["attachments"][0]
        self.assertEqual(attachment["filename"], "escape.txt")

        with main.get_db() as conn:
            row = conn.execute(
                "SELECT stored_path FROM attachments WHERE id = ?", (attachment["id"],)
            ).fetchone()

        storedPath = Path(row["stored_path"]).resolve()
        self.assertEqual(storedPath.parent, (main.DATA_DIR / "attachments").resolve())


class AttachmentLimitParityTest(unittest.TestCase):
    def frontendConstants(self):
        source = (
            Path(__file__).resolve().parents[1]
            / "frontend/src/attachments/attachmentsApi.js"
        ).read_text(encoding="utf-8")

        values = {}
        for name in ("MAX_FILES_PER_MESSAGE", "MAX_IMAGE_BYTES", "MAX_PDF_BYTES", "MAX_TEXT_BYTES"):
            match = re.search(rf"export const {name} = ([^;]+);", source)
            self.assertIsNotNone(match, f"{name} is missing from attachmentsApi.js")
            values[name] = eval(match.group(1).replace(" ", ""))

        extensions = {}
        for name in ("IMAGE_EXTENSIONS", "PDF_EXTENSIONS", "TEXT_EXTENSIONS"):
            match = re.search(rf"export const {name} = \[(.*?)\];", source, re.DOTALL)
            self.assertIsNotNone(match, f"{name} is missing from attachmentsApi.js")
            extensions[name] = sorted(re.findall(r'"(\.[a-z0-9]+)"', match.group(1)))

        return values, extensions

    def test_size_limits_match_the_backend(self):
        values, _ = self.frontendConstants()

        self.assertEqual(values["MAX_FILES_PER_MESSAGE"], attachments.MAX_FILES_PER_MESSAGE)
        self.assertEqual(values["MAX_IMAGE_BYTES"], attachments.MAX_IMAGE_BYTES)
        self.assertEqual(values["MAX_PDF_BYTES"], attachments.MAX_PDF_BYTES)
        self.assertEqual(values["MAX_TEXT_BYTES"], attachments.MAX_TEXT_BYTES)

    def test_accepted_extensions_match_the_backend(self):
        _, extensions = self.frontendConstants()

        self.assertEqual(extensions["IMAGE_EXTENSIONS"], sorted(attachments.IMAGE_TYPES))
        self.assertEqual(extensions["PDF_EXTENSIONS"], sorted(attachments.PDF_TYPES))
        self.assertEqual(extensions["TEXT_EXTENSIONS"], sorted(attachments.TEXT_TYPES))


if __name__ == "__main__":
    unittest.main()
