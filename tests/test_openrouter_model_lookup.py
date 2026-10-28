import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

import backend.core.paths as paths
import backend.main as main
import backend.providers.openrouter.models as models


def modelListResponse(*entries):
    return httpx.Response(
        200,
        json={"data": list(entries)},
        request=httpx.Request("GET", "https://openrouter.ai/api/v1/models"),
    )


THINKING_MODEL = {
    "id": "test/thinker",
    "name": "Test: Thinker",
    "architecture": {"output_modalities": ["text"]},
    "supported_parameters": ["reasoning", "structured_outputs"],
    "reasoning": {"mandatory": True},
}


class MissingModelLookupTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = paths.DATA_DIR
        self.originalDbPath = paths.DB_PATH
        paths.DATA_DIR = Path(self.tempDir.name)
        paths.DB_PATH = paths.DATA_DIR / "routerchat-test.sqlite3"
        main.initDb()
        models.lookedUpModelIds.clear()

        keyPatch = patch.object(models, "readOpenrouterKey", return_value="test-key")
        keyPatch.start()
        self.addCleanup(keyPatch.stop)

    def tearDown(self):
        models.lookedUpModelIds.clear()
        paths.DATA_DIR = self.originalDataDir
        paths.DB_PATH = self.originalDbPath
        self.tempDir.cleanup()

    def test_a_missing_model_is_looked_up_and_saved_for_next_time(self):
        with patch.object(models.httpx, "get", return_value=modelListResponse(THINKING_MODEL)) as lookup:
            self.assertEqual(models.modelMetadata("test/thinker")["id"], "test/thinker")
            self.assertTrue(models.modelRequiresReasoning("test/thinker"))
            self.assertTrue(models.modelSupportsStructuredOutput("test/thinker"))

        lookup.assert_called_once()
        self.assertEqual([model["id"] for model in models.cachedModels()], ["test/thinker"])

    def test_the_nitro_suffix_finds_the_looked_up_model(self):
        with patch.object(models.httpx, "get", return_value=modelListResponse(THINKING_MODEL)):
            self.assertEqual(models.modelMetadata("test/thinker:nitro")["id"], "test/thinker")

    def test_a_model_openrouter_no_longer_lists_is_only_looked_up_once(self):
        with patch.object(models.httpx, "get", return_value=modelListResponse(THINKING_MODEL)) as lookup:
            self.assertIsNone(models.modelMetadata("test/retired"))
            self.assertIsNone(models.modelMetadata("test/retired"))

        lookup.assert_called_once()

    def test_nothing_is_requested_without_a_key(self):
        with patch.object(models, "readOpenrouterKey", return_value=None), patch.object(models.httpx, "get") as lookup:
            self.assertIsNone(models.modelMetadata("test/thinker"))

        lookup.assert_not_called()

    def test_a_failed_lookup_leaves_the_model_unknown(self):
        failure = httpx.ConnectError("offline")
        with patch.object(models.httpx, "get", side_effect=failure):
            self.assertIsNone(models.modelMetadata("test/thinker"))
            self.assertFalse(models.modelRequiresReasoning("test/thinker"))

        self.assertEqual(models.cachedModels(), [])

    def test_an_error_response_leaves_the_model_unknown(self):
        errorResponse = httpx.Response(401, request=httpx.Request("GET", "https://openrouter.ai/api/v1/models"))
        with patch.object(models.httpx, "get", return_value=errorResponse):
            self.assertIsNone(models.modelMetadata("test/thinker"))

        self.assertEqual(models.cachedModels(), [])


if __name__ == "__main__":
    unittest.main()
