import asyncio
import json
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


OPENROUTER_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
LOREBOOK_CATEGORIES = {
    "character",
    "location",
    "item",
    "event",
    "note",
    "synopsis",
    "timeline",
}
SUMMARY_INSTRUCTION = (
    "Always create or update one synopsis named exactly after the chapter. Make it as short as "
    "possible without leaving out key events, outcomes, or continuity details."
)


@dataclass(frozen=True)
class LorebookDeps:
    get_db: Callable[[], sqlite3.Connection]
    utc_now: Callable[[], str]
    read_openrouter_key: Callable[[], str | None]
    headers_for_key: Callable[[str], dict[str, str]]
    openrouter_request_model: Callable[[str, bool], str]
    openrouter_provider_options: Callable[[], dict[str, Any] | None]
    effective_thinking_enabled: Callable[[str, bool], bool]
    enabled_reasoning_config: Callable[[str, bool, str], dict[str, Any] | None]
    model_supports_structured_output: Callable[[str], bool]
    openrouter_error_message: Callable[[int, str], str]
    normalize_usage: Callable[[dict[str, Any] | None], dict[str, Any] | None]
    fetch_generation_usage: Callable[[str, str], Any]
    stream_event: Callable[..., bytes]
    row_to_story: Callable[[sqlite3.Row], dict[str, Any]]
    insert_chapter_history_entry: Callable[..., dict[str, Any]]
    word_diff_counts: Callable[[str, str], tuple[int, int]]
    openrouter_base_url: str


