from typing import Any

from fastapi import APIRouter

from backend.core.appSettings import readAppSetting, writeAppSetting
from backend.core.paths import APP_VERSION

LAST_SEEN_VERSION_KEY = "last_seen_changelog_version"


router = APIRouter()


@router.get("/api/changelog/status")
async def getChangelogStatus() -> dict[str, Any]:
    lastSeenVersion = readAppSetting(LAST_SEEN_VERSION_KEY)
    return {
        "current_version": APP_VERSION,
        "last_seen_version": lastSeenVersion,
        "should_show": lastSeenVersion != APP_VERSION,
    }


@router.post("/api/changelog/seen")
async def markChangelogSeen() -> dict[str, Any]:
    writeAppSetting(LAST_SEEN_VERSION_KEY, APP_VERSION)
    return {"current_version": APP_VERSION, "last_seen_version": APP_VERSION}
