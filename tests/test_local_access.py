import io
import os
import stat
import sys
import tempfile
import threading
import types
import unittest
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from backend.local_access import (
    create_secret_file,
    open_bootstrap_page,
    read_secret_file,
    serve_local_app,
)


class LocalAccessTest(unittest.TestCase):
    def test_secret_file_has_enough_entropy_and_owner_only_permissions(self):
        with tempfile.TemporaryDirectory() as tempDir:
            secretPath = Path(tempDir) / "run" / "api-secret"
            secret = create_secret_file(secretPath)

            self.assertGreaterEqual(len(secret), 43)
            self.assertEqual(read_secret_file(secretPath), secret)
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(secretPath.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(secretPath.parent.stat().st_mode), 0o700)

    def test_secret_creation_refuses_to_replace_existing_state_implicitly(self):
        with tempfile.TemporaryDirectory() as tempDir:
            secretPath = Path(tempDir) / "api-secret"
            create_secret_file(secretPath)

            with self.assertRaises(FileExistsError):
                create_secret_file(secretPath)

    def test_secret_reader_rejects_symlinks_and_permissive_files(self):
        if os.name != "posix":
            self.skipTest("POSIX file modes and symlinks are tested on POSIX")

        with tempfile.TemporaryDirectory() as tempDir:
            root = Path(tempDir)
            realPath = root / "real-secret"
            secret = create_secret_file(realPath)
            linkPath = root / "linked-secret"
            linkPath.symlink_to(realPath)

            with self.assertRaises(RuntimeError):
                read_secret_file(linkPath)

            realPath.chmod(0o644)
            with self.assertRaises(RuntimeError):
                read_secret_file(realPath)

            self.assertTrue(secret)

    def test_one_shot_page_uses_a_non_secret_url_and_suppresses_access_logs(self):
        with tempfile.TemporaryDirectory() as tempDir:
            secretPath = Path(tempDir) / "api-secret"
            secret = create_secret_file(secretPath)
            opened = []
            output = io.StringIO()

            def browserOpen(url):
                opened.append(url)

                def fetchPage():
                    with urllib.request.urlopen(url, timeout=2) as response:
                        body = response.read().decode("utf-8")
                        self.assertIn(secret, body)
                        self.assertIn("http://127.0.0.1:8000/api/bootstrap", body)

                threading.Thread(target=fetchPage, daemon=True).start()
                return True

            with redirect_stdout(output), redirect_stderr(output):
                open_bootstrap_page(
                    secretPath,
                    "http://127.0.0.1:8000",
                    browser_open=browserOpen,
                    timeout=2,
                )

            self.assertEqual(len(opened), 1)
            self.assertNotIn(secret, opened[0])
            self.assertEqual(output.getvalue(), "")

            with self.assertRaises(Exception):
                urllib.request.urlopen(opened[0], timeout=0.2)

    def test_server_command_sets_security_environment_and_cleans_up_the_secret(self):
        with tempfile.TemporaryDirectory() as tempDir:
            secretPath = Path(tempDir) / "run" / "api-secret"
            observed = {}

            def runServer(appPath, host, port):
                observed["appPath"] = appPath
                observed["host"] = host
                observed["port"] = port
                observed["secret"] = read_secret_file(secretPath)
                observed["secretFile"] = os.environ["ROUTERCHAT_API_SECRET_FILE"]
                observed["baseUrl"] = os.environ["ROUTERCHAT_BASE_URL"]
                observed["origins"] = os.environ["ROUTERCHAT_TRUSTED_ORIGINS"]

            fakeUvicorn = types.SimpleNamespace(run=runServer)
            originalEnvironment = os.environ.copy()
            try:
                with patch.dict(sys.modules, {"uvicorn": fakeUvicorn}):
                    serve_local_app(
                        secretPath,
                        "http://127.0.0.1:8000",
                        ["http://127.0.0.1:8000"],
                    )
            finally:
                os.environ.clear()
                os.environ.update(originalEnvironment)

            self.assertEqual(observed["appPath"], "backend.main:app")
            self.assertEqual(observed["host"], "127.0.0.1")
            self.assertEqual(observed["port"], 8000)
            self.assertEqual(observed["secretFile"], str(secretPath.resolve()))
            self.assertEqual(observed["baseUrl"], "http://127.0.0.1:8000")
            self.assertEqual(observed["origins"], "http://127.0.0.1:8000")
            self.assertGreaterEqual(len(observed["secret"]), 43)
            self.assertFalse(secretPath.exists())


if __name__ == "__main__":
    unittest.main()