def json_list(value: str) -> list[Any]:
    try:
        parsed = json.loads(value or "[]")
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def json_dict(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def format_duration(ms: float) -> str:
    seconds = max(1, round(ms / 1000))
    return f"{seconds} {'second' if seconds == 1 else 'seconds'}"


def display_model_name(model: str) -> str:
    name = str(model or "Model").split("/")[-1]
    name = name.replace(":free", "").replace("-", " ").replace("_", " ")
    return " ".join(part[:1].upper() + part[1:] for part in name.split())


def request_updates(payload: BaseModel, reject_null: bool = False) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        updates = payload.model_dump(exclude_unset=True)
    else:
        updates = payload.dict(exclude_unset=True)
    if reject_null:
        nullFields = [key for key, value in updates.items() if value is None]
        if nullFields:
            raise HTTPException(
                status_code=422,
                detail=f"Fields cannot be null: {', '.join(sorted(nullFields))}.",
            )
    return updates


class LorebookEntryRequest(BaseModel):
    name: str = Field(min_length=1)
    category: str = "note"
    description: str = ""
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    disabled: bool = False


class LorebookUpdateRequest(BaseModel):
    chapter_id: str = Field(min_length=1)


class TimelineRepairRequest(BaseModel):
    current_timeline: str = ""

class StoryArchiveLorebookEntry(BaseModel):
    id: str = Field(min_length=1)
    story_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    category: str = "note"
    description: str = ""
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    disabled: bool = False
    created_at: str = ""
    updated_at: str = ""

def lorebook_update_kind(update: dict[str, Any]) -> str:
    action = str(update.get("action") or "").lower()
    if action == "delete":
        return "lore_hide"
    return "lore_create" if action == "create" else "lore_update"


def lorebook_history_label(model_label: str, update: dict[str, Any]) -> str:
    name = str(update.get("name") or "entry").strip() or "entry"
    action = str(update.get("action") or "").lower()
    #nothing is deleted here, disabled just drops it from context, and the wording matches the include/exclude toggle that undoes it
    if action == "delete":
        return f"{model_label} excluded {name} from context"
    if name.casefold() == "timeline":
        return f"{model_label} updated Timeline"

    action = "added" if action == "create" else "updated"
    destination = "in" if action == "updated" else "to"
    return f"{model_label} {action} {name} {destination} Lorebook"


def lorebook_run_history_actions(
    model_label: str,
    applied: list[dict[str, Any]],
    duration_ms: float,
    cost: float | None = None,
) -> list[dict[str, Any]]:
    #a quiet run is still a run, so both endings get a line instead of pretending nothing happened
    actions = [
        {
            "label": lorebook_history_label(model_label, update),
            "kind": lorebook_update_kind(update),
            "words_added": update.get("wordsAdded"),
            "words_removed": update.get("wordsRemoved"),
            "cost": None,
        }
        for update in applied
    ]
    if applied:
        summary = f"{model_label} finished editing Lorebook after {format_duration(duration_ms)}"
        #run totals, same idea as the cost subtotal on the run header. hides sit out because nothing was written, the text just left context
        changed = [update for update in applied if lorebook_update_kind(update) != "lore_hide"]
        totalAdded = sum(int(update.get("wordsAdded") or 0) for update in changed)
        totalRemoved = sum(int(update.get("wordsRemoved") or 0) for update in changed)
    else:
        summary = f"{model_label} found no Lorebook changes after {format_duration(duration_ms)}"
        totalAdded = None
        totalRemoved = None

    #one api call means one cost, so it rides on the closing line instead of being faked across every entry
    actions.append(
        {
            "label": summary,
            "kind": "lore_summary",
            "words_added": totalAdded,
            "words_removed": totalRemoved,
            "cost": cost,
        }
    )
    return actions


def normalize_lorebook_category(category: str | None) -> str:
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


TIMELINE_BULLET_MARKERS = ("-", "*", "•")
INLINE_TIMELINE_BULLET = re.compile(r"\s+[-*•]\s+")
SENTENCE_ENDINGS = ".!?\"')"


def split_crammed_timeline_bullets(line: str) -> list[str]:
    body = line
    for marker in TIMELINE_BULLET_MARKERS:
        body = body.removeprefix(marker)
    body = body.strip()

    separators = list(INLINE_TIMELINE_BULLET.finditer(body))
    if not separators:
        return []

    #a bullet boundary reads like the end of a sentence, a hyphen sitting inside one does not, so a
    #lone separator has to earn it, two or more is already too repetitive to be ordinary prose
    endsSentence = all(body[separator.start() - 1] in SENTENCE_ENDINGS for separator in separators)
    if not endsSentence and len(separators) < 2:
        return []

    parts = [part.strip() for part in INLINE_TIMELINE_BULLET.split(body)]
    parts = [part for part in parts if part]
    if len(parts) < 2:
        return []

    #a real event is a sentence, so any one or two word fragment means we chopped something like a
    #date range in half rather than finding actual bullets, and we leave the line alone
    if any(len(part.split()) < 3 for part in parts):
        return []
    return parts


def normalize_timeline_description(description: str) -> str:
    rawLines = [line.strip() for line in str(description or "").splitlines()]
    rawLines = [line for line in rawLines if line]

    #some models ignore the newline instruction and cram every bullet onto one line, only worth
    #unpicking when nothing split on its own, otherwise we would go hunting inside good output
    if len(rawLines) == 1:
        crammedBullets = split_crammed_timeline_bullets(rawLines[0])
        if crammedBullets:
            rawLines = crammedBullets

    lines = []
    for value in rawLines:
        if value.startswith("- "):
            lines.append(value)
            continue
        lines.append(f"- {value.removeprefix('-').removeprefix('*').strip()}")
    return "\n".join(lines)


def sanitize_lorebook_aliases(category: str, aliases: Any, fallback_name: str = "") -> list[Any]:
    if category in {"note", "synopsis"}:
        return []
    if isinstance(aliases, list):
        return aliases
    return [fallback_name] if fallback_name else []


def lorebook_entry_snapshot(
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


def lorebook_row_snapshot(row: sqlite3.Row) -> str:
    return lorebook_entry_snapshot(
        normalize_lorebook_category(row["category"]),
        row["description"],
        json_list(row["aliases_json"]),
        json_list(row["tags_json"]),
        json_dict(row["metadata_json"]),
    )


def sanitize_lorebook_metadata(category: str, metadata: Any) -> dict[str, Any]:
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


def lorebook_summary_chapter_id(row: sqlite3.Row) -> str:
    if normalize_lorebook_category(row["category"]) != "synopsis":
        return ""
    return str(json_dict(row["metadata_json"]).get("chapter_id") or "").strip()


def rename_linked_chapter_summaries(
    conn: sqlite3.Connection,
    storyId: str,
    chapterId: str,
    chapterTitle: str,
    now: str,
) -> None:
    summaryRows = conn.execute(
        "SELECT * FROM lorebook_entries WHERE story_id = ? AND category = 'synopsis'",
        (storyId,),
    ).fetchall()
    for summaryRow in summaryRows:
        if lorebook_summary_chapter_id(summaryRow) != chapterId:
            continue
        conn.execute(
            "UPDATE lorebook_entries SET name = ?, updated_at = ? WHERE id = ?",
            (chapterTitle, now, summaryRow["id"]),
        )


def delete_linked_chapter_summaries(
    conn: sqlite3.Connection,
    storyId: str,
    chapterId: str,
) -> None:
    summaryRows = conn.execute(
        "SELECT * FROM lorebook_entries WHERE story_id = ? AND category = 'synopsis'",
        (storyId,),
    ).fetchall()
    linkedIds = [
        row["id"]
        for row in summaryRows
        if lorebook_summary_chapter_id(row) == chapterId
    ]
    for entryId in linkedIds:
        conn.execute("DELETE FROM lorebook_entries WHERE id = ?", (entryId,))


def find_enabled_chapter_summary(
    conn: sqlite3.Connection,
    story_id: str,
    chapter_id: str,
    chapter_title: str,
) -> sqlite3.Row | None:
    rows = conn.execute(
        """
        SELECT * FROM lorebook_entries
        WHERE story_id = ? AND category = 'synopsis' AND disabled = 0
        ORDER BY updated_at DESC, created_at DESC
        """,
        (story_id,),
    ).fetchall()

    linked = [row for row in rows if lorebook_summary_chapter_id(row) == chapter_id]
    if linked:
        return linked[0]

    #old summaries shipped without a chapter id, so claim one only when the title match is clear
    legacy = [
        row
        for row in rows
        if not lorebook_summary_chapter_id(row)
        and str(row["name"] or "").casefold() == chapter_title.casefold()
    ]
    return legacy[0] if len(legacy) == 1 else None


def normalize_required_summary_update(
    updates: list[Any], chapter: sqlite3.Row
) -> list[dict[str, Any]]:
    validUpdates = [update for update in updates if isinstance(update, dict)]
    summaries = [
        update
        for update in validUpdates
        if normalize_lorebook_category(update.get("category")) == "synopsis"
    ]
    if len(summaries) != 1:
        raise ValueError("The lorebook update must contain exactly one chapter summary.")

    summary = summaries[0]
    description = str(summary.get("description") or "").strip()
    if not description or str(summary.get("action") or "create").lower() == "delete":
        raise ValueError("The lorebook update returned an invalid chapter summary.")

    normalizedSummary = {
        **summary,
        "action": "update",
        "name": str(chapter["title"] or "New chapter").strip() or "New chapter",
        "category": "synopsis",
        "description": description,
        "aliases": [],
        "tags": [],
        "metadata": {"chapter_id": str(chapter["id"])},
    }
    ordinaryUpdates = [update for update in validUpdates if update is not summary]
    return [*ordinaryUpdates, normalizedSummary]


def strip_json_fence(value: str) -> str:
    text = value.strip()
    if not text.startswith("```"):
        return text

    lines = text.splitlines()
    if len(lines) < 2:
        return text
    if lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return "\n".join(lines[1:]).strip()


def first_json_object(value: str) -> str:
    start = value.find("{")
    if start < 0:
        raise ValueError("No JSON object found in lorebook output.")

    depth = 0
    inString = False
    escapeNext = False
    for index, char in enumerate(value[start:], start):
        if escapeNext:
            escapeNext = False
            continue
        if char == "\\" and inString:
            escapeNext = True
            continue
        if char == "\"":
            inString = not inString
            continue
        if inString:
            continue
        if char == "{":
            depth += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                return value[start:index + 1]

    raise ValueError("Unclosed JSON object in lorebook output.")

def timeline_repair_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "timeline_repair",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "timeline": {"type": "string", "minLength": 1},
                },
                "required": ["timeline"],
            },
        },
    }

