from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path


projectRoot = Path(__file__).resolve().parent.parent
requiredFiles = (
    Path("LICENSE"),
    Path("NOTICE"),
    Path("TOS.md"),
    Path("requirements.lock"),
    Path("version.json"),
)
requiredAppFiles = (
    Path("backend/__init__.py"),
    Path("backend/local_access.py"),
    Path("backend/main.py"),
    Path("dist/index.html"),
)
blockedNames = {
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
zipTimestamp = (2020, 1, 1, 0, 0, 0)


def normalizedVersion(value: str) -> str:
    return value.strip().removeprefix("v")


def readVersionMetadata(expectedTag: str | None = None) -> dict[str, str]:
    versionPath = projectRoot / "version.json"
    try:
        metadata = json.loads(versionPath.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("version.json is missing or invalid") from exc

    requiredFields = ("version", "releaseTag", "minimumUpdaterVersion")
    for field in requiredFields:
        if not isinstance(metadata.get(field), str) or not metadata[field].strip():
            raise RuntimeError(f"version.json has an invalid {field}")

    if normalizedVersion(metadata["version"]) != normalizedVersion(
        metadata["releaseTag"]
    ):
        raise RuntimeError("version and releaseTag must match")

    if expectedTag and normalizedVersion(metadata["releaseTag"]) != normalizedVersion(
        expectedTag
    ):
        raise RuntimeError("version.json does not match the release tag")

    return metadata


def copyDirectory(sourceDir: Path, targetDir: Path) -> None:
    for sourcePath in sorted(sourceDir.rglob("*")):
        relativePath = sourcePath.relative_to(sourceDir)
        if any(part in blockedNames for part in relativePath.parts):
            continue
        if sourcePath.is_symlink():
            raise RuntimeError(f"release content cannot contain symlinks: {sourcePath}")
        if not sourcePath.is_file():
            continue

        targetPath = targetDir / relativePath
        targetPath.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(sourcePath, targetPath)


def stageApplication(stageDir: Path, expectedTag: str | None = None) -> None:
    readVersionMetadata(expectedTag)

    for requiredPath in requiredAppFiles:
        if not (projectRoot / requiredPath).is_file():
            raise RuntimeError(f"required release file is missing: {requiredPath}")

    copyDirectory(projectRoot / "backend", stageDir / "backend")
    copyDirectory(projectRoot / "dist", stageDir / "dist")

    for relativePath in requiredFiles:
        shutil.copyfile(projectRoot / relativePath, stageDir / relativePath)

    for stagedPath in stageDir.rglob("*"):
        if any(part in blockedNames for part in stagedPath.relative_to(stageDir).parts):
            raise RuntimeError(f"blocked release content was staged: {stagedPath}")


def writeDeterministicZip(stageDir: Path, zipPath: Path) -> None:
    with zipfile.ZipFile(
        zipPath,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for sourcePath in sorted(path for path in stageDir.rglob("*") if path.is_file()):
            archivePath = sourcePath.relative_to(stageDir).as_posix()
            zipInfo = zipfile.ZipInfo(archivePath, date_time=zipTimestamp)
            zipInfo.compress_type = zipfile.ZIP_DEFLATED
            zipInfo.external_attr = 0o100644 << 16
            archive.writestr(zipInfo, sourcePath.read_bytes(), compresslevel=9)


def buildReleasePackage(
    outputDir: Path,
    expectedTag: str | None = None,
) -> tuple[Path, Path]:
    outputDir.mkdir(parents=True, exist_ok=True)
    zipPath = outputDir / "routerchat-app.zip"
    checksumPath = outputDir / "routerchat-app.zip.sha256"

    with tempfile.TemporaryDirectory(prefix="routerchat-package-") as tempDir:
        stageDir = Path(tempDir) / "app"
        stageDir.mkdir()
        stageApplication(stageDir, expectedTag)
        writeDeterministicZip(stageDir, zipPath)

    checksum = hashlib.sha256(zipPath.read_bytes()).hexdigest()
    checksumPath.write_text(f"{checksum}  {zipPath.name}\n", encoding="utf-8")
    return zipPath, checksumPath


def parseArgs() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the portable RouterChat app package")
    parser.add_argument("--output-dir", type=Path, default=projectRoot / "release")
    parser.add_argument("--expected-tag")
    return parser.parse_args()


def main() -> None:
    args = parseArgs()
    buildReleasePackage(args.output_dir.resolve(), args.expected_tag)


if __name__ == "__main__":
    main()
