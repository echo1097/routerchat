import base64
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.transcription import createTranscriptionRouter


class TranscriptionTest(unittest.TestCase):
    def setUp(self):
        self.settings = {"transcription_model": "test/transcribe"}
        app = FastAPI()
        app.include_router(createTranscriptionRouter(
            lambda: "test-key", self.settings.get, self.settings.__setitem__,
            lambda key: {"Authorization": f"Bearer {key}"}, "https://example.invalid",
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
        sent = self.provider.request.call_args.kwargs["json"]
        self.assertEqual(sent["model"], "test/transcribe")
        self.assertEqual(sent["input_audio"], {"data": self.payload["audio"], "format": "webm"})

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