def parse_lorebook_json(raw_output: str) -> dict[str, Any]:
    parse_errors: list[str] = []
    candidates = [raw_output.strip(), strip_json_fence(raw_output)]

    try:
        candidates.append(first_json_object(candidates[-1]))
    except ValueError as exc:
        parse_errors.append(str(exc))

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError as exc:
            parse_errors.append(str(exc))
            continue
        if isinstance(parsed, dict):
            return parsed
        parse_errors.append("Lorebook output JSON was not an object.")

    raise ValueError("; ".join(parse_errors) or "Could not parse lorebook JSON.")


def parse_timeline_repair(raw_output: str) -> str:
    parsed = parse_lorebook_json(raw_output)
    timeline = parsed.get("timeline")
    if not isinstance(timeline, str) or not timeline.strip():
        raise ValueError("The model returned an empty timeline.")

    normalized = normalize_timeline_description(timeline)
    if not normalized:
        raise ValueError("The model returned an empty timeline.")
    return normalized

def row_to_lorebook_entry(row: sqlite3.Row) -> dict[str, Any]:
    category = normalize_lorebook_category(row["category"])
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "name": row["name"],
        "category": category,
        "description": row["description"],
        "aliases": sanitize_lorebook_aliases(category, json_list(row["aliases_json"]), row["name"]),
        "tags": json_list(row["tags_json"]),
        "metadata": sanitize_lorebook_metadata(category, json_dict(row["metadata_json"])),
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def lorebook_context_line(row: sqlite3.Row) -> str:
    #indent the wrapped lines, otherwise a 20 bullet timeline reads like 20 separate entries
    description = str(row["description"] or "").replace("\n", "\n  ")
    return f"- {row['name']} ({row['category']}): {description}"

