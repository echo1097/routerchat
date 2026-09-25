from __future__ import annotations

import hashlib
import re
from typing import Any

from backend.core.paths import TOS_PATH

TOS_DATE_PATTERN = re.compile(r"^\*\*Last updated:\s*(.+?)\s*\*\*$", re.MULTILINE)


#cache the parsed TOS keyed on mtime+size so the guard middleware isnt re-hashing a file on every single request
_tos_cache: dict[str, Any] = {"stamp": None, "value": None}


def load_tos() -> dict[str, Any] | None:
    try:
        stat = TOS_PATH.stat()
    except OSError:
        _tos_cache["stamp"] = None
        _tos_cache["value"] = None
        return None

    stamp = (stat.st_mtime_ns, stat.st_size)
    if _tos_cache["stamp"] == stamp:
        return _tos_cache["value"]

    try:
        raw = TOS_PATH.read_bytes()
    except OSError:
        _tos_cache["stamp"] = None
        _tos_cache["value"] = None
        return None

    markdown = raw.decode("utf-8", errors="replace")
    if not markdown.strip():
        #an empty terms file is the same as no terms file, dont let it through
        _tos_cache["stamp"] = stamp
        _tos_cache["value"] = None
        return None

    match = TOS_DATE_PATTERN.search(markdown)
    value = {
        "markdown": markdown,
        "hash": hashlib.sha256(raw).hexdigest(),
        "date": match.group(1) if match else None,
    }

    _tos_cache["stamp"] = stamp
    _tos_cache["value"] = value
    return value
