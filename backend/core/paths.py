from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
STATIC_DIR = ROOT_DIR / "dist"
TOS_PATH = ROOT_DIR / "TOS.md"
VERSION_PATH = ROOT_DIR / "version.json"
USER_DATA_ENV_VAR = "ROUTERCHAT_USER_DATA_DIR"


def resolveUserDataPaths(
    environment: Mapping[str, str] | None = None,
) -> tuple[Path, Path, Path]:
    environment = os.environ if environment is None else environment

    if USER_DATA_ENV_VAR not in environment:
        dataDir = ROOT_DIR / "data"
        return dataDir, dataDir / "routerchat.sqlite3", ROOT_DIR / ".env"

    configuredPath = environment[USER_DATA_ENV_VAR]
    if not configuredPath.strip():
        raise RuntimeError(f"{USER_DATA_ENV_VAR} cannot be empty.")

    userDataDir = Path(configuredPath).expanduser().resolve(strict=False)
    return userDataDir, userDataDir / "routerchat.sqlite3", userDataDir / ".env"


def loadVersionMetadata() -> dict[str, str]:
    try:
        metadata = json.loads(VERSION_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("version.json is missing or invalid.") from exc

    requiredFields = ("version", "releaseTag", "minimumUpdaterVersion")
    missingField = any(
        not isinstance(metadata.get(field), str) or not metadata[field].strip()
        for field in requiredFields
    )
    if missingField:
        raise RuntimeError("version.json is missing required version fields.")

    return {field: metadata[field].strip() for field in requiredFields}


DATA_DIR, DB_PATH, ENV_PATH = resolveUserDataPaths()
VERSION_METADATA = loadVersionMetadata()
APP_VERSION = VERSION_METADATA["version"]


def usageDbPath() -> Path:
    return DB_PATH.with_name("usage.sqlite3")