def apply_lorebook_updates(
    deps: LorebookDeps,
    conn: sqlite3.Connection,
    story_id: str,
    updates: list[dict[str, Any]],
    now: str,
) -> list[dict[str, Any]]:
    applied: list[dict[str, Any]] = []
    for update in updates:
        action = str(update.get("action") or "create").lower()
        name = str(update.get("name") or "").strip()
        category = normalize_lorebook_category(update.get("category"))
        if category == "timeline":
            name = "Timeline"
            #everything timeline shaped is an update, except a delete which gets refused below
            if action != "delete":
                action = "update"
        if not name:
            continue
        description = str(update.get("description") or "").strip()
        if category == "timeline":
            description = normalize_timeline_description(description)
        aliases = sanitize_lorebook_aliases(category, update.get("aliases"), name)
        tags = update.get("tags") if isinstance(update.get("tags"), list) else []
        metadata = sanitize_lorebook_metadata(category, update.get("metadata"))

        #disabled = 0 on every lookup, a hidden entry has to stay untouched by automatic updates
        if category == "timeline":
            existing = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ? AND lower(name) = lower('Timeline') AND disabled = 0
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()
        elif category == "synopsis" and metadata.get("chapter_id"):
            existing = find_enabled_chapter_summary(
                conn,
                story_id,
                str(metadata["chapter_id"]),
                name,
            )
        else:
            existing = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ? AND lower(name) = lower(?) AND disabled = 0
                LIMIT 1
                """,
                (story_id, name),
            ).fetchone()

        if action == "delete":
            #timeline is a singleton the model doesnt get to retire
            if not existing or category == "timeline" or name.casefold() == "timeline":
                continue
            conn.execute(
                "UPDATE lorebook_entries SET disabled = 1, updated_at = ? WHERE id = ?",
                (now, existing["id"]),
            )
            wordsAdded, wordsRemoved = deps.word_diff_counts(
                lorebook_row_snapshot(existing), ""
            )
            applied.append(
                {
                    "action": "delete",
                    "id": existing["id"],
                    "name": name,
                    "wordsAdded": wordsAdded,
                    "wordsRemoved": wordsRemoved,
                }
            )
            continue

        #model often says create for something it already knows about, treat that as the update it meant
        if action == "create" and existing and description:
            action = "update"

        if action == "update" and existing:
            next_description = description or existing["description"]
            #empty means no opinion, not "wipe it". the system prompt hands the model a template containing aliases:[] tags:[] metadata:{} so it echoes those back on every single update whether it meant anything by them or not
            next_aliases = sanitize_lorebook_aliases(
                category,
                update["aliases"]
                if isinstance(update.get("aliases"), list) and update["aliases"]
                else json_list(existing["aliases_json"]),
                name,
            )
            next_tags = (
                update["tags"]
                if isinstance(update.get("tags"), list) and update["tags"]
                else json_list(existing["tags_json"])
            )
            next_metadata = sanitize_lorebook_metadata(
                category,
                update["metadata"]
                if isinstance(update.get("metadata"), dict) and update["metadata"]
                else json_dict(existing["metadata_json"]),
            )

            beforeSnapshot = lorebook_row_snapshot(existing)
            afterSnapshot = lorebook_entry_snapshot(
                category, next_description, next_aliases, next_tags, next_metadata
            )
            nameChanged = str(existing["name"]) != name
            #an update that changes nothing is not an edit, dont write it and dont claim it in the history
            if beforeSnapshot == afterSnapshot and not nameChanged:
                continue

            conn.execute(
                """
                UPDATE lorebook_entries
                SET name = ?, category = ?, description = ?, aliases_json = ?, tags_json = ?,
                    metadata_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    name,
                    category,
                    next_description,
                    json.dumps(next_aliases),
                    json.dumps(next_tags),
                    json.dumps(next_metadata),
                    now,
                    existing["id"],
                ),
            )
            wordsAdded, wordsRemoved = deps.word_diff_counts(beforeSnapshot, afterSnapshot)
            applied.append(
                {
                    "action": "update",
                    "id": existing["id"],
                    "name": name,
                    "wordsAdded": wordsAdded,
                    "wordsRemoved": wordsRemoved,
                }
            )
            continue

        if existing:
            continue

        entry_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO lorebook_entries (
              id, story_id, name, category, description, aliases_json,
              tags_json, metadata_json, disabled, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?,  ?, 0, ?, ?)
            """,
            (
                entry_id,
                story_id,
                name,
                category,
                description,
                json.dumps(aliases),
                json.dumps(tags),
                json.dumps(metadata),
                now,
                now,
            ),
        )
        wordsAdded, wordsRemoved = deps.word_diff_counts(
            "", lorebook_entry_snapshot(category, description, aliases, tags, metadata)
        )
        applied.append(
            {
                "action": "create",
                "id": entry_id,
                "name": name,
                "wordsAdded": wordsAdded,
                "wordsRemoved": wordsRemoved,
            }
        )
    return applied


LOREBOOK_UPDATE_SYSTEM_PROMPT = (
    "Extract important durable lore from new prose. Return strict JSON only: "
    "{\"updates\":[{\"action\":\"create|update|delete\",\"name\":\"\","
    "\"category\":\"character|location|item|event|note|synopsis|timeline\","
    "\"description\":\"\",\"aliases\":[],\"tags\":[],\"metadata\":{}}]}. "
    "Use action \"update\" for any name already present in existing_lorebook, and "
    "when the prose contradicts a stored detail, correct that entry so it matches "
    "the prose. "
    "If a previously-stored fact is no longer supported by the prose, note it for "
    "removal with action \"delete\". Only remove an entry when the prose actively "
    "contradicts it or explicitly retires it. Never remove an entry merely because "
    "this prose does not mention it. Most entries in existing_lorebook describe "
    "earlier parts of the story and must be left alone. "
    "The aliases array is only for nicknames, shortened names, titles used as "
    "names, or alternate names explicitly used in the story to refer to this "
    "entry. Do not put jobs, roles, species, traits, descriptions, "
    "relationships, or categories in aliases. For note and synopsis entries, "
    "aliases must be empty. Put character details like age, detailed physical "
    "appearance, personality, and background into description instead of "
    "metadata fields. "
    f"{SUMMARY_INSTRUCTION} Return exactly one synopsis update for chapter, even when an existing "
    "summary needs no factual changes. "
    "For story chronology, create or update exactly one timeline entry named "
    "\"Timeline\" with category \"timeline\". Its description must be a "
    "chronological Markdown bullet list. Merge new events into the existing "
    "timeline instead of duplicating bullets. Keep each entry concise and "
    "information-dense. Do not copy prose style from the story. Prefer short "
    "factual summaries over long paragraphs. Preserve important concrete "
    "details, but omit transient action, mood, and wording that does not "
    "matter for continuity. Timeline bullets should be brief, one event per "
    "bullet. Add only new durable events or necessary corrections."
)


def lorebook_update_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "lorebook_update",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "updates": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "action": {
                                    "type": "string",
                                    "enum": ["create", "update", "delete"],
                                },
                                "name": {"type": "string", "minLength": 1},
                                "category": {
                                    "type": "string",
                                    "enum": sorted(LOREBOOK_CATEGORIES),
                                },
                                "description": {"type": "string"},
                                "aliases": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                },
                                "tags": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                },
                                "metadata": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "properties": {},
                                },
                            },
                            "required": [
                                "action",
                                "name",
                                "category",
                                "description",
                                "aliases",
                                "tags",
                                "metadata",
                            ],
                        },
                    },
                },
                "required": ["updates"],
            },
        },
    }


#used to be one blocking post, now it streams so write mode can show the thinking while it works.
#yields {"type": "reasoning"} chunks as they land, one {"type": "content"} the moment json generation
#starts, and exactly one {"type": "result"} at the end
async def run_lorebook_update(
    deps: LorebookDeps,
    story_id: str,
    chapter_id: str,
    source_text: str,
    model: str,
    max_tokens: int,
    generation_row_id: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    api_key = deps.read_openrouter_key()
    if not api_key or not source_text.strip():
        yield {"type": "result", "value": {"applied": [], "skipped": True}}
        return

    with deps.get_db() as conn:
        story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        chapter = conn.execute(
            "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
            (chapter_id, story_id),
        ).fetchone()
        lorebook = conn.execute(
            "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY updated_at DESC",
            (story_id,),
        ).fetchall()

    current_lore = "\n".join(
        lorebook_context_line(row)
        for row in lorebook
        if not bool(row["disabled"])
    )
    prompt = {
        "story": deps.row_to_story(story),
        "chapter": {"id": chapter["id"], "title": chapter["title"]},
        "existing_lorebook": current_lore,
        "new_prose": source_text,
    }
    messages = [
        {"role": "system", "content": LOREBOOK_UPDATE_SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(prompt)},
    ]
    body: dict[str, Any] = {
        "model": deps.openrouter_request_model(model, False),
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "stream": True,
    }
    providerOptions = deps.openrouter_provider_options()
    if providerOptions:
        body["provider"] = providerOptions

    thinking_enabled = deps.effective_thinking_enabled(model, True)
    reasoning_config = deps.enabled_reasoning_config(model, True, story["reasoning_effort"])
    if reasoning_config:
        body["reasoning"] = reasoning_config
    if deps.model_supports_structured_output(model):
        body["response_format"] = lorebook_update_response_format()

    raw_output = ""
    error_text: str | None = None
    applied: list[dict[str, Any]] = []
    usage: dict[str, Any] | None = None
    lorebook_generation_id: str | None = None
    generated_text: list[str] = []
    finish_reason: str | None = None
    receivedDone = False
    content_started = False
    try:
        async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client:
            async with client.stream(
                "POST",
                f"{deps.openrouter_base_url}/chat/completions",
                headers={**deps.headers_for_key(api_key), "Content-Type": "application/json"},
                json=body,
            ) as response:
                if response.status_code >= 400:
                    raw_error = (await response.aread()).decode("utf-8", errors="replace")
                    error_text = deps.openrouter_error_message(response.status_code, raw_error)
                else:
                    lorebook_generation_id = response.headers.get("X-Generation-Id")
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            receivedDone = True
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue

                        lorebook_generation_id = lorebook_generation_id or chunk.get("id")
                        next_usage = deps.normalize_usage(chunk.get("usage"))
                        if next_usage:
                            usage = next_usage

                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finish_reason = choice.get("finish_reason") or finish_reason
                        delta = choice.get("delta") or {}
                        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                        if reasoning and thinking_enabled:
                            yield {"type": "reasoning", "value": str(reasoning)}
                        content = delta.get("content")
                        if content:
                            if not content_started:
                                content_started = True
                                yield {"type": "content"}
                            generated_text.append(str(content))

        raw_output = "".join(generated_text)
        #a cut off response is never valid json anyway, so say why instead of letting the parser guess
        if finish_reason == "length":
            error_text = "The lorebook update hit the model token limit before it finished."
        elif not receivedDone and not error_text:
            error_text = "The lorebook update ended before the provider completed the stream."
        elif not error_text:
            parsed = parse_lorebook_json(raw_output)
            updates = parsed.get("updates") if isinstance(parsed, dict) else []
            if not isinstance(updates, list):
                updates = []
            updates = normalize_required_summary_update(updates, chapter)
            with deps.get_db() as conn:
                applied = apply_lorebook_updates(
                    deps, conn, story_id, updates, deps.utc_now()
                )
    except Exception as exc:  # noqa: BLE001
        error_text = str(exc)

    #/generation is the only place cost reliably turns up, and this sits outside the try so a usage hiccup cant throw away updates we already committed
    if lorebook_generation_id and not (usage or {}).get("cost"):
        try:
            fetched = await deps.fetch_generation_usage(api_key, lorebook_generation_id)
            if fetched:
                usage = {**(usage or {}), **fetched}
        except Exception:  # noqa: BLE001
            pass

    with deps.get_db() as conn:
        conn.execute(
            """
            INSERT INTO lorebook_update_runs (
              id, story_id, chapter_id, generation_id, openrouter_generation_id,
              raw_output, applied_updates_json, cost, error, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                story_id,
                chapter_id,
                generation_row_id,
                lorebook_generation_id,
                raw_output or "",
                json.dumps(applied),
                (usage or {}).get("cost"),
                error_text,
                deps.utc_now(),
            ),
        )

    yield {
        "type": "result",
        "value": {"applied": applied, "error": error_text, "cost": (usage or {}).get("cost")},
    }


