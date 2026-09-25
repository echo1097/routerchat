from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI

from backend.local_access import read_secret_file, validate_base_url

API_SECRET_FILE_ENV_VAR = "ROUTERCHAT_API_SECRET_FILE"
BASE_URL_ENV_VAR = "ROUTERCHAT_BASE_URL"
TRUSTED_ORIGINS_ENV_VAR = "ROUTERCHAT_TRUSTED_ORIGINS"
DEFAULT_BASE_URL = "http://127.0.0.1:8000"


@dataclass(frozen=True)
class LocalAccessConfig:
    baseUrl: str
    allowedHost: str
    trustedOrigins: frozenset[str]
    secret: str


def load_local_access_config(
    environment: Mapping[str, str] | None = None,
) -> LocalAccessConfig:
    environment = os.environ if environment is None else environment
    baseUrl = validate_base_url(environment.get(BASE_URL_ENV_VAR, DEFAULT_BASE_URL))
    allowedHost = baseUrl.removeprefix("http://")

    secretFileValue = environment.get(API_SECRET_FILE_ENV_VAR, "").strip()
    if not secretFileValue:
        raise RuntimeError(f"{API_SECRET_FILE_ENV_VAR} must point to a protected credential file.")
    secret = read_secret_file(Path(secretFileValue).expanduser())

    trustedValue = environment.get(TRUSTED_ORIGINS_ENV_VAR, baseUrl)
    trustedOrigins = frozenset(
        validate_base_url(value.strip())
        for value in trustedValue.split(",")
        if value.strip()
    )
    if not trustedOrigins:
        raise RuntimeError(f"{TRUSTED_ORIGINS_ENV_VAR} cannot be empty.")

    return LocalAccessConfig(
        baseUrl=baseUrl,
        allowedHost=allowedHost,
        trustedOrigins=trustedOrigins,
        secret=secret,
    )


def local_access_config(targetApp: FastAPI) -> LocalAccessConfig:
    config = getattr(targetApp.state, "localAccessConfig", None)
    if config is None:
        config = load_local_access_config()
        targetApp.state.localAccessConfig = config
    return config
