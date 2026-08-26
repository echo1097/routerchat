from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter

LAST_SEEN_VERSION_KEY = "last_seen_changelog_version"


@dataclass(frozen=True)
class ChangelogStatusDeps:
    read_app_setting: Callable[[str], Any]
    write_app_setting: Callable[[str, Any], None]
    app_version: str


def create_changelog_status_router(deps: ChangelogStatusDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/api/changelog/status")
    async def get_changelog_status() -> dict[str, Any]:
        lastSeenVersion = deps.read_app_setting(LAST_SEEN_VERSION_KEY)
        return {
            "current_version": deps.app_version,
            "last_seen_version": lastSeenVersion,
            "should_show": lastSeenVersion != deps.app_version,
        }

    @router.post("/api/changelog/seen")
    async def mark_changelog_seen() -> dict[str, Any]:
        deps.write_app_setting(LAST_SEEN_VERSION_KEY, deps.app_version)
        return {"current_version": deps.app_version, "last_seen_version": deps.app_version}

    return router