#the manual and streaming lorebook endpoints both need the same history rows and the same fresh entry list
def finalize_lorebook_update(
    deps: LorebookDeps,
    story_id: str,
    chapter_id: str,
    story: sqlite3.Row,
    result: dict[str, Any],
    duration_ms: float,
) -> dict[str, Any]:
    applied = result.get("applied") or []
    actions = lorebook_run_history_actions(
        display_model_name(story["model"]), applied, duration_ms, result.get("cost")
    )
    history_run_id = str(uuid.uuid4())
    history_entries: list[dict[str, Any]] = []

    with deps.get_db() as conn:
        for action in actions:
            history_entries.append(
                deps.insert_chapter_history_entry(
                    conn,
                    story_id=story_id,
                    chapter_id=chapter_id,
                    run_id=history_run_id,
                    label=action["label"],
                    detail="",
                    now=deps.utc_now(),
                    kind=action["kind"],
                    words_added=action["words_added"],
                    words_removed=action["words_removed"],
                    cost=action["cost"],
                )
            )

        rows = conn.execute(
            """
            SELECT * FROM lorebook_entries
            WHERE story_id = ?
            ORDER BY updated_at DESC, created_at DESC
            """,
            (story_id,),
        ).fetchall()

    return {
        "applied": applied,
        "error": result.get("error"),
        "skipped": bool(result.get("skipped")),
        "entries": [row_to_lorebook_entry(row) for row in rows],
        "history": history_entries,
    }

