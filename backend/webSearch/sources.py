from __future__ import annotations

import json
from typing import Any, Iterable
from urllib.parse import urlparse

WEB_SEARCH_MAX_RESULTS = 5


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
