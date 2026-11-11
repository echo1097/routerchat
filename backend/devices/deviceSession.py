from __future__ import annotations

from fastapi import Request

from backend.devices.deviceTokens import findActiveDevice
from backend.devices.phoneAccess import phoneAccessEnabled
from backend.security.localAccessConfig import LocalAccessConfig

DEVICE_COOKIE_NAME = "routerchat_device"
DEVICE_COOKIE_LIFETIME = 400 * 24 * 60 * 60


def deviceSessionActive(request: Request, config: LocalAccessConfig) -> bool:
    if config.phoneOrigin is None:
        return False

    deviceToken = request.cookies.get(DEVICE_COOKIE_NAME, "")
    if not deviceToken or not phoneAccessEnabled():
        return False

    return findActiveDevice(deviceToken) is not None
