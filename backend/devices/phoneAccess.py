from __future__ import annotations

import sqlite3

from backend.core.appSettings import readAppSetting, writeAppSetting
from backend.devices.lanAddress import detectLanAddress

PHONE_ACCESS_SETTING = "phone_access"


def phoneAccessEnabled() -> bool:
    try:
        return readAppSetting(PHONE_ACCESS_SETTING) is True
    except sqlite3.Error:
        return False


def setPhoneAccess(enabled: bool) -> None:
    writeAppSetting(PHONE_ACCESS_SETTING, enabled)


def phoneListenAddress() -> str | None:
    if not phoneAccessEnabled():
        return None

    return detectLanAddress()
