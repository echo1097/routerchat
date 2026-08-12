import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import backend.main as main


class UserDataPathsTest(unittest.TestCase):
    def setUp(self):
        self.originalDataDir = main.DATA_DIR
        self.originalDbPath = main.DB_PATH
        self.originalEnvPath = main.ENV_PATH

    def tearDown(self):
        main.DATA_DIR = self.originalDataDir
        main.DB_PATH = self.originalDbPath
        main.ENV_PATH = self.originalEnvPath

    def test_default_paths_stay_inside_the_repository(self):
        dataDir, dbPath, envPath = main.resolve_user_data_paths({})

        self.assertEqual(dataDir, main.ROOT_DIR / "data")
        self.assertEqual(dbPath, main.ROOT_DIR / "data" / "routerchat.sqlite3")
        self.assertEqual(envPath, main.ROOT_DIR / ".env")

    def test_configured_paths_share_the_external_directory(self):
        with tempfile.TemporaryDirectory() as tempDir:
            configuredDir = Path(tempDir) / "RouterChat data"
            dataDir, dbPath, envPath = main.resolve_user_data_paths(
                {main.USER_DATA_ENV_VAR: str(configuredDir)}
            )

        self.assertEqual(dataDir, configuredDir.resolve())
        self.assertEqual(dbPath, configuredDir.resolve() / "routerchat.sqlite3")
        self.assertEqual(envPath, configuredDir.resolve() / ".env")

    def test_configured_path_expands_the_current_users_home(self):
        dataDir, _, _ = main.resolve_user_data_paths(
            {main.USER_DATA_ENV_VAR: "~/routerchat-test-data"}
        )

        self.assertEqual(dataDir, Path.home() / "routerchat-test-data")
        self.assertTrue(dataDir.is_absolute())

    def test_empty_configured_path_is_rejected(self):
        for emptyValue in ("", "   ", "\t"):
            with self.subTest(emptyValue=emptyValue):
                with self.assertRaisesRegex(RuntimeError, "cannot be empty"):
                    main.resolve_user_data_paths(
                        {main.USER_DATA_ENV_VAR: emptyValue}
                    )

    def test_external_key_and_database_survive_reinitialization(self):
        with tempfile.TemporaryDirectory() as tempDir:
            userDataDir = Path(tempDir) / "external-user-data"
            main.DATA_DIR = userDataDir
            main.DB_PATH = userDataDir / "routerchat.sqlite3"
            main.ENV_PATH = userDataDir / ".env"

            main.init_db()
            main.write_app_setting("default_model", "test/model")

            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("OPENROUTER_API_KEY", None)
                main.write_openrouter_key("saved-test-key")
                os.environ.pop("OPENROUTER_API_KEY", None)

                self.assertEqual(main.read_openrouter_key(), "saved-test-key")

            main.init_db()

            self.assertTrue(main.DB_PATH.is_file())
            self.assertEqual(main.read_app_setting("default_model"), "test/model")

            if os.name == "posix":
                fileMode = stat.S_IMODE(main.ENV_PATH.stat().st_mode)
                self.assertEqual(fileMode, 0o600)


if __name__ == "__main__":
    unittest.main()
