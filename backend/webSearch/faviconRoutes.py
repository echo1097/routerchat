from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response

from backend.core.database import getDb
from backend.core.utils import utcNow
from backend.webSearch.faviconFetch import (
    cachedFavicon,
    fetchFavicon,
    staleFavicon,
    storeFavicon,
)
from backend.webSearch.faviconSafety import safeFaviconDomain

FAVICON_CACHE_SECONDS = 7 * 24 * 60 * 60


router = APIRouter()


@router.get("/api/favicon")
async def getFavicon(domain: str = Query(default="")) -> Response:
    safeDomain = safeFaviconDomain(domain)
    if not safeDomain:
        raise HTTPException(status_code=400, detail="That is not a fetchable domain.")

    now = utcNow()
    with getDb() as conn:
        cached = cachedFavicon(conn, safeDomain)

    if cached and not staleFavicon(cached["fetched_at"], now):
        if not cached["image"]:
            return Response(status_code=204)
        return Response(
            content=cached["image"],
            media_type=cached["mime"],
            headers={"Cache-Control": f"private, max-age={FAVICON_CACHE_SECONDS}"},
        )

    fetched = await fetchFavicon(safeDomain)
    with getDb() as conn:
        storeFavicon(
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
