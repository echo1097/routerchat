import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import backend.main as main
import backend.core.appSettings as appSettings
import backend.providers.openrouter.apiKey as apiKey
import backend.core.paths as paths


class UserDataPathsTest(unittest.TestCase):
    def setUp(self):
        self.originalDataDir = paths.DATA_DIR
        self.originalDbPath = paths.DB_PATH
        self.originalEnvPath = paths.ENV_PATH

    def tearDown(self):
        paths.DATA_DIR = self.originalDataDir
        paths.DB_PATH = self.originalDbPath
        paths.ENV_PATH = self.originalEnvPath

    def test_default_paths_stay_inside_the_repository(self):
        dataDir, dbPath, envPath = paths.resolve_user_data_paths({})

        self.assertEqual(dataDir, paths.ROOT_DIR / "data")
        self.assertEqual(dbPath, paths.ROOT_DIR / "data" / "routerchat.sqlite3")
        self.assertEqual(envPath, paths.ROOT_DIR / ".env")

    def test_configured_paths_share_the_external_directory(self):
        with tempfile.TemporaryDirectory() as tempDir:
            configuredDir = Path(tempDir) / "RouterChat data"
            dataDir, dbPath, envPath = paths.resolve_user_data_paths(
                {paths.USER_DATA_ENV_VAR: str(configuredDir)}
            )

        self.assertEqual(dataDir, configuredDir.resolve())
        self.assertEqual(dbPath, configuredDir.resolve() / "routerchat.sqlite3")
        self.assertEqual(envPath, configuredDir.resolve() / ".env")

    def test_configured_path_expands_the_current_users_home(self):
        dataDir, _, _ = paths.resolve_user_data_paths(
            {paths.USER_DATA_ENV_VAR: "~/routerchat-test-data"}
        )

        self.assertEqual(dataDir, Path.home() / "routerchat-test-data")
        self.assertTrue(dataDir.is_absolute())

    def test_empty_configured_path_is_rejected(self):
        for emptyValue in ("", "   ", "\t"):
            with self.subTest(emptyValue=emptyValue):
                with self.assertRaisesRegex(RuntimeError, "cannot be empty"):
                    paths.resolve_user_data_paths(
                        {paths.USER_DATA_ENV_VAR: emptyValue}
                    )

    def test_external_key_and_database_survive_reinitialization(self):
        with tempfile.TemporaryDirectory() as tempDir:
            userDataDir = Path(tempDir) / "external-user-data"
            paths.DATA_DIR = userDataDir
            paths.DB_PATH = userDataDir / "routerchat.sqlite3"
            paths.ENV_PATH = userDataDir / ".env"

            main.init_db()
            appSettings.write_app_setting("default_model", "test/model")

            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("OPENROUTER_API_KEY", None)
                apiKey.write_openrouter_key("saved-test-key")
                os.environ.pop("OPENROUTER_API_KEY", None)

                self.assertEqual(main.read_openrouter_key(), "saved-test-key")

            main.init_db()

            self.assertTrue(paths.DB_PATH.is_file())
            self.assertEqual(appSettings.read_app_setting("default_model"), "test/model")

            if os.name == "posix":
                fileMode = stat.S_IMODE(paths.ENV_PATH.stat().st_mode)
                self.assertEqual(fileMode, 0o600)


if __name__ == "__main__":
    unittest.main()
