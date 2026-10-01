from __future__ import annotations

from typing import Any

UNSUPPORTED_KEYWORDS = {
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "maxItems",
}
SCHEMA_MAP_KEYWORDS = {"properties", "$defs", "definitions"}
SCHEMA_LIST_KEYWORDS = {"anyOf", "allOf", "oneOf", "prefixItems"}
SCHEMA_VALUE_KEYWORDS = {"items", "not"}
SIMPLE_MIN_ITEMS = {0, 1}


def cleanSchema(schema: Any) -> Any:
    if not isinstance(schema, dict):
        return schema

    cleaned: dict[str, Any] = {}
    for key, value in schema.items():
        if key in UNSUPPORTED_KEYWORDS:
            continue
        if key == "minItems" and value not in SIMPLE_MIN_ITEMS:
            continue

        if key in SCHEMA_MAP_KEYWORDS and isinstance(value, dict):
            cleaned[key] = {name: cleanSchema(child) for name, child in value.items()}
        elif key in SCHEMA_LIST_KEYWORDS and isinstance(value, list):
            cleaned[key] = [cleanSchema(child) for child in value]
        elif key in SCHEMA_VALUE_KEYWORDS:
            cleaned[key] = cleanSchema(value)
        else:
            cleaned[key] = value

    if cleaned.get("type") == "object" or "properties" in cleaned:
        cleaned["additionalProperties"] = False

    return cleaned
