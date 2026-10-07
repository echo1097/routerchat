import json
import sqlite3
from typing import Any

LOREBOOK_CATEGORIES = {
    "character",
    "location",
    "item",
    "event",
    "note",
    "synopsis",
    "timeline",
}


def jsonList(value: str) -> list[Any]:
    try:
        parsed = json.loads(value or "[]")
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def jsonDict(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def lorebookModelFor(story: Any) -> str:
    #blank means the author left it on "Same as global", so the story's own model keeps doing the lorebook work
    try:
        chosen = str(story["lorebook_model"] or "").strip()
    except (KeyError, IndexError, TypeError):
        chosen = ""
    return chosen or story["model"]


def normalizeLorebookCategory(category: str | None) -> str:
    value = str(category or "note").strip().lower()
    if value in {"characters", "character"}:
        return "character"
    if value in {"locations", "location"}:
        return "location"
    if value in {"items", "item"}:
        return "item"
    if value in {"events", "event"}:
        return "event"
    if value == "starting scenario":
        return "note"
    return value if value in LOREBOOK_CATEGORIES else "note"


def sanitizeLorebookAliases(category: str, aliases: Any, fallback_name: str = "") -> list[Any]:
    if category in {"note", "synopsis"}:
        return []
    if isinstance(aliases, list):
        return aliases
    return [fallback_name] if fallback_name else []


def lorebookEntrySnapshot(
    category: str,
    description: Any,
    aliases: Any,
    tags: Any,
    metadata: Any,
) -> str:
    #flatten every field the model can touch, otherwise an alias or tag change diffs to nothing and the history row renders bare
    lines = [f"category: {category}"]
    lines.extend(line for line in str(description or "").splitlines() if line.strip())
    lines.extend(f"alias: {alias}" for alias in (aliases if isinstance(aliases, list) else []))
    lines.extend(f"tag: {tag}" for tag in (tags if isinstance(tags, list) else []))
    if isinstance(metadata, dict):
        lines.extend(f"{key}: {metadata[key]}" for key in sorted(metadata))
    return "\n".join(lines)


def lorebookRowSnapshot(row: sqlite3.Row) -> str:
    return lorebookEntrySnapshot(
        normalizeLorebookCategory(row["category"]),
        row["description"],
        jsonList(row["aliases_json"]),
        jsonList(row["tags_json"]),
        jsonDict(row["metadata_json"]),
    )


def sanitizeLorebookMetadata(category: str, metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    if category == "character":
        blocked_keys = {"age", "physicalAppearance", "personality", "background"}
        return {key: value for key, value in metadata.items() if key not in blocked_keys}
    if category == "synopsis":
        chapterId = str(metadata.get("chapter_id") or "").strip()
        return {"chapter_id": chapterId} if chapterId else {}
    if category == "note":
        return {}
    return metadata


def rowToLorebookEntry(row: sqlite3.Row) -> dict[str, Any]:
    category = normalizeLorebookCategory(row["category"])
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "name": row["name"],
        "category": category,
        "description": row["description"],
        "aliases": sanitizeLorebookAliases(category, jsonList(row["aliases_json"]), row["name"]),
        "tags": jsonList(row["tags_json"]),
        "metadata": sanitizeLorebookMetadata(category, jsonDict(row["metadata_json"])),
        "revision": row["revision"],
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def lorebookContextLine(row: sqlite3.Row) -> str:
    #indent the wrapped lines, otherwise a 20 bullet timeline reads like 20 separate entries
    description = str(row["description"] or "").replace("\n", "\n  ")
    return f"- {row['name']} ({row['category']}): {description}"
