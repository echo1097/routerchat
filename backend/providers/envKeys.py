from __future__ import annotations

import os
import tempfile
from pathlib import Path

from backend.core import paths


def readEnvKey(name: str) -> str | None:
    envKey = os.getenv(name)
    if envKey:
        return envKey.strip()
    if not paths.ENV_PATH.exists():
        return None

    prefix = f"{name}="
    for line in paths.ENV_PATH.read_text(encoding="utf-8").splitlines():
        if line.startswith(prefix):
            value = line.split("=", 1)[1].strip().strip('"').strip("'")
            return value or None
    return None


def writeEnvKey(name: str, apiKey: str) -> None:
    paths.ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    prefix = f"{name}="
    lines: list[str] = []
    replaced = False
    if paths.ENV_PATH.exists():
        lines = paths.ENV_PATH.read_text(encoding="utf-8").splitlines()

    nextLines: list[str] = []
    for line in lines:
        if line.startswith(prefix):
            nextLines.append(f"{prefix}{apiKey}")
            replaced = True
        else:
            nextLines.append(line)
    if not replaced:
        nextLines.append(f"{prefix}{apiKey}")

    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=paths.ENV_PATH.parent, delete=False
    ) as handle:
        handle.write("\n".join(nextLines).rstrip() + "\n")
        tempName = handle.name

    tempPath = Path(tempName)
    if os.name == "posix":
        tempPath.chmod(0o600)
    tempPath.replace(paths.ENV_PATH)
    if os.name == "posix":
        paths.ENV_PATH.chmod(0o600)

    os.environ[name] = apiKey
