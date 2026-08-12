import hashlib
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.package_release import buildReleasePackage


class ReleasePackageTest(unittest.TestCase):
    def test_package_has_only_the_approved_application_layout(self):
        with tempfile.TemporaryDirectory() as tempDir:
            zipPath, checksumPath = buildReleasePackage(Path(tempDir), "v1.0.2")

            with zipfile.ZipFile(zipPath) as archive:
                names = set(archive.namelist())

            topLevelNames = {name.split("/", 1)[0] for name in names}
            blockedParts = {
                ".env",
                ".git",
                ".venv",
                "__pycache__",
                "data",
                "node_modules",
                "playwright-report",
                "test-results",
                "tests",
            }

            self.assertEqual(
                topLevelNames,
                {
                    "LICENSE",
                    "NOTICE",
                    "TOS.md",
                    "backend",
                    "dist",
                    "requirements.lock",
                    "version.json",
                },
            )
            self.assertIn("backend/local_access.py", names)
            self.assertIn("backend/main.py", names)
            self.assertIn("dist/index.html", names)
            self.assertFalse(
                any(part in blockedParts for name in names for part in Path(name).parts)
            )

            checksum = hashlib.sha256(zipPath.read_bytes()).hexdigest()
            self.assertEqual(
                checksumPath.read_text(encoding="utf-8"),
                f"{checksum}  routerchat-app.zip\n",
            )

    def test_package_output_is_deterministic(self):
        with (
            tempfile.TemporaryDirectory() as firstDir,
            tempfile.TemporaryDirectory() as secondDir,
        ):
            firstZip, _ = buildReleasePackage(Path(firstDir), "1.0.2")
            secondZip, _ = buildReleasePackage(Path(secondDir), "1.0.2")

            self.assertEqual(firstZip.read_bytes(), secondZip.read_bytes())

    def test_release_tag_must_match_version_metadata(self):
        with tempfile.TemporaryDirectory() as tempDir:
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                buildReleasePackage(Path(tempDir), "v9.9.9")


if __name__ == "__main__":
    unittest.main()
