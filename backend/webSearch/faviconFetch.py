from __future__ import annotations

import re
import sqlite3
from datetime import datetime
from urllib.parse import urljoin

import httpx

from backend.webSearch.faviconSafety import FAVICON_TIMEOUT, FaviconTransport

FAVICON_MAX_BYTES = 100 * 1024
FAVICON_REFRESH_DAYS = 30
FAVICON_USER_AGENT = "RouterChat/1.0 (favicon fetch)"
ICON_LINK_PATTERN = re.compile(
    r"""<link\b[^>]*rel\s*=\s*["']?[^"'>]*\bicon\b[^"'>]*["']?[^>]*>""",
    re.IGNORECASE,
)
ICON_HREF_PATTERN = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.IGNORECASE)


def cachedFavicon(conn: sqlite3.Connection, domain: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT domain, mime, image, fetched_at FROM favicons WHERE domain = ?",
        (domain,),
    ).fetchone()


def storeFavicon(
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


def usableImage(response: httpx.Response) -> bytes | None:
    if response.status_code >= 400:
        return None

    mime = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
    if not mime.startswith("image/"):
        return None

    image = response.content
    if not image or len(image) > FAVICON_MAX_BYTES:
        return None

    return image


def iconHrefFromHtml(html: str) -> str | None:
    for tag in ICON_LINK_PATTERN.findall(html):
        href = ICON_HREF_PATTERN.search(tag)
        if href and href.group(1).strip():
            return href.group(1).strip()
    return None


async def fetchFavicon(domain: str) -> tuple[str, bytes] | None:
    headers = {"User-Agent": FAVICON_USER_AGENT, "Accept": "image/*,*/*;q=0.5"}

    async with httpx.AsyncClient(
        transport=FaviconTransport(),
        trust_env=False,
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
            image = usableImage(direct)
            if image:
                mime = direct.headers["content-type"].split(";")[0].strip().lower()
                return mime, image

        try:
            page = await client.get(f"https://{domain}/", headers={"Accept": "text/html"})
        except httpx.HTTPError:
            return None

        if page.status_code >= 400:
            return None

        href = iconHrefFromHtml(page.text[:200_000])
        if not href:
            return None

        iconUrl = urljoin(str(page.url), href)
        if not iconUrl.lower().startswith("https://"):
            return None

        try:
            icon = await client.get(iconUrl)
        except httpx.HTTPError:
            return None

        image = usableImage(icon)
        if not image:
            return None

        return icon.headers["content-type"].split(";")[0].strip().lower(), image


def staleFavicon(fetched_at: str, now: str) -> bool:
    try:
        cachedAt = datetime.fromisoformat((fetched_at or "").replace("Z", "+00:00"))
        checkedAt = datetime.fromisoformat((now or "").replace("Z", "+00:00"))
    except ValueError:
        return True

    return (checkedAt - cachedAt).days > FAVICON_REFRESH_DAYS
