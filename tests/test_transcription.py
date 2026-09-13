import base64
from contextlib import closing
import unittest
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.transcription import createTranscriptionRouter, ensureTranscriptionUsageTable


class TranscriptionTest(unittest.TestCase):
    def setUp(self):
        self.settings = {"transcription_model": "test/transcribe"}
        self.tempDir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempDir.cleanup)
        self.dbPath = Path(self.tempDir.name) / "usage.sqlite3"
        with closing(self.getDb()) as conn, conn:
            ensureTranscriptionUsageTable(conn)
        app = FastAPI()
        app.include_router(createTranscriptionRouter(
            lambda: "test-key", self.settings.get, self.settings.__setitem__,
            lambda key: {"Authorization": f"Bearer {key}"}, "https://example.invalid",
            self.getDb, lambda: "2026-09-09T12:00:00Z",
        ))
        self.client = TestClient(app)
        self.provider = AsyncMock()
        self.provider.__aenter__.return_value = self.provider
        self.provider.request.return_value = httpx.Response(200, json={"text": "  Hello world  "})
        self.clientPatch = patch("backend.transcription.httpx.AsyncClient", return_value=self.provider)
        self.clientPatch.start()
        self.addCleanup(self.clientPatch.stop)
        self.addCleanup(self.client.close)
        self.payload = {"audio": base64.b64encode(b"recorded audio").decode(), "format": "webm"}

    def testSelectedModelAndTranscript(self):
        response = self.client.post("/api/transcription", json=self.payload)
        self.assertEqual(response.json(), {"text": "Hello world"})
        sent = self.provider.request.call_args.kwargs
        self.assertEqual(sent["data"]["model"], "test/transcribe")
        self.assertEqual(sent["files"]["file"], ("recording.webm", b"recorded audio", "audio/webm"))
        self.assertNotIn("json", sent)

    def testRejectInvalidAudioWithoutProviderCall(self):
        response = self.client.post("/api/transcription", json={**self.payload, "audio": "not base64!"})
        self.assertEqual(response.status_code, 400)
        self.provider.request.assert_not_called()

    def testRejectUnsupportedFormat(self):
        response = self.client.post("/api/transcription", json={**self.payload, "format": "exe"})
        self.assertEqual(response.status_code, 422)
        self.provider.request.assert_not_called()

    def testPrivacyDoesNotSilentlySendAudio(self):
        for setting in ["privacy_mode", "zdr_mode"]:
            self.settings[setting] = True
            self.assertEqual(self.client.post("/api/transcription", json=self.payload).status_code, 400)
            self.settings[setting] = False
        self.provider.request.assert_not_called()

    def testEmptyTranscript(self):
        self.provider.request.return_value = httpx.Response(200, json={"text": " "})
        self.assertEqual(self.client.post("/api/transcription", json=self.payload).status_code, 422)

    def testProviderFailure(self):
        self.provider.request.return_value = httpx.Response(429)
        self.assertEqual(self.client.post("/api/transcription", json=self.payload).status_code, 429)

    def testModelDiscoveryUsesTranscriptionCatalog(self):
        self.provider.request.return_value = httpx.Response(200, json={"data": [{"id": "test/stt"}]})
        self.assertEqual(self.client.get("/api/transcription/models").json(), {"models": [{"id": "test/stt"}]})
        self.assertEqual(self.provider.request.call_args.kwargs["params"], {"output_modalities": "transcription"})
        self.assertEqual(self.settings["transcription_models"], [{"id": "test/stt"}])
        self.provider.request.assert_awaited_once()
        self.provider.get.assert_not_called()

    def getDb(self):
        conn = sqlite3.connect(self.dbPath)
        conn.row_factory = sqlite3.Row
        return conn

    def testReportedCostAndTokensAreSavedForTheSelectedModel(self):
        self.provider.request.return_value = httpx.Response(200, json={
            "text": "Hello", "usage": {"input_tokens": 100, "output_tokens": 20, "cost": 0.003, "seconds": 12},
        })
        self.assertEqual(self.client.post("/api/transcription", json=self.payload).status_code, 200)
        with closing(self.getDb()) as conn, conn:
            row = conn.execute("SELECT * FROM transcription_usage").fetchone()
        self.assertEqual(row["model"], "test/transcribe")
        self.assertEqual(row["cost"], 0.003)
        self.assertEqual(row["prompt_tokens"], 100)
        self.assertEqual(row["completion_tokens"], 20)
        self.assertEqual(row["total_tokens"], 120)
        self.assertEqual(row["audio_seconds"], 12)

    def testDurationPricedAndEmptyTranscriptsKeepTheirCost(self):
        self.provider.request.return_value = httpx.Response(200, json={
            "text": "", "usage": {"cost": 0.002, "seconds": 20},
        })
        self.assertEqual(self.client.post("/api/transcription", json=self.payload).status_code, 422)
        with closing(self.getDb()) as conn, conn:
            row = conn.execute("SELECT * FROM transcription_usage").fetchone()
        self.assertEqual(row["cost"], 0.002)
        self.assertIsNone(row["total_tokens"])

    def testFailedRequestHasUnknownCostAndRetryIsSeparate(self):
        self.provider.request.return_value = httpx.Response(502)
        self.client.post("/api/transcription", json=self.payload)
        self.provider.request.return_value = httpx.Response(200, json={"text": "Hello", "usage": {"cost": 0}})
        self.client.post("/api/transcription", json=self.payload)
        with closing(self.getDb()) as conn, conn:
            rows = conn.execute("SELECT * FROM transcription_usage ORDER BY rowid").fetchall()
        self.assertEqual(len(rows), 2)
        self.assertIsNone(rows[0]["cost"])
        self.assertEqual(rows[1]["cost"], 0)


    def testEncodedMultipartContainsAudioAndModelForEachFormat(self):
        from email.parser import BytesParser
        from email.policy import default

        audioData = b"\x00\xffrecorded audio\r\n"
        for audioFormat, mimeType in {"webm": "audio/webm", "m4a": "audio/mp4", "ogg": "audio/ogg", "wav": "audio/wav"}.items():
            with self.subTest(audioFormat=audioFormat):
                response = self.client.post("/api/transcription", json={
                    "audio": base64.b64encode(audioData).decode(), "format": audioFormat,
                })
                self.assertEqual(response.status_code, 200)
                request = httpx.Request(*self.provider.request.call_args.args, **self.provider.request.call_args.kwargs)
                contentType = request.headers["content-type"]
                self.assertTrue(contentType.startswith("multipart/form-data; boundary="))
                message = BytesParser(policy=default).parsebytes(
                    f"Content-Type: {contentType}\r\nMIME-Version: 1.0\r\n\r\n".encode() + request.read()
                )
                parts = {part.get_param("name", header="content-disposition"): part for part in message.iter_parts()}
                self.assertEqual(set(parts), {"model", "file"})
                self.assertEqual(parts["model"].get_payload(decode=True), b"test/transcribe")
                self.assertEqual(parts["file"].get_payload(decode=True), audioData)
                self.assertEqual(parts["file"].get_filename(), f"recording.{audioFormat}")
                self.assertEqual(parts["file"].get_content_type(), mimeType)
