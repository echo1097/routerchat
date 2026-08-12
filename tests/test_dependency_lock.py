import re
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
HASH_PATTERN = re.compile(r"--hash=sha256:[0-9a-f]{64}")


class DependencyLockTest(unittest.TestCase):
    def test_every_locked_requirement_has_an_artifact_hash(self):
        lines = (PROJECT_ROOT / "requirements.lock").read_text(encoding="utf-8").splitlines()
        missingHashes = []

        for lineIndex, line in enumerate(lines):
            if not line or line[0].isspace() or line.startswith("#") or "==" not in line:
                continue

            requirementBlock = [line]
            for followingLine in lines[lineIndex + 1 :]:
                if followingLine and not followingLine[0].isspace() and not followingLine.startswith("#"):
                    break
                requirementBlock.append(followingLine)

            if not any(HASH_PATTERN.search(blockLine) for blockLine in requirementBlock):
                missingHashes.append(line.split("==", 1)[0])

        self.assertTrue(lines)
        self.assertEqual(missingHashes, [])

    def test_ci_generates_and_requires_dependency_hashes(self):
        workflow = (PROJECT_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")

        self.assertIn("--generate-hashes", workflow)
        self.assertIn("uv pip sync --require-hashes", workflow)
        self.assertIn("git diff --exit-code -- requirements.lock", workflow)

    def test_manual_install_requires_dependency_hashes(self):
        setupGuide = (PROJECT_ROOT / "setup.md").read_text(encoding="utf-8")

        self.assertIn("pip install --require-hashes -r requirements.lock", setupGuide)


if __name__ == "__main__":
    unittest.main()
