from __future__ import annotations

import os

from dotenv import dotenv_values, load_dotenv, set_key

from backend.core import paths


def loadSavedKeys() -> None:
    load_dotenv(paths.ENV_PATH, override=True)


def readEnvKey(name: str) -> str | None:
    envKey = os.getenv(name) or dotenv_values(paths.ENV_PATH).get(name) or ""
    return envKey.strip() or None


def writeEnvKey(name: str, apiKey: str) -> None:
    paths.ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    set_key(paths.ENV_PATH, name, apiKey, quote_mode="never")

    if os.name == "posix":
        paths.ENV_PATH.chmod(0o600)

    os.environ[name] = apiKey
