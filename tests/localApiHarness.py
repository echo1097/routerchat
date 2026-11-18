import os
import tempfile
from pathlib import Path
from unittest.mock import patch

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


class LocalApiHarness:
    databaseFile = "routerchat-test.sqlite3"

    def setUp(self):
        modelLookup = patch("backend.providers.openrouter.models.lookUpMissingModel", return_value=None)
        modelLookup.start()
        self.addCleanup(modelLookup.stop)
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = paths.DATA_DIR
        self.originalDbPath = paths.DB_PATH
        paths.DATA_DIR = Path(self.tempDir.name)
        paths.DB_PATH = paths.DATA_DIR / self.databaseFile
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