def create_lorebook_router(deps: LorebookDeps) -> APIRouter:
    router = APIRouter()

    async def stream_timeline_repair(
        story_id: str,
        story: sqlite3.Row,
        visible_chapters: list[sqlite3.Row],
        timeline_row: sqlite3.Row | None,
        current_timeline: str,
    ) -> AsyncIterator[bytes]:
        startedAt = time.perf_counter()
        apiKey = deps.read_openrouter_key()
        if not apiKey:
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

        timelineSnapshot = (
            {
                "id": timeline_row["id"],
                "updated_at": timeline_row["updated_at"],
                "description": timeline_row["description"],
            }
            if timeline_row
            else None
        )
        chapterContext = [
            {
                "title": chapter["title"],
                "content": chapter["content"] or "",
            }
            for chapter in visible_chapters
        ]
        prompt = {
            "story": {
                "title": story["title"],
                "author": story["author"],
                "language": story["language"],
                "synopsis": story["synopsis"],
            },
            "current_timeline": current_timeline,
            "visible_chapters": chapterContext,
        }

        #same deal as the lorebook repair, the author's story instructions ride along so bullet style rules land
        authorInstructions = str(story["system_prompt"] or "").strip()
        if authorInstructions:
            prompt["author_instructions"] = authorInstructions

        messages = [
            {
                "role": "system",
                "content": (
                    "Rebuild the complete story timeline from every visible chapter supplied. "
                    "The current timeline is context only: keep useful chronology and wording when "
                    "it is supported by the chapters, but correct it whenever the story disagrees. "
                    "Include every durable event needed to understand story chronology, ordered "
                    "from earliest to latest. Use one concise factual event per Markdown bullet. "
                    "Do not invent events, repeat bullets, copy the prose style, or include facts "
                    "that are not chronological events. When author_instructions is present it "
                    "holds the story author's own instructions for this story: follow the parts "
                    "that apply to the timeline, such as bullet length, detail, and language, "
                    "ignore the parts about writing prose, and never let it override these rules "
                    "or the JSON shape. Return strict JSON only in this shape: "
                    "{\"timeline\":\"- event one\\n- event two\"}."
                ),
            },
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
        ]
        body: dict[str, Any] = {
            "model": deps.openrouter_request_model(story["model"], False),
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": story["max_tokens"],
            "stream": True,
        }
        providerOptions = deps.openrouter_provider_options()
        if providerOptions:
            body["provider"] = providerOptions

        effectiveThinkingEnabled = deps.effective_thinking_enabled(story["model"], True)
        reasoningConfig = deps.enabled_reasoning_config(
            story["model"], True, story["reasoning_effort"]
        )
        if reasoningConfig:
            body["reasoning"] = reasoningConfig
        if deps.model_supports_structured_output(story["model"]):
            body["response_format"] = timeline_repair_response_format()

        generatedText: list[str] = []
        finishReason: str | None = None
        generationId: str | None = None
        usage: dict[str, Any] | None = None
        receivedDone = False
        announcedWriting = False

        yield deps.stream_event("status", "rebuilding")

        try:
            async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    f"{deps.openrouter_base_url}/chat/completions",
                    headers={**deps.headers_for_key(apiKey), "Content-Type": "application/json"},
                    json=body,
                ) as response:
                    if response.status_code >= 400:
                        rawError = (await response.aread()).decode("utf-8", errors="replace")
                        message = deps.openrouter_error_message(response.status_code, rawError)
                        yield deps.stream_event(
                            "error",
                            {"code": "timeline_repair_provider_error", "message": message},
                        )
                        return

                    generationId = response.headers.get("X-Generation-Id") or generationId
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            receivedDone = True
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue

                        generationId = generationId or chunk.get("id")
                        nextUsage = deps.normalize_usage(chunk.get("usage"))
                        if nextUsage:
                            usage = nextUsage
                            continue

                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finishReason = choice.get("finish_reason") or finishReason
                        delta = choice.get("delta") or {}
                        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                        if reasoning and effectiveThinkingEnabled:
                            yield deps.stream_event("reasoning", str(reasoning))
                        content = delta.get("content")
                        if content:
                            #first real content means the thinking is done and the timeline is being written
                            if not announcedWriting:
                                announcedWriting = True
                                yield deps.stream_event("status", "writing")
                            generatedText.append(str(content))

            if generationId:
                try:
                    generationUsage = await deps.fetch_generation_usage(apiKey, generationId)
                    if generationUsage:
                        usage = {**(usage or {}), **generationUsage}
                except Exception:  # noqa: BLE001
                    pass
            if usage:
                yield deps.stream_event(
                    "usage",
                    {"generation_id": generationId, "model": story["model"], **usage},
                )

            if not receivedDone:
                yield deps.stream_event(
                    "error",
                    {
                        "code": "timeline_repair_incomplete",
                        "message": "Timeline repair ended before the provider completed the stream.",
                    },
                )
                return
            if finishReason == "length":
                yield deps.stream_event(
                    "error",
                    {
                        "code": "timeline_repair_truncated",
                        "message": "The rebuilt timeline hit the model token limit before it finished.",
                    },
                )
                return

            try:
                nextTimeline = parse_timeline_repair("".join(generatedText))
            except ValueError as exc:
                yield deps.stream_event(
                    "error",
                    {"code": "timeline_repair_invalid", "message": str(exc)},
                )
                return

            now = deps.utc_now()
            with deps.get_db() as conn:
                conn.execute("BEGIN IMMEDIATE")
                currentRow = conn.execute(
                    """
                    SELECT * FROM lorebook_entries
                    WHERE story_id = ?
                      AND disabled = 0
                      AND (category = 'timeline' OR lower(name) = lower('Timeline'))
                    ORDER BY updated_at DESC, created_at DESC
                    LIMIT 1
                    """,
                    (story_id,),
                ).fetchone()

                if timelineSnapshot is None:
                    timelineChanged = currentRow is not None
                else:
                    timelineChanged = (
                        currentRow is None
                        or currentRow["id"] != timelineSnapshot["id"]
                        or currentRow["updated_at"] != timelineSnapshot["updated_at"]
                        or currentRow["description"] != timelineSnapshot["description"]
                    )
                if timelineChanged:
                    conn.rollback()
                    yield deps.stream_event(
                        "error",
                        {
                            "code": "timeline_repair_conflict",
                            "message": "The timeline changed while it was being rebuilt. Nothing was replaced.",
                        },
                    )
                    return

                if currentRow:
                    conn.execute(
                        """
                        UPDATE lorebook_entries
                        SET name = 'Timeline', category = 'timeline', description = ?, updated_at = ?
                        WHERE id = ? AND story_id = ?
                        """,
                        (nextTimeline, now, currentRow["id"], story_id),
                    )
                    entryId = currentRow["id"]
                else:
                    entryId = str(uuid.uuid4())
                    conn.execute(
                        """
                        INSERT INTO lorebook_entries (
                          id, story_id, name, category, description, aliases_json,
                          tags_json, metadata_json, disabled, created_at, updated_at
                        )
                        VALUES (?, ?, 'Timeline', 'timeline', ?, ?, '[]', '{}', 0, ?, ?)
                        """,
                        (
                            entryId,
                            story_id,
                            nextTimeline,
                            json.dumps(["Timeline"]),
                            now,
                            now,
                        ),
                    )
                conn.execute("UPDATE stories SET updated_at = ? WHERE id = ?", (now, story_id))
                savedRow = conn.execute(
                    "SELECT * FROM lorebook_entries WHERE id = ?",
                    (entryId,),
                ).fetchone()

            durationMs = (time.perf_counter() - startedAt) * 1000
            yield deps.stream_event(
                "complete",
                {
                    "entry": row_to_lorebook_entry(savedRow),
                    "duration_ms": durationMs,
                },
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            yield deps.stream_event(
                "error",
                {
                    "code": "timeline_repair_failed",
                    "message": f"RouterChat error: {exc}",
                },
            )

    @router.get("/api/stories/{story_id}/lorebook")
    def list_lorebook_entries(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            rows = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ?
                ORDER BY updated_at DESC, created_at DESC
                """,
                (story_id,),
            ).fetchall()
        return {"entries": [row_to_lorebook_entry(row) for row in rows]}

    @router.post("/api/stories/{story_id}/lorebook/timeline/repair/stream")
    async def repair_story_timeline(
        story_id: str, payload: TimelineRepairRequest
    ) -> StreamingResponse:
        if not deps.read_openrouter_key():
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            visibleChapters = conn.execute(
                """
                SELECT * FROM chapters
                WHERE story_id = ? AND disabled = 0
                ORDER BY order_index ASC, created_at ASC
                """,
                (story_id,),
            ).fetchall()
            timelineRow = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ?
                  AND disabled = 0
                  AND (category = 'timeline' OR lower(name) = lower('Timeline'))
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()

        if not any(str(chapter["content"] or "").strip() for chapter in visibleChapters):
            raise HTTPException(
                status_code=422,
                detail="Add story content to a chapter that is visible in context first.",
            )

        return StreamingResponse(
            stream_timeline_repair(
                story_id,
                story,
                visibleChapters,
                timelineRow,
                payload.current_timeline,
            ),
            media_type="application/x-ndjson; charset=utf-8",
            headers={"Cache-Control": "no-store"},
        )

    @router.post("/api/stories/{story_id}/lorebook/update")
    async def update_lorebook_from_chapter(
        story_id: str, payload: LorebookUpdateRequest
    ) -> dict[str, Any]:
        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (payload.chapter_id, story_id),
            ).fetchone()
            if not chapter:
                raise HTTPException(status_code=404, detail="Chapter not found.")

        source_text = chapter["content"] or ""
        if not source_text.strip():
            return {"applied": [], "skipped": True, "entries": [], "history": []}

        started_at = time.perf_counter()
        result: dict[str, Any] = {}
        #this one has nowhere to put reasoning, the streaming sibling endpoint is the one write mode calls
        async for event in run_lorebook_update(
            deps,
            story_id,
            payload.chapter_id,
            source_text,
            story["model"],
            story["max_tokens"],
        ):
            if event["type"] == "result":
                result = event["value"]

        durationMs = (time.perf_counter() - started_at) * 1000
        return finalize_lorebook_update(
            deps, story_id, payload.chapter_id, story, result, durationMs
        )

    @router.post("/api/stories/{story_id}/lorebook")
    def create_lorebook_entry(story_id: str, payload: LorebookEntryRequest) -> dict[str, Any]:
        now = deps.utc_now()
        entry_id = str(uuid.uuid4())
        category = normalize_lorebook_category(payload.category)
        metadata = sanitize_lorebook_metadata(category, payload.metadata)
        entryName = payload.name.strip()
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            existingSummary = None
            if category == "synopsis" and metadata.get("chapter_id"):
                chapter = conn.execute(
                    "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                    (metadata["chapter_id"], story_id),
                ).fetchone()
                if not chapter:
                    raise HTTPException(status_code=422, detail="The summary chapter was not found.")
                entryName = str(chapter["title"])
                existingSummary = find_enabled_chapter_summary(
                    conn,
                    story_id,
                    str(chapter["id"]),
                    entryName,
                )

            if existingSummary:
                entry_id = str(existingSummary["id"])
                conn.execute(
                    """
                    UPDATE lorebook_entries
                    SET name = ?, description = ?, aliases_json = '[]', tags_json = '[]',
                        metadata_json = ?, disabled = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        entryName,
                        payload.description,
                        json.dumps(metadata),
                        int(payload.disabled),
                        now,
                        entry_id,
                    ),
                )
                row = conn.execute(
                    "SELECT * FROM lorebook_entries WHERE id = ?",
                    (entry_id,),
                ).fetchone()
                return {"entry": row_to_lorebook_entry(row)}

            conn.execute(
                """
                INSERT INTO lorebook_entries (
                  id, story_id, name, category, description, aliases_json,
                  tags_json, metadata_json, disabled, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry_id,
                    story_id,
                    entryName,
                    category,
                    (
                        normalize_timeline_description(payload.description)
                        if category == "timeline"
                        else payload.description
                    ),
                    json.dumps(sanitize_lorebook_aliases(category, payload.aliases, entryName)),
                    json.dumps(payload.tags),
                    json.dumps(metadata),
                    int(payload.disabled),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM lorebook_entries WHERE id = ?", (entry_id,)).fetchone()
        return {"entry": row_to_lorebook_entry(row)}

    @router.patch("/api/stories/{story_id}/lorebook/{entry_id}")
    def update_lorebook_entry(
        story_id: str, entry_id: str, payload: LorebookEntryRequest
    ) -> dict[str, Any]:
        now = deps.utc_now()
        category = normalize_lorebook_category(payload.category)
        with deps.get_db() as conn:
            entry = conn.execute(
                "SELECT * FROM lorebook_entries WHERE id = ? AND story_id = ?",
                (entry_id, story_id),
            ).fetchone()
            if not entry:
                raise HTTPException(status_code=404, detail="Lorebook entry not found.")
            metadata = sanitize_lorebook_metadata(category, payload.metadata)
            entryName = payload.name.strip()
            if category == "synopsis":
                chapterId = str(metadata.get("chapter_id") or "").strip()
                if not chapterId and normalize_lorebook_category(entry["category"]) == "synopsis":
                    chapterId = lorebook_summary_chapter_id(entry)
                    metadata = {"chapter_id": chapterId} if chapterId else {}
                if chapterId:
                    chapter = conn.execute(
                        "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                        (chapterId, story_id),
                    ).fetchone()
                    if not chapter:
                        raise HTTPException(status_code=422, detail="The summary chapter was not found.")
                    entryName = str(chapter["title"])
            conn.execute(
                """
                UPDATE lorebook_entries
                SET name = ?, category = ?, description = ?, aliases_json = ?,
                    tags_json = ?, metadata_json = ?, disabled = ?, updated_at = ?
                WHERE id = ? AND story_id = ?
                """,
                (
                    entryName,
                    category,
                    (
                        normalize_timeline_description(payload.description)
                        if category == "timeline"
                        else payload.description
                    ),
                    json.dumps(sanitize_lorebook_aliases(category, payload.aliases, entryName)),
                    json.dumps(payload.tags),
                    json.dumps(metadata),
                    int(payload.disabled),
                    now,
                    entry_id,
                    story_id,
                ),
            )
            row = conn.execute("SELECT * FROM lorebook_entries WHERE id = ?", (entry_id,)).fetchone()
        return {"entry": row_to_lorebook_entry(row)}

    @router.delete("/api/stories/{story_id}/lorebook/{entry_id}")
    def delete_lorebook_entry(story_id: str, entry_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            result = conn.execute(
                "DELETE FROM lorebook_entries WHERE id = ? AND story_id = ?",
                (entry_id, story_id),
            )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Lorebook entry not found.")
        return {"ok": True}

    async def stream_lorebook_update(
        story_id: str,
        chapter_id: str,
        story: Any,
        source_text: str,
    ) -> AsyncIterator[bytes]:
        startedAt = time.perf_counter()
        result: dict[str, Any] = {}

        yield deps.stream_event("status", "updating")

        async for event in run_lorebook_update(
            deps,
            story_id,
            chapter_id,
            source_text,
            story["model"],
            story["max_tokens"],
        ):
            if event["type"] == "reasoning":
                yield deps.stream_event("reasoning", event["value"])
                continue
            if event["type"] == "content":
                yield deps.stream_event("content", None)
                continue
            result = event["value"]

        durationMs = (time.perf_counter() - startedAt) * 1000
        payload = finalize_lorebook_update(
            deps, story_id, chapter_id, story, result, durationMs
        )
        yield deps.stream_event("complete", {**payload, "duration_ms": durationMs})

    @router.post("/api/stories/{story_id}/lorebook/update/stream")
    async def update_lorebook_from_chapter_stream(
        story_id: str, payload: LorebookUpdateRequest
    ) -> StreamingResponse:
        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (payload.chapter_id, story_id),
            ).fetchone()
            if not chapter:
                raise HTTPException(status_code=404, detail="Chapter not found.")

        sourceText = chapter["content"] or ""
        if not sourceText.strip():
            raise HTTPException(status_code=422, detail="Write something in this chapter first.")

        return StreamingResponse(
            stream_lorebook_update(story_id, payload.chapter_id, story, sourceText),
            media_type="application/x-ndjson; charset=utf-8",
            headers={"Cache-Control": "no-store"},
        )

    return router
