from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI

from backend.devices.lanAddress import validatePhoneOrigin
from backend.local_access import readSecretFile, validateBaseUrl

API_SECRET_FILE_ENV_VAR = "ROUTERCHAT_API_SECRET_FILE"
BASE_URL_ENV_VAR = "ROUTERCHAT_BASE_URL"
TRUSTED_ORIGINS_ENV_VAR = "ROUTERCHAT_TRUSTED_ORIGINS"
PHONE_ORIGIN_ENV_VAR = "ROUTERCHAT_PHONE_ORIGIN"
DEFAULT_BASE_URL = "http://127.0.0.1:8000"


@dataclass(frozen=True)
class LocalAccessConfig:
    baseUrl: str
    allowedHosts: frozenset[str]
    trustedOrigins: frozenset[str]
    secret: str
    phoneOrigin: str | None


def loadLocalAccessConfig(
    environment: Mapping[str, str] | None = None,
) -> LocalAccessConfig:
    environment = os.environ if environment is None else environment
    baseUrl = validateBaseUrl(environment.get(BASE_URL_ENV_VAR, DEFAULT_BASE_URL))
    allowedHosts = frozenset({baseUrl.removeprefix("http://")})

    secretFileValue = environment.get(API_SECRET_FILE_ENV_VAR, "").strip()
    if not secretFileValue:
        raise RuntimeError(f"{API_SECRET_FILE_ENV_VAR} must point to a protected credential file.")
    secret = readSecretFile(Path(secretFileValue).expanduser())

    trustedValue = environment.get(TRUSTED_ORIGINS_ENV_VAR, baseUrl)
    trustedOrigins = frozenset(
        validateBaseUrl(value.strip())
        for value in trustedValue.split(",")
        if value.strip()
    )
    if not trustedOrigins:
        raise RuntimeError(f"{TRUSTED_ORIGINS_ENV_VAR} cannot be empty.")

    phoneOrigin = None
    phoneValue = environment.get(PHONE_ORIGIN_ENV_VAR, "").strip()
    if phoneValue:
        phoneOrigin = validatePhoneOrigin(phoneValue)
        allowedHosts = allowedHosts | {phoneOrigin.removeprefix("http://")}
        trustedOrigins = trustedOrigins | {phoneOrigin}

    return LocalAccessConfig(
        baseUrl=baseUrl,
        allowedHosts=allowedHosts,
        trustedOrigins=trustedOrigins,
        secret=secret,
        phoneOrigin=phoneOrigin,
    )


def localAccessConfig(targetApp: FastAPI) -> LocalAccessConfig:
    config = getattr(targetApp.state, "localAccessConfig", None)
    if config is None:
        config = loadLocalAccessConfig()
        targetApp.state.localAccessConfig = config
    return config
