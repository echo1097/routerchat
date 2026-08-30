from __future__ import annotations

import ipaddress
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Iterable
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query, Response

WEB_SEARCH_MAX_RESULTS = 5

FAVICON_TIMEOUT = httpx.Timeout(connect=4.0, read=6.0, write=4.0, pool=4.0)
FAVICON_MAX_BYTES = 100 * 1024
FAVICON_CACHE_SECONDS = 7 * 24 * 60 * 60
FAVICON_REFRESH_DAYS = 30
FAVICON_USER_AGENT = "RouterChat/1.0 (favicon fetch)"

BLOCKED_FAVICON_HOSTS = {"localhost", "localhost.localdomain", "broadcasthost"}
BLOCKED_FAVICON_SUFFIXES = (".local", ".internal", ".localhost", ".test", ".invalid", ".onion")

ICON_LINK_PATTERN = re.compile(
    r"""<link\b[^>]*rel\s*=\s*["']?[^"'>]*\bicon\b[^"'>]*["']?[^>]*>""",
    re.IGNORECASE,
)
ICON_HREF_PATTERN = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.IGNORECASE)


@dataclass(frozen=True)
class WebSearchDeps:
    get_db: Callable[[], Any]
    utc_now: Callable[[], str]


def web_search_plugin() -> dict[str, Any]:
    return {"id": "web", "max_results": WEB_SEARCH_MAX_RESULTS}


def source_domain(url: str) -> str:
    hostname = (urlparse(url).hostname or "").lower().strip(".")
    return hostname.removeprefix("www.")


def normalize_sources(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []

    sources: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue

        citation = item.get("url_citation")
        citation = citation if isinstance(citation, dict) else {}
        url = str(citation.get("url") or item.get("url") or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            continue

        domain = source_domain(url)
        if not domain:
            continue

        title = str(citation.get("title") or item.get("title") or "").strip()
        sources.append({"url": url, "title": title[:300], "domain": domain})

    return sources


def merge_sources(
    existing: Iterable[dict[str, str]], incoming: Iterable[dict[str, str]]
) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    seen: set[str] = set()

    for source in [*existing, *incoming]:
        url = source.get("url") or ""
        if not url or url in seen:
            continue
        seen.add(url)
        merged.append(source)

    return merged


def serialize_sources(sources: list[dict[str, str]]) -> str | None:
    return json.dumps(sources) if sources else None


def deserialize_sources(stored: Any) -> list[dict[str, str]]:
    if not stored:
        return []

    try:
        parsed = json.loads(stored)
    except (TypeError, ValueError):
        return []

    return normalize_sources(parsed)


def safe_favicon_domain(raw: str) -> str | None:
    domain = (raw or "").strip().lower().rstrip(".")

    if not domain or len(domain) > 253:
        return None
    if not re.fullmatch(r"[a-z0-9.-]+", domain):
        return None
    if ".." in domain or domain.startswith("-") or domain.startswith("."):
        return None

    labels = domain.split(".")
    if len(labels) < 2 or any(not label for label in labels):
        return None
    if domain in BLOCKED_FAVICON_HOSTS or domain.endswith(BLOCKED_FAVICON_SUFFIXES):
        return None

    try:
        ipaddress.ip_address(domain)
        return None
    except ValueError:
        return domain


def cached_favicon(conn: sqlite3.Connection, domain: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT domain, mime, image, fetched_at FROM favicons WHERE domain = ?",
        (domain,),
    ).fetchone()


def store_favicon(
    conn: sqlite3.Connection,
    domain: str,
    mime: str | None,
    image: bytes | None,
    now: str,
) -> None:
    conn.execute(
        """
        INSERT INTO favicons (domain, mime, image, fetched_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET mime = ?, image = ?, fetched_at = ?
        """,
        (domain, mime, image, now, mime, image, now),
    )


def usable_image(response: httpx.Response) -> bytes | None:
    if response.status_code >= 400:
        return None

    mime = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
    if not mime.startswith("image/"):
        return None

    image = response.content
    if not image or len(image) > FAVICON_MAX_BYTES:
        return None

    return image


def icon_href_from_html(html: str) -> str | None:
    for tag in ICON_LINK_PATTERN.findall(html):
        href = ICON_HREF_PATTERN.search(tag)
        if href and href.group(1).strip():
            return href.group(1).strip()
    return None


async def fetch_favicon(domain: str) -> tuple[str, bytes] | None:
    headers = {"User-Agent": FAVICON_USER_AGENT, "Accept": "image/*,*/*;q=0.5"}

    async with httpx.AsyncClient(
        timeout=FAVICON_TIMEOUT,
        follow_redirects=True,
        max_redirects=3,
        headers=headers,
    ) as client:
        try:
            direct = await client.get(f"https://{domain}/favicon.ico")
        except httpx.HTTPError:
            direct = None

        if direct is not None:
            image = usable_image(direct)
            if image:
                mime = direct.headers["content-type"].split(";")[0].strip().lower()
                return mime, image

        try:
            page = await client.get(f"https://{domain}/", headers={"Accept": "text/html"})
        except httpx.HTTPError:
            return None

        if page.status_code >= 400:
            return None

        href = icon_href_from_html(page.text[:200_000])
        if not href:
            return None

        iconUrl = urljoin(str(page.url), href)
        if not iconUrl.lower().startswith("https://"):
            return None

        try:
            icon = await client.get(iconUrl)
        except httpx.HTTPError:
            return None

        image = usable_image(icon)
        if not image:
            return None

        return icon.headers["content-type"].split(";")[0].strip().lower(), image


def stale_favicon(fetched_at: str, now: str) -> bool:
    try:
        cachedAt = datetime.fromisoformat((fetched_at or "").replace("Z", "+00:00"))
        checkedAt = datetime.fromisoformat((now or "").replace("Z", "+00:00"))
    except ValueError:
        return True

    return (checkedAt - cachedAt).days > FAVICON_REFRESH_DAYS


def create_web_search_router(deps: WebSearchDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/api/favicon")
    async def get_favicon(domain: str = Query(default="")) -> Response:
        safeDomain = safe_favicon_domain(domain)
        if not safeDomain:
            raise HTTPException(status_code=400, detail="That is not a fetchable domain.")

        now = deps.utc_now()
        with deps.get_db() as conn:
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
        with deps.get_db() as conn:
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

    return router
