from __future__ import annotations

import json
from typing import Any


def stream_event(event_type: str, value: Any, metadata: dict[str, Any] | None = None) -> bytes:
    payload = {"type": event_type, "value": value}
    if metadata:
        payload.update({key: value for key, value in metadata.items() if value is not None})
    return (json.dumps(payload) + "\n").encode("utf-8")
