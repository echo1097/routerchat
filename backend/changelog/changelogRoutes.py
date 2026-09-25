from typing import Any

from fastapi import APIRouter

from backend.core.appSettings import read_app_setting, write_app_setting
from backend.core.paths import APP_VERSION

LAST_SEEN_VERSION_KEY = "last_seen_changelog_version"


router = APIRouter()


@router.get("/api/changelog/status")
async def get_changelog_status() -> dict[str, Any]:
    lastSeenVersion = read_app_setting(LAST_SEEN_VERSION_KEY)
    return {
        "current_version": APP_VERSION,
        "last_seen_version": lastSeenVersion,
        "should_show": lastSeenVersion != APP_VERSION,
    }


@router.post("/api/changelog/seen")
async def mark_changelog_seen() -> dict[str, Any]:
    write_app_setting(LAST_SEEN_VERSION_KEY, APP_VERSION)
    return {"current_version": APP_VERSION, "last_seen_version": APP_VERSION}
