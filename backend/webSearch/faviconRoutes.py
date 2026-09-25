from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response

from backend.core.database import get_db
from backend.core.utils import utc_now
from backend.webSearch.faviconFetch import (
    cached_favicon,
    fetch_favicon,
    stale_favicon,
    store_favicon,
)
from backend.webSearch.faviconSafety import safe_favicon_domain

FAVICON_CACHE_SECONDS = 7 * 24 * 60 * 60


router = APIRouter()


@router.get("/api/favicon")
async def get_favicon(domain: str = Query(default="")) -> Response:
    safeDomain = safe_favicon_domain(domain)
    if not safeDomain:
        raise HTTPException(status_code=400, detail="That is not a fetchable domain.")

    now = utc_now()
    with get_db() as conn:
        cached = cached_favicon(conn, safeDomain)

    if cached and not stale_favicon(cached["fetched_at"], now):
        if not cached["image"]:
            return Response(status_code=204)
        return Response(
            content=cached["image"],
            media_type=cached["mime"],
            headers={"Cache-Control": f"private, max-age={FAVICON_CACHE_SECONDS}"},
        )

    fetched = await fetch_favicon(safeDomain)
    with get_db() as conn:
        store_favicon(
            conn,
            safeDomain,
            fetched[0] if fetched else None,
            fetched[1] if fetched else None,
            now,
        )

    if not fetched:
        return Response(status_code=204)

    return Response(
        content=fetched[1],
        media_type=fetched[0],
        headers={"Cache-Control": f"private, max-age={FAVICON_CACHE_SECONDS}"},
    )
