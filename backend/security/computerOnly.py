from __future__ import annotations

import re

DEVICE_SESSION_PATH = "/api/devices/session"
PROVIDER_KEY_PATTERN = re.compile(r"^/api/providers/[^/]+/key/?$")


def isComputerOnly(method: str, path: str) -> bool:
    if path == DEVICE_SESSION_PATH:
        return False

    if path == "/api/devices" or path.startswith("/api/devices/"):
        return True

    return method != "GET" and bool(PROVIDER_KEY_PATTERN.fullmatch(path))
