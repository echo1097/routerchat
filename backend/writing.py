import asyncio
import difflib
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


DEFAULT_MAX_TOKENS = 30000
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


class StoryCreateRequest(BaseModel):
    title: str = Field(default="New story", min_length=1)
    author: str = ""
    language: str = "English"
    synopsis: str = ""
    model: str | None = None
    system_prompt: str = ""
    temperature: float = 0.7
    max_tokens: int = DEFAULT_MAX_TOKENS
    thinking_enabled: bool = False
    reasoning_effort: str = "medium"
    temporary: bool = False
    lorebook_auto: bool = False


class StoryPatchRequest(BaseModel):
    title: str | None = None
    author: str | None = None
    language: str | None = None
    synopsis: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    thinking_enabled: bool | None = None
    reasoning_effort: str | None = None
    lorebook_auto: bool | None = None


class ChapterCreateRequest(BaseModel):
    title: str = Field(default="New chapter", min_length=1)
    content: str = ""


class StoryWithInitialChapterRequest(StoryCreateRequest):
    initial_chapter: ChapterCreateRequest


class ChapterPatchRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    order_index: int | None = None
    disabled: bool | None = None
    revision: int | None = Field(default=None, ge=0)


class ChapterContentRequest(BaseModel):
    content: str = ""
    revision: int = Field(ge=0)


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


class BrainstormNodePatchRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    position_x: float | None = None
    position_y: float | None = None


class BrainstormViewportRequest(BaseModel):
    position_x: float
    position_y: float
    zoom: float = Field(ge=0.1, le=4.0)


CHAPTER_EDIT_OPERATIONS = {
    "replaceBlock",
    "replaceBlockRange",
    "insertBeforeBlock",
    "insertAfterBlock",
    "appendToChapter",
}
CHAPTER_EDIT_INVALID_JSON = "chapter_edit_invalid_json"
CHAPTER_EDIT_INVALID_OPERATION = "chapter_edit_invalid_operation"
CHAPTER_EDIT_REVISION_MISMATCH = "chapter_edit_revision_mismatch"
CHAPTER_EDIT_TARGET_MISMATCH = "chapter_edit_target_mismatch"
CHAPTER_EDIT_CONFLICTING_EDITS = "chapter_edit_conflicting_edits"
CHAPTER_EDIT_TRUNCATED = "chapter_edit_truncated"
CHAPTER_REVISION_CONFLICT = "chapter_revision_conflict"


class ChapterEditError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class WritingDeps:
    get_db: Callable[[], sqlite3.Connection]
    utc_now: Callable[[], str]
    default_model_id: Callable[[], str]
    read_openrouter_key: Callable[[], str | None]
    headers_for_key: Callable[[str], dict[str, str]]
    write_system_prompt: Callable[[Any], str]
    openrouter_request_model: Callable[[str, bool], str]
    model_supports_reasoning: Callable[[str], bool]
    effective_thinking_enabled: Callable[[str, bool], bool]
    enabled_reasoning_config: Callable[[str, bool, str], dict[str, Any] | None]
    model_supports_structured_output: Callable[[str], bool]
    openrouter_error_message: Callable[[int, str], str]
    normalize_usage: Callable[[dict[str, Any] | None], dict[str, Any] | None]
    fetch_generation_usage: Callable[[str, str], Any]
    stream_event: Callable[..., bytes]
    stream_message_request: type[BaseModel]
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


def word_count(value: str) -> int:
    return len(value.split())


def word_diff_counts(before: str, after: str) -> tuple[int, int]:
    #words not lines, because a prose line is a whole paragraph and one swapped word would otherwise score the same as a full rewrite
    beforeLines = [line for line in (before or "").splitlines() if line.strip()]
    afterLines = [line for line in (after or "").splitlines() if line.strip()]

    wordsAdded = 0
    wordsRemoved = 0
    #line pass first so the expensive word pass only runs on the blocks that actually moved
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, beforeLines, afterLines).get_opcodes():
        if tag == "equal":
            continue
        if tag == "insert":
            wordsAdded += sum(len(line.split()) for line in afterLines[j1:j2])
            continue
        if tag == "delete":
            wordsRemoved += sum(len(line.split()) for line in beforeLines[i1:i2])
            continue

        beforeWords = " ".join(beforeLines[i1:i2]).split()
        afterWords = " ".join(afterLines[j1:j2]).split()
        #autojunk off, it treats common words like "the" as noise and wrecks the counts on real prose
        matcher = difflib.SequenceMatcher(None, beforeWords, afterWords, autojunk=False)
        for wordTag, a1, a2, b1, b2 in matcher.get_opcodes():
            if wordTag in {"replace", "delete"}:
                wordsRemoved += a2 - a1
            if wordTag in {"replace", "insert"}:
                wordsAdded += b2 - b1

    return wordsAdded, wordsRemoved


def format_duration(ms: float) -> str:
    seconds = max(1, round(ms / 1000))
    return f"{seconds} {'second' if seconds == 1 else 'seconds'}"


def display_model_name(model: str) -> str:
    name = str(model or "Model").split("/")[-1]
    name = name.replace(":free", "").replace("-", " ").replace("_", " ")
    return " ".join(part[:1].upper() + part[1:] for part in name.split())


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


def normalize_timeline_description(description: str) -> str:
    lines = []
    for line in str(description or "").splitlines():
        value = line.strip()
        if not value:
            continue
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
    if category in {"note", "synopsis"}:
        return {}
    return metadata


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


def is_scene_break(value: str) -> bool:
    text = value.strip()
    if text in {"***", "---", "# # #"}:
        return True
    return bool(re.fullmatch(r"[*_\-]{3,}", text))


#a model that retypes a quote instead of copying it will hand back straight quotes and single spaces, so both sides get flattened the same way
ANCHOR_CHARACTER_FOLDS = {
    "‘": "'",
    "’": "'",
    "‚": "'",
    "“": '"',
    "”": '"',
    "„": '"',
    "–": "-",
    "—": "-",
    "…": "...",
    " ": " ",
}

#long enough that it cannot match every paragraph by accident, short enough to stay copyable
ANCHOR_MINIMUM_LENGTH = 24

#what we hand the model in the block map, generous enough to clear the minimum even after it trims a word
ANCHOR_PROMPT_LENGTH = 80


def normalize_anchor(value: str) -> str:
    folded = "".join(ANCHOR_CHARACTER_FOLDS.get(character, character) for character in str(value or ""))
    return re.sub(r"\s+", " ", folded).strip()


def anchor_for_block(text: str) -> str:
    #cut on a word boundary so the anchor we advertise is never half a word the model has to guess how to finish
    if len(text) <= ANCHOR_PROMPT_LENGTH:
        return text

    head = text[:ANCHOR_PROMPT_LENGTH]
    lastSpace = head.rfind(" ")
    if lastSpace >= ANCHOR_MINIMUM_LENGTH:
        head = head[:lastSpace]
    return head.strip()


def resolve_block_by_anchor(
    blocks: list[dict[str, Any]],
    normalizedAnchor: str,
) -> dict[str, Any] | None:
    #only an unambiguous hit counts, two candidates means we have no idea which one the model meant and guessing would rewrite the wrong paragraph
    matches = [
        block
        for block in blocks
        if normalizedAnchor and normalizedAnchor in normalize_anchor(block["text"])
    ]
    if len(matches) != 1:
        return None

    #still has to be a real quote rather than a couple of words that happened to land once
    block = matches[0]
    if len(normalizedAnchor) < min(ANCHOR_MINIMUM_LENGTH, len(normalize_anchor(block["text"]))):
        return None
    return block


def chapter_blocks(content: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    paragraph_index = 0
    scene_index = 0

    #dot stops at \n by default, so this is naturally one match per physical line, blank lines just fall through as separators
    for match in re.finditer(r"\S.*", content or ""):
        text = match.group(0).strip()
        if not text:
            continue

        if is_scene_break(text):
            scene_index += 1
            block_type = "sceneBreak"
            block_id = f"s_{scene_index:03d}"
            block_index: int | None = scene_index
        else:
            paragraph_index += 1
            block_type = "paragraph"
            block_id = f"p_{paragraph_index:03d}"
            block_index = paragraph_index

        blocks.append(
            {
                "blockId": block_id,
                "type": block_type,
                "index": block_index,
                "text": text,
                "anchorText": anchor_for_block(text),
                "startChar": match.start(),
                "endChar": match.start() + len(match.group(0).rstrip()),
            }
        )

    return blocks


def block_map_for_prompt(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    #same key the operation has to send back, so copying the value straight across is always a valid answer
    return [
        {
            "blockId": block["blockId"],
            "type": block["type"],
            "index": block["index"],
            "anchorText": block["anchorText"],
        }
        for block in blocks
    ]


def chapter_edit_operation_schema() -> dict[str, Any]:
    operationFields = {
        "operation": {"type": "string"},
        "blockId": {"type": "string", "minLength": 1},
        "anchorText": {"type": "string", "minLength": 1},
        "newText": {"type": "string", "minLength": 1},
    }

    def variant(operationType: str, requiredFields: list[str]) -> dict[str, Any]:
        #properties come from this variants own required list, otherwise the schema advertises fields the validator will not take
        return {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                **{field: operationFields[field] for field in requiredFields},
                "operation": {"const": operationType},
            },
            "required": requiredFields,
        }

    rangeFields = {
        "startBlockId": {"type": "string", "minLength": 1},
        "startAnchorText": {"type": "string", "minLength": 1},
        "endBlockId": {"type": "string", "minLength": 1},
        "endAnchorText": {"type": "string", "minLength": 1},
    }

    return {
        "type": "object",
        "oneOf": [
            variant(
                "replaceBlock",
                ["operation", "blockId", "anchorText", "newText"],
            ),
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "newText": operationFields["newText"],
                    **rangeFields,
                    "operation": {"const": "replaceBlockRange"},
                },
                "required": [
                    "operation",
                    "startBlockId",
                    "startAnchorText",
                    "endBlockId",
                    "endAnchorText",
                    "newText",
                ],
            },
            variant(
                "insertBeforeBlock",
                ["operation", "blockId", "anchorText", "newText"],
            ),
            variant(
                "insertAfterBlock",
                ["operation", "blockId", "anchorText", "newText"],
            ),
            variant("appendToChapter", ["operation", "newText"]),
        ],
    }


def chapter_edit_batch_schema() -> dict[str, Any]:
    #chapterRevision lives on the envelope now, one statement of it instead of one per edit that can disagree with its neighbours
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "chapterRevision": {"type": "integer", "minimum": 0},
            "edits": {
                "type": "array",
                "minItems": 1,
                "items": chapter_edit_operation_schema(),
            },
        },
        "required": ["chapterRevision", "edits"],
    }


def chapter_edit_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "chapter_edit_batch",
            "strict": True,
            "schema": chapter_edit_batch_schema(),
        },
    }


def strip_code_fences(raw: str) -> str:
    #```json ... ``` is the single most common way a model wraps output it was told not to wrap
    text = raw.strip()
    if not text.startswith("```"):
        return text
    newline = text.find("\n")
    if newline == -1:
        return text
    body = text[newline + 1:]
    closing = body.rfind("```")
    return (body[:closing] if closing != -1 else body).strip()


def extract_json_object(raw: str) -> tuple[str | None, bool]:
    #returns the first balanced json object and whether it ran off the end, so prose around the json stops being fatal
    text = strip_code_fences(raw)
    start = text.find("{")
    if start == -1:
        return None, False

    depth = 0
    inString = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]

        if inString:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                inString = False
            continue

        if char == '"':
            inString = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1], False

    #never closed, so whatever we have is a cut off object
    return text[start:], True


def salvage_truncated_batch(partial: str) -> dict[str, Any] | None:
    #walks the edits array keeping every element that parses on its own, a run cut off at max_tokens still has good edits in it
    editsKey = partial.find('"edits"')
    if editsKey == -1:
        return None
    arrayStart = partial.find("[", editsKey)
    if arrayStart == -1:
        return None

    revision: Any = None
    revisionMatch = re.search(r'"chapterRevision"\s*:\s*(\d+)', partial)
    if revisionMatch:
        revision = int(revisionMatch.group(1))

    edits: list[Any] = []
    depth = 0
    inString = False
    escaped = False
    elementStart: int | None = None

    for index in range(arrayStart + 1, len(partial)):
        char = partial[index]

        if inString:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                inString = False
            continue

        if char == '"':
            inString = True
        elif char == "{":
            if depth == 0:
                elementStart = index
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0 and elementStart is not None:
                try:
                    edits.append(json.loads(partial[elementStart:index + 1]))
                except json.JSONDecodeError:
                    break
                elementStart = None
        elif char == "]" and depth == 0:
            break

    if not edits:
        return None
    return {"chapterRevision": revision, "edits": edits, "truncated": True}


def parse_chapter_edit_batch(raw_output: str) -> dict[str, Any]:
    if not isinstance(raw_output, str) or not raw_output.strip():
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_JSON,
            "model output was empty",
        )

    extracted, wasTruncated = extract_json_object(raw_output)
    parsed: Any = None

    if extracted is not None and not wasTruncated:
        try:
            parsed = json.loads(extracted)
        except json.JSONDecodeError:
            parsed = None

    if parsed is None:
        #either it never closed or the closed thing was not valid json, either way try to keep the complete edits
        salvaged = salvage_truncated_batch(extracted or strip_code_fences(raw_output))
        if salvaged is not None:
            return salvaged
        try:
            #valid json that simply is not an object is a shape problem, not a parse problem
            json.loads(strip_code_fences(raw_output))
        except json.JSONDecodeError:
            pass
        else:
            raise ChapterEditError(
                CHAPTER_EDIT_INVALID_OPERATION,
                "chapter edit output must be a JSON object",
            )
        raise ChapterEditError(
            CHAPTER_EDIT_TRUNCATED if wasTruncated else CHAPTER_EDIT_INVALID_JSON,
            "the response was cut off before a single complete edit came through"
            if wasTruncated
            else "model output was not exactly one JSON object",
        )

    if not isinstance(parsed, dict):
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "chapter edit output must be a JSON object",
        )

    #a bare single operation is still the shape plenty of models reach for, so wrap it rather than reject it
    if "edits" not in parsed and "operation" in parsed:
        revision = parsed.get("chapterRevision")
        edit = {key: value for key, value in parsed.items() if key != "chapterRevision"}
        return {"chapterRevision": revision, "edits": [edit], "truncated": False}

    edits = parsed.get("edits")
    if not isinstance(edits, list):
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "chapter edit output must contain an edits array",
        )
    if not edits:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "edits array must contain at least one edit",
        )

    return {"chapterRevision": parsed.get("chapterRevision"), "edits": edits, "truncated": False}


def parse_chapter_operation(raw_output: str) -> dict[str, Any]:
    #kept for the single edit path, the batch parser is the real entry point now
    batch = parse_chapter_edit_batch(raw_output)
    if len(batch["edits"]) != 1:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "expected exactly one chapter edit operation",
        )
    operation = dict(batch["edits"][0])
    operation["chapterRevision"] = batch["chapterRevision"]
    return validate_chapter_operation(operation)


def clean_insert_text(value: Any) -> str:
    return str(value or "").strip()


#models shorten these constantly and losing a whole generation over a field nickname is a stupid way to die
CHAPTER_EDIT_FIELD_ALIASES = {
    "anchor": "anchorText",
    "startAnchor": "startAnchorText",
    "endAnchor": "endAnchorText",
    "revision": "chapterRevision",
    "text": "newText",
}

#hashes are gone but a model that learned the old shape still sends them, and dying over a field we no longer read would be dumb
CHAPTER_EDIT_IGNORED_FIELDS = {
    "expectedTextHash",
    "startExpectedTextHash",
    "endExpectedTextHash",
    "textHash",
    "hash",
}


def normalize_chapter_operation_fields(operation: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(operation)
    for ignored in CHAPTER_EDIT_IGNORED_FIELDS:
        normalized.pop(ignored, None)
    for alias, canonical in CHAPTER_EDIT_FIELD_ALIASES.items():
        if alias not in normalized:
            continue
        #if the real name is already there the nickname is just noise, drop it either way
        value = normalized.pop(alias)
        normalized.setdefault(canonical, value)
    return normalized


def validate_chapter_operation(
    operation: dict[str, Any],
    baseRevision: int | None = None,
    blocks: list[dict[str, Any]] | None = None,
    requireRevision: bool = True,
) -> dict[str, Any]:
    if not isinstance(operation, dict):
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "chapter edit output must be a JSON object",
        )

    operation = normalize_chapter_operation_fields(operation)

    #inside a batch the revision is stated once on the envelope, a leftover copy on the edit is noise not an error
    if not requireRevision:
        operation.pop("chapterRevision", None)

    operationType = operation.get("operation")
    if not isinstance(operationType, str) or operationType not in CHAPTER_EDIT_OPERATIONS:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            f"unsupported chapter edit operation: {operationType or 'missing'}",
        )

    requiredFields = {"operation", "newText"}
    if requireRevision:
        requiredFields.add("chapterRevision")
    if operationType == "replaceBlockRange":
        requiredFields.update(
            {
                "startBlockId",
                "startAnchorText",
                "endBlockId",
                "endAnchorText",
            }
        )
    elif operationType != "appendToChapter":
        requiredFields.update({"blockId", "anchorText"})
    #a field this operation has no use for is noise, not a reason to bin prose the model already wrote
    operation = {key: value for key, value in operation.items() if key in requiredFields}

    missingFields = requiredFields - set(operation)
    if missingFields:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            f"missing fields: {', '.join(sorted(missingFields))}",
        )

    if requireRevision:
        chapterRevision = operation.get("chapterRevision")
        if type(chapterRevision) is not int or chapterRevision < 0:
            raise ChapterEditError(
                CHAPTER_EDIT_INVALID_OPERATION,
                "chapterRevision must be a non-negative integer",
            )
        if baseRevision is not None and chapterRevision != baseRevision:
            raise ChapterEditError(
                CHAPTER_EDIT_REVISION_MISMATCH,
                "operation chapterRevision does not match the generation base revision",
            )

    newText = operation.get("newText")
    if not isinstance(newText, str) or not newText.strip():
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "newText must be a non-empty string",
        )

    if operationType == "appendToChapter":
        return operation

    if operationType == "replaceBlockRange":
        targetFields = [
            ("startBlockId", "startAnchorText"),
            ("endBlockId", "endAnchorText"),
        ]
    else:
        targetFields = [("blockId", "anchorText")]

    targetBlocks: list[dict[str, Any]] = []
    for blockIdField, anchorField in targetFields:
        blockId = operation.get(blockIdField)
        anchorText = operation.get(anchorField)
        if not isinstance(blockId, str) or not blockId.strip():
            raise ChapterEditError(
                CHAPTER_EDIT_INVALID_OPERATION,
                f"{blockIdField} must be a non-empty string",
            )
        if not isinstance(anchorText, str) or not anchorText.strip():
            raise ChapterEditError(
                CHAPTER_EDIT_INVALID_OPERATION,
                f"{anchorField} must be a non-empty string",
            )

        if blocks is not None:
            blocksById = {block["blockId"]: block for block in blocks}
            block = blocksById.get(blockId.strip())
            normalizedAnchor = normalize_anchor(anchorText)

            if block is not None:
                normalizedBlock = normalize_anchor(block["text"])
                #a two word anchor would match half the chapter, so short blocks have to be quoted whole
                if len(normalizedAnchor) < min(ANCHOR_MINIMUM_LENGTH, len(normalizedBlock)):
                    raise ChapterEditError(
                        CHAPTER_EDIT_INVALID_OPERATION,
                        f"{anchorField} must quote at least "
                        f"{min(ANCHOR_MINIMUM_LENGTH, len(normalizedBlock))} characters of {blockId}",
                    )
                if normalizedAnchor in normalizedBlock:
                    targetBlocks.append(block)
                    operation[blockIdField] = block["blockId"]
                    continue

            #the quoted prose is a better witness than the models block id bookkeeping, so let the anchor pick the block
            block = resolve_block_by_anchor(blocks, normalizedAnchor)
            if block is None:
                raise ChapterEditError(
                    CHAPTER_EDIT_TARGET_MISMATCH,
                    f"unknown block id: {blockId}"
                    if blockId.strip() not in blocksById
                    else f"anchorText does not match {blockId}",
                )

            targetBlocks.append(block)
            operation[blockIdField] = block["blockId"]

    if operationType == "replaceBlockRange" and len(targetBlocks) == 2:
        if targetBlocks[0]["startChar"] > targetBlocks[1]["startChar"]:
            raise ChapterEditError(
                CHAPTER_EDIT_TARGET_MISMATCH,
                "range start block must not follow range end block",
            )

    return operation


def insert_with_spacing(content: str, position: int, text: str, placement: str) -> str:
    insert_text = clean_insert_text(text)
    if not insert_text:
        raise ValueError("new text cannot be empty")
    if not content.strip():
        return insert_text
    if placement == "before":
        if position <= 0:
            return f"{insert_text}\n\n{content}"
        return f"{content[:position]}{insert_text}\n\n{content[position:]}"
    if position >= len(content):
        return f"{content.rstrip()}\n\n{insert_text}"
    return f"{content[:position].rstrip()}\n\n{insert_text}\n\n{content[position:].lstrip()}"


def apply_chapter_operation(
    content: str,
    operation: dict[str, Any],
    baseRevision: int | None = None,
) -> dict[str, Any]:
    batch = {"chapterRevision": operation.get("chapterRevision"), "edits": [operation]}
    result = apply_chapter_edits(content, batch, baseRevision)
    #single edit shape kept intact so the old callers and tests still read the same keys
    return {"content": result["content"], **result["edits"][0]}


def chapter_edit_footprint(
    operation: dict[str, Any],
    blocks: list[dict[str, Any]],
    blocksById: dict[str, dict[str, Any]],
    contentLength: int,
) -> dict[str, Any]:
    #where the edit lands and which blocks it consumes, both resolved against one snapshot so a batch can be checked before anything is written
    operationType = operation["operation"]

    if operationType == "appendToChapter":
        return {"start": contentLength, "end": contentLength, "blockIds": []}

    if operationType == "replaceBlockRange":
        startBlock = blocksById[operation["startBlockId"].strip()]
        endBlock = blocksById[operation["endBlockId"].strip()]
        return {
            "start": startBlock["startChar"],
            "end": endBlock["endChar"],
            "blockIds": [
                block["blockId"]
                for block in blocks
                if startBlock["startChar"] <= block["startChar"] <= endBlock["startChar"]
            ],
        }

    block = blocksById[operation["blockId"].strip()]
    if operationType == "insertBeforeBlock":
        return {"start": block["startChar"], "end": block["startChar"], "blockIds": [block["blockId"]]}
    if operationType == "insertAfterBlock":
        return {"start": block["endChar"], "end": block["endChar"], "blockIds": [block["blockId"]]}

    return {"start": block["startChar"], "end": block["endChar"], "blockIds": [block["blockId"]]}


def apply_single_edit(content: str, operation: dict[str, Any], footprint: dict[str, Any]) -> str:
    #splices on positions taken from the original snapshot, which stay valid because the batch applies back to front
    operationType = operation["operation"]
    newText = clean_insert_text(operation["newText"])

    if operationType == "appendToChapter":
        return insert_with_spacing(content, len(content), newText, "after")
    if operationType == "insertBeforeBlock":
        return insert_with_spacing(content, footprint["start"], newText, "before")
    if operationType == "insertAfterBlock":
        return insert_with_spacing(content, footprint["start"], newText, "after")

    return f"{content[:footprint['start']]}{newText}{content[footprint['end']:]}"


def validate_chapter_edit_batch(
    batch: dict[str, Any],
    baseRevision: int | None = None,
    blocks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    edits = batch.get("edits")
    if not isinstance(edits, list) or not edits:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "edits array must contain at least one edit",
        )

    chapterRevision = batch.get("chapterRevision")
    if type(chapterRevision) is not int or chapterRevision < 0:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "chapterRevision must be a non-negative integer",
        )
    if baseRevision is not None and chapterRevision != baseRevision:
        raise ChapterEditError(
            CHAPTER_EDIT_REVISION_MISMATCH,
            "chapterRevision does not match the generation base revision",
        )

    validated = [
        validate_chapter_operation(edit, None, blocks, requireRevision=False) for edit in edits
    ]
    return {"chapterRevision": chapterRevision, "edits": validated}


def validate_chapter_edit_batch_partial(
    batch: dict[str, Any],
    baseRevision: int | None = None,
    blocks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    #same checks as the strict version, except one bad edit only costs that edit. envelope problems are still fatal because they are about the batch not one edit
    edits = batch.get("edits")
    if not isinstance(edits, list) or not edits:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "edits array must contain at least one edit",
        )

    chapterRevision = batch.get("chapterRevision")
    if type(chapterRevision) is not int or chapterRevision < 0:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "chapterRevision must be a non-negative integer",
        )
    if baseRevision is not None and chapterRevision != baseRevision:
        raise ChapterEditError(
            CHAPTER_EDIT_REVISION_MISMATCH,
            "chapterRevision does not match the generation base revision",
        )

    validated: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for index, edit in enumerate(edits):
        try:
            validated.append(validate_chapter_operation(edit, None, blocks, requireRevision=False))
        except ChapterEditError as exc:
            rejected.append(rejected_edit(index, exc.code, exc.message, edit))

    return {"chapterRevision": chapterRevision, "edits": validated, "rejected": rejected}


#a repair run never offers another repair, which is what keeps this from turning into a loop that quietly bills someone
REPAIRABLE_EDIT_CODES = {
    CHAPTER_EDIT_INVALID_JSON,
    CHAPTER_EDIT_INVALID_OPERATION,
    CHAPTER_EDIT_TARGET_MISMATCH,
    CHAPTER_EDIT_CONFLICTING_EDITS,
    CHAPTER_EDIT_TRUNCATED,
}


def repairable_error_event(code: str, message: str, is_repair: bool = False) -> dict[str, Any]:
    return {
        "code": code,
        "message": message,
        "repairable": code in REPAIRABLE_EDIT_CODES and not is_repair,
    }


def format_edit_count(count: int) -> str:
    return f"{count} {'edit' if count == 1 else 'edits'}"


def rejected_edit(index: int, code: str, message: str, operation: Any) -> dict[str, Any]:
    #carries enough for the repair turn to describe what failed without the model having to guess which edit we mean
    return {
        "index": index,
        "code": code,
        "message": message,
        "operation": operation if isinstance(operation, dict) else {},
    }


def apply_chapter_edits(
    content: str,
    batch: dict[str, Any],
    baseRevision: int | None = None,
    partial: bool = False,
) -> dict[str, Any]:
    blocks = chapter_blocks(content)
    blocksById = {block["blockId"]: block for block in blocks}

    if partial:
        batch = validate_chapter_edit_batch_partial(batch, baseRevision, blocks)
    else:
        batch = validate_chapter_edit_batch(batch, baseRevision, blocks)
    rejected: list[dict[str, Any]] = list(batch.get("rejected") or [])

    keptEdits: list[dict[str, Any]] = []
    footprints: list[dict[str, Any]] = []
    for edit in batch["edits"]:
        try:
            footprints.append(chapter_edit_footprint(edit, blocks, blocksById, len(content)))
        except (KeyError, ChapterEditError) as exc:
            if not partial:
                raise
            rejected.append(
                rejected_edit(len(keptEdits), CHAPTER_EDIT_TARGET_MISMATCH, str(exc), edit)
            )
            continue
        keptEdits.append(edit)
    batch = {**batch, "edits": keptEdits}

    #one block, one edit. a range consumes every block it spans, so this single rule also catches overlapping ranges and inserts anchored on a block someone else is replacing
    claimedBy: dict[str, int] = {}
    appendCount = 0
    droppedIndexes: set[int] = set()
    for index, (edit, footprint) in enumerate(zip(batch["edits"], footprints)):
        if edit["operation"] == "appendToChapter":
            appendCount += 1
            if appendCount > 1:
                #in partial mode the first append wins and the extra one is reported, rather than the pair taking the batch down with them
                if not partial:
                    raise ChapterEditError(
                        CHAPTER_EDIT_CONFLICTING_EDITS,
                        "only one appendToChapter is allowed per generation",
                    )
                droppedIndexes.add(index)
                rejected.append(
                    rejected_edit(
                        index,
                        CHAPTER_EDIT_CONFLICTING_EDITS,
                        "only one appendToChapter is allowed per generation",
                        edit,
                    )
                )
                continue
        conflict = next((blockId for blockId in footprint["blockIds"] if blockId in claimedBy), None)
        if conflict is not None and partial:
            droppedIndexes.add(index)
            rejected.append(
                rejected_edit(
                    index,
                    CHAPTER_EDIT_CONFLICTING_EDITS,
                    f"edits {claimedBy[conflict] + 1} and {index + 1} both change {conflict}",
                    edit,
                )
            )
            continue
        for blockId in footprint["blockIds"]:
            if blockId in claimedBy:
                raise ChapterEditError(
                    CHAPTER_EDIT_CONFLICTING_EDITS,
                    f"edits {claimedBy[blockId] + 1} and {index + 1} both change {blockId}",
                )
            claimedBy[blockId] = index

    surviving = [index for index in range(len(batch["edits"])) if index not in droppedIndexes]
    if not surviving:
        #nothing landed, so this is a plain failure and the caller gets the most representative reason to show the user
        first = rejected[0] if rejected else None
        raise ChapterEditError(
            first["code"] if first else CHAPTER_EDIT_INVALID_OPERATION,
            first["message"] if first else "no edit in the batch could be applied",
        )

    #back to front, so every edit still sees the offsets it was resolved against
    order = sorted(surviving, key=lambda index: footprints[index]["start"], reverse=True)
    nextContent = content
    for index in order:
        nextContent = apply_single_edit(nextContent, batch["edits"][index], footprints[index])

    applied = [
        {
            "operation": batch["edits"][index]["operation"],
            "deletedBlockIds": (
                footprints[index]["blockIds"]
                if batch["edits"][index]["operation"] in {"replaceBlock", "replaceBlockRange"}
                else []
            ),
            "insertedBlockIds": (
                footprints[index]["blockIds"][:1]
                if batch["edits"][index]["operation"] in {"replaceBlock", "replaceBlockRange"}
                else []
            ),
            "appliedText": clean_insert_text(batch["edits"][index]["newText"]),
        }
        for index in surviving
    ]

    return {"content": nextContent, "edits": applied, "rejected": rejected}


def append_chapter_text(content: str, text: str) -> dict[str, Any]:
    new_text = clean_insert_text(text)
    next_content = insert_with_spacing(content, len(content), new_text, "after")
    return {
        "content": next_content,
        "operation": "appendToChapter",
        "deletedBlockIds": [],
        "insertedBlockIds": [],
        "appliedText": new_text,
    }


def effective_generation_mode(requested_mode: str | None, chapter_content: str) -> str:
    mode = str(requested_mode or "new").lower()
    if mode not in {"edit", "new"}:
        mode = "new"
    if mode == "edit" and not chapter_content.strip():
        return "new"
    return mode


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


def parse_brainstorm_ideas(raw_output: str) -> list[dict[str, str]]:
    try:
        parsed = parse_lorebook_json(raw_output)
    except ValueError as exc:
        raise ValueError("Could not parse the brainstorm ideas response.") from exc
    raw_ideas = parsed.get("ideas")
    if not isinstance(raw_ideas, list):
        raise ValueError("Brainstorm output must contain an ideas array.")

    ideas: list[dict[str, str]] = []
    for raw_idea in raw_ideas[:5]:
        if not isinstance(raw_idea, dict):
            continue
        title = str(raw_idea.get("title") or "").strip()
        content = str(raw_idea.get("content") or "").strip()
        if title and content:
            ideas.append({"title": title, "content": content})

    if not ideas:
        raise ValueError("Brainstorm output must contain at least one complete idea.")
    return ideas


def next_brainstorm_root_position(
    nodes: list[Any],
    edges: list[Any],
    ideaCount: int,
) -> tuple[float, float]:
    rootX = 0.0
    anchorY = 180.0
    ideaGap = 210.0
    nodeHalfHeight = 130.0
    branchClearance = 80.0

    if not nodes:
        return rootX, anchorY

    childIdsBySource: dict[str, list[str]] = {}
    incomingIds: set[str] = set()
    nodesById = {str(node["id"]): node for node in nodes}
    for edge in edges:
        sourceId = str(edge["source_node_id"])
        targetId = str(edge["target_node_id"])
        if sourceId not in nodesById or targetId not in nodesById:
            continue
        childIdsBySource.setdefault(sourceId, []).append(targetId)
        incomingIds.add(targetId)

    occupiedBounds: list[tuple[float, float]] = []
    for rootNode in nodes:
        rootId = str(rootNode["id"])
        if rootId in incomingIds:
            continue

        branchIds = {rootId}
        pendingIds = [rootId]
        while pendingIds:
            currentId = pendingIds.pop()
            for childId in childIdsBySource.get(currentId, []):
                if childId in branchIds:
                    continue
                branchIds.add(childId)
                pendingIds.append(childId)

        branchY = [float(nodesById[nodeId]["position_y"]) for nodeId in branchIds]
        occupiedBounds.append((
            min(branchY) - nodeHalfHeight,
            max(branchY) + nodeHalfHeight,
        ))

    if not occupiedBounds:
        return rootX, anchorY

    newBranchHalfHeight = ((max(1, ideaCount) - 1) * ideaGap / 2) + nodeHalfHeight
    candidateY = {anchorY}
    for lowerBound, upperBound in occupiedBounds:
        candidateY.add(upperBound + branchClearance + newBranchHalfHeight)
        candidateY.add(lowerBound - branchClearance - newBranchHalfHeight)

    def slotIsOpen(centerY: float) -> bool:
        nextLower = centerY - newBranchHalfHeight
        nextUpper = centerY + newBranchHalfHeight
        return all(
            nextUpper + branchClearance <= lowerBound
            or nextLower - branchClearance >= upperBound
            for lowerBound, upperBound in occupiedBounds
        )

    openSlots = [centerY for centerY in candidateY if slotIsOpen(centerY)]
    bestY = min(
        openSlots,
        key=lambda centerY: (
            abs(centerY - anchorY),
            0 if centerY >= anchorY else 1,
            centerY,
        ),
    )
    return rootX, bestY


def request_updates(payload: BaseModel, reject_null: bool = False) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        updates = payload.model_dump(exclude_unset=True)
    else:
        updates = payload.dict(exclude_unset=True)

    if reject_null:
        null_fields = [key for key, value in updates.items() if value is None]
        if null_fields:
            raise HTTPException(
                status_code=422,
                detail=f"Fields cannot be null: {', '.join(null_fields)}.",
            )
    return updates


def row_to_story(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "author": row["author"],
        "language": row["language"],
        "synopsis": row["synopsis"],
        "model": row["model"],
        "system_prompt": row["system_prompt"],
        "temperature": row["temperature"],
        "max_tokens": row["max_tokens"],
        "thinking_enabled": bool(row["thinking_enabled"]),
        "reasoning_effort": row["reasoning_effort"],
        "temporary": bool(row["temporary"]),
        "lorebook_auto": bool(row["lorebook_auto"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_chapter(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "title": row["title"],
        "content": row["content"],
        "word_count": row["word_count"],
        "revision": row["revision"],
        "order_index": row["order_index"],
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_chapter_history_entry(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "chapter_id": row["chapter_id"],
        "run_id": row["run_id"],
        "label": row["label"],
        "detail": row["detail"],
        "entry_order": row["entry_order"],
        "kind": row["kind"],
        "words_added": row["words_added"],
        "words_removed": row["words_removed"],
        "cost": row["cost"],
        "created_at": row["created_at"],
    }


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


def row_to_story_generation(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "chapter_id": row["chapter_id"],
        "model": row["model"],
        "generation_id": row["generation_id"],
        "prompt_tokens": row["prompt_tokens"],
        "completion_tokens": row["completion_tokens"],
        "reasoning_tokens": row["reasoning_tokens"],
        "total_tokens": row["total_tokens"],
        "cost": row["cost"],
        "provider_name": row["provider_name"],
        "generation_time": row["generation_time"],
        "latency": row["latency"],
        "created_at": row["created_at"],
    }


def row_to_brainstorm_node(
    row: sqlite3.Row,
    reasoning: str | None = None,
    duration_ms: float | None = None,
) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "node_type": row["node_type"],
        "title": row["title"],
        "content": row["content"],
        "position_x": row["position_x"],
        "position_y": row["position_y"],
        "status": row["status"],
        "reasoning": reasoning,
        "duration_ms": duration_ms,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_brainstorm_edge(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "source_node_id": row["source_node_id"],
        "target_node_id": row["target_node_id"],
        "created_at": row["created_at"],
    }


def build_brainstorm_messages(
    story: sqlite3.Row,
    chapters: list[sqlite3.Row],
    lorebook_rows: list[sqlite3.Row],
    branch_nodes: list[sqlite3.Row],
    prompt: str,
    idea_count: int = 3,
) -> list[dict[str, str]]:
    visibleChapters = [chapter for chapter in chapters if not bool(chapter["disabled"])]
    chapterText = "\n\n".join(
        f"chapter {index + 1}: {chapter['title']}\n{chapter['content'] or 'empty chapter'}"
        for index, chapter in enumerate(visibleChapters)
    ) or "no visible chapters yet"
    lorebook_text = "\n".join(
        lorebook_context_line(row)
        for row in lorebook_rows
        if not bool(row["disabled"]) and row["description"].strip()
    ) or "no enabled lorebook entries"
    branch_text = "\n\n".join(
        f"{row['node_type']}: {row['title']}\n{row['content']}"
        for row in branch_nodes
    ) or "this is a new root brainstorm"

    context = (
        f"story title: {story['title']}\n"
        f"author: {story['author'] or 'unknown'}\n"
        f"language: {story['language'] or 'English'}\n"
        f"synopsis: {story['synopsis'] or 'none yet'}\n\n"
        f"all visible chapters:\n{chapterText}\n\n"
        f"lorebook:\n{lorebook_text}\n\n"
        f"selected brainstorm branch:\n{branch_text}"
    )

    messages: list[dict[str, str]] = []
    if story["system_prompt"].strip():
        messages.append({"role": "system", "content": story["system_prompt"].strip()})
    messages.append(
        {
            "role": "system",
            "content": (
                "You are a fiction brainstorming partner. Use the complete story context and the "
                "selected branch to propose distinct, story-specific continuations. Return only one "
                f"JSON object with an ideas array containing exactly {idea_count} objects. Every object must have a "
                "short title and a content field with 2 to 4 concise sentences. Do not write prose "
                "for the chapter and do not wrap the JSON in markdown."
            ),
        }
    )
    messages.append({"role": "user", "content": context})
    messages.append({"role": "user", "content": prompt})
    return messages


def next_chapter_order(conn: sqlite3.Connection, story_id: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order
        FROM chapters
        WHERE story_id = ?
        """,
        (story_id,),
    ).fetchone()
    return int(row["next_order"])


def next_chapter_history_order(conn: sqlite3.Connection, chapter_id: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(entry_order), -1) + 1 AS next_order
        FROM chapter_history_entries
        WHERE chapter_id = ?
        """,
        (chapter_id,),
    ).fetchone()
    return int(row["next_order"])


def insert_chapter_history_entry(
    conn: sqlite3.Connection,
    *,
    story_id: str,
    chapter_id: str,
    run_id: str,
    label: str,
    detail: str,
    now: str,
    kind: str | None = None,
    words_added: int | None = None,
    words_removed: int | None = None,
    cost: float | None = None,
) -> dict[str, Any]:
    entry_id = str(uuid.uuid4())
    entry_order = next_chapter_history_order(conn, chapter_id)
    conn.execute(
        """
        INSERT INTO chapter_history_entries (
          id, story_id, chapter_id, run_id, label, detail, entry_order,
          kind, words_added, words_removed, cost, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            entry_id,
            story_id,
            chapter_id,
            run_id,
            label,
            detail,
            entry_order,
            kind,
            words_added,
            words_removed,
            cost,
            now,
        ),
    )
    return {
        "id": entry_id,
        "story_id": story_id,
        "chapter_id": chapter_id,
        "run_id": run_id,
        "label": label,
        "detail": detail,
        "entry_order": entry_order,
        "kind": kind,
        "words_added": words_added,
        "words_removed": words_removed,
        "cost": cost,
        "created_at": now,
    }


def build_story_messages(
    story: sqlite3.Row,
    chapter: sqlite3.Row,
    lorebook_rows: list[sqlite3.Row],
    prompt: str,
    system_prompt: str,
    generation_mode: str = "new",
    blocks: list[dict[str, Any]] | None = None,
    repair_context: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    lorebook_text = "\n".join(
        lorebook_context_line(row)
        for row in lorebook_rows
        if not bool(row["disabled"]) and row["description"].strip()
    )
    context_parts = [
        f"story title: {story['title']}",
        f"author: {story['author'] or 'unknown'}",
        f"language: {story['language'] or 'English'}",
        f"synopsis: {story['synopsis'] or 'none yet'}",
        f"chapter title: {chapter['title']}",
        f"chapter revision: {chapter['revision']}",
        f"current chapter draft:\n{chapter['content'] or 'empty chapter'}",
    ]
    if generation_mode == "edit":
        context_parts.append(
            "chapter block map:\n"
            + json.dumps(block_map_for_prompt(blocks or []), ensure_ascii=False, indent=2)
        )
    if lorebook_text:
        context_parts.append(f"lorebook:\n{lorebook_text}")

    messages: list[dict[str, str]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    if generation_mode == "edit":
        messages.append(
            {
                "role": "system",
                "content": (
                    "You are editing the active chapter. Return only one JSON object with no "
                    "markdown, explanation, or wrapper text, shaped as {\"chapterRevision\": N, "
                    "\"edits\": [ ... ]}. The chapterRevision must exactly match the chapter "
                    "revision in the context and is stated once, not per edit. "
                    "Emit one entry in edits for every place you are changing. Never widen an "
                    "edit to span text you are not changing in order to reach a later one: if two "
                    "paragraphs need changing and the ones between them do not, emit two separate "
                    "edits. Every block you touch must belong to exactly one edit. "
                    "Supported operations are replaceBlock, replaceBlockRange, insertBeforeBlock, "
                    "insertAfterBlock, and appendToChapter. Every edit includes operation and "
                    "non-empty newText. Targeted single-block operations include blockId and "
                    "anchorText, copied exactly from that block's anchorText in the block map. "
                    "replaceBlockRange replaces an inclusive contiguous range and includes "
                    "startBlockId, startAnchorText, endBlockId, and endAnchorText; "
                    "use it only when every block in that range is genuinely being rewritten. "
                    "Do not use appendToChapter unless the user explicitly asks to continue at "
                    "the end. Replacement operations delete the targeted text first and insert "
                    "the replacement in the same position. Do not preserve, duplicate, append "
                    "beside, or restate replaced text unless the user explicitly asks for it. Use "
                    "the block map to resolve references like 4th paragraph; paragraph indexes "
                    "are 1-based."
                ),
            }
        )
    else:
        messages.append(
            {
                "role": "system",
                "content": (
                    "You are writing prose for the active chapter. Return only the prose "
                    "to insert into the chapter, with no analysis or wrapper text."
                ),
            }
        )
    messages.append({"role": "user", "content": "\n\n".join(context_parts)})
    messages.append({"role": "user", "content": prompt})

    #a repair sees its own failed output plus a block map rebuilt from the chapter as it stands now, which is the part it got wrong last time
    if generation_mode == "edit" and repair_context:
        previous = str(repair_context.get("previous_output") or "").strip()
        if previous:
            messages.append({"role": "assistant", "content": previous})
        messages.append({"role": "user", "content": repair_instructions(repair_context)})

    return messages


def repair_instructions(repair_context: dict[str, Any]) -> str:
    errors = [str(error) for error in (repair_context.get("errors") or []) if str(error).strip()]
    failed = [edit for edit in (repair_context.get("failed_edits") or []) if isinstance(edit, dict)]
    applied_count = int(repair_context.get("applied_count") or 0)

    parts = ["That response could not be applied as written."]
    if applied_count:
        parts.append(
            f"{applied_count} of your edits did apply and are already part of the chapter draft "
            "and block map above. Do not repeat, restate, or undo them."
        )
    if errors:
        parts.append("What went wrong:\n" + "\n".join(f"- {error}" for error in errors))
    if failed:
        parts.append(
            "These are the edits that failed. The prose in newText is fine, it is the targeting "
            "that was wrong, so reuse the text and re-anchor it against the block map above:\n"
            + json.dumps(failed, ensure_ascii=False, indent=2)
        )
    parts.append(
        "Reply with one corrected JSON object in the same shape, containing only the edits that "
        "still need to be made. Copy anchorText exactly from the block map."
    )
    return "\n\n".join(parts)


def apply_lorebook_updates(
    conn: sqlite3.Connection, story_id: str, updates: list[dict[str, Any]], now: str
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

        #disabled = 0 on both lookups, a hidden entry has to be invisible to the write path too, not just to the context the model reads
        if category == "timeline":
            existing = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ? AND lower(name) = lower('Timeline') AND disabled = 0
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()
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
            wordsAdded, wordsRemoved = word_diff_counts(lorebook_row_snapshot(existing), "")
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
            #an update that changes nothing is not an edit, dont write it and dont claim it in the history
            if beforeSnapshot == afterSnapshot:
                continue

            conn.execute(
                """
                UPDATE lorebook_entries
                SET category = ?, description = ?, aliases_json = ?, tags_json = ?,
                    metadata_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    category,
                    next_description,
                    json.dumps(next_aliases),
                    json.dumps(next_tags),
                    json.dumps(next_metadata),
                    now,
                    existing["id"],
                ),
            )
            wordsAdded, wordsRemoved = word_diff_counts(beforeSnapshot, afterSnapshot)
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
        wordsAdded, wordsRemoved = word_diff_counts(
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


def create_writing_router(deps: WritingDeps) -> APIRouter:
    router = APIRouter()
    StreamMessageRequest = deps.stream_message_request

    def get_story_bundle(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            chapters = conn.execute(
                """
                SELECT * FROM chapters
                WHERE story_id = ?
                ORDER BY order_index ASC, created_at ASC
                """,
                (story_id,),
            ).fetchall()
            lorebook = conn.execute(
                """
                SELECT * FROM lorebook_entries
                WHERE story_id = ?
                ORDER BY updated_at DESC, created_at DESC
                """,
                (story_id,),
            ).fetchall()
            history_rows = conn.execute(
                """
                SELECT * FROM chapter_history_entries
                WHERE story_id = ?
                ORDER BY entry_order ASC, created_at ASC
                """,
                (story_id,),
            ).fetchall()
            latest_generation = conn.execute(
                """
                SELECT * FROM story_generations
                WHERE story_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()
        history_by_chapter: dict[str, list[dict[str, Any]]] = {}
        for row in history_rows:
            history_by_chapter.setdefault(row["chapter_id"], []).append(
                row_to_chapter_history_entry(row)
            )
        chapter_payloads = []
        for row in chapters:
            chapter = row_to_chapter(row)
            chapter["history"] = history_by_chapter.get(row["id"], [])
            chapter_payloads.append(chapter)

        return {
            "story": row_to_story(story),
            "chapters": chapter_payloads,
            "lorebook": [row_to_lorebook_entry(row) for row in lorebook],
            "latest_generation": (
                row_to_story_generation(latest_generation) if latest_generation else None
            ),
        }

    async def run_lorebook_update(
        story_id: str,
        chapter_id: str,
        source_text: str,
        model: str,
        max_tokens: int,
        generation_row_id: str | None = None,
    ) -> dict[str, Any]:
        api_key = deps.read_openrouter_key()
        if not api_key or not source_text.strip():
            return {"applied": [], "skipped": True}

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
            "story": row_to_story(story),
            "chapter": {"title": chapter["title"]},
            "existing_lorebook": current_lore,
            "new_prose": source_text,
        }
        messages = [
            {
                "role": "system",
                "content": (
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
                    "For story chronology, create or update exactly one timeline entry named "
                    "\"Timeline\" with category \"timeline\". Its description must be a "
                    "chronological Markdown bullet list. Merge new events into the existing "
                    "timeline instead of duplicating bullets. Keep each entry concise and "
                    "information-dense. Do not copy prose style from the story. Prefer short "
                    "factual summaries over long paragraphs. Preserve important concrete "
                    "details, but omit transient action, mood, and wording that does not "
                    "matter for continuity. Timeline bullets should be brief, one event per "
                    "bullet. Add only new durable events or necessary corrections."
                ),
            },
            {"role": "user", "content": json.dumps(prompt)},
        ]
        raw_output = ""
        error_text: str | None = None
        applied: list[dict[str, Any]] = []
        usage: dict[str, Any] | None = None
        lorebook_generation_id: str | None = None
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(
                    f"{deps.openrouter_base_url}/chat/completions",
                    headers={**deps.headers_for_key(api_key), "Content-Type": "application/json"},
                    json={
                        "model": deps.openrouter_request_model(model, False),
                        "messages": messages,
                        "temperature": 0.1,
                        "max_tokens": max_tokens,
                    },
                )
            if response.status_code >= 400:
                error_text = deps.openrouter_error_message(response.status_code, response.text)
            else:
                data = response.json()
                lorebook_generation_id = response.headers.get("X-Generation-Id") or data.get("id")
                usage = deps.normalize_usage(data.get("usage"))
                raw_output = (
                    data
                    .get("choices", [{}])[0]
                    .get("message", {})
                    .get("content")
                    or ""
                )
                parsed = parse_lorebook_json(raw_output)
                updates = parsed.get("updates") if isinstance(parsed, dict) else []
                if not isinstance(updates, list):
                    updates = []
                with deps.get_db() as conn:
                    applied = apply_lorebook_updates(conn, story_id, updates, deps.utc_now())
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
        return {"applied": applied, "error": error_text, "cost": (usage or {}).get("cost")}

    async def stream_story_generation(
        story_id: str,
        chapter_id: str,
        payload: StreamMessageRequest,
        story: sqlite3.Row,
        chapter: sqlite3.Row,
        lorebook_rows: list[sqlite3.Row],
        base_revision: int,
    ) -> AsyncIterator[bytes]:
        event_metadata = {
            "runId": getattr(payload, "generation_run_id", None),
            "storyId": story_id,
            "chapterId": chapter_id,
        }

        def emit(event_type: str, value: Any, revision: int | None = None) -> bytes:
            metadata = {**event_metadata, "revision": revision}
            return deps.stream_event(event_type, value, metadata)

        api_key = deps.read_openrouter_key()
        if not api_key:
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")

        generation_mode = effective_generation_mode(
            getattr(payload, "write_generation_mode", None),
            chapter["content"] or "",
        )
        starting_blocks = chapter_blocks(chapter["content"] or "") if generation_mode == "edit" else []

        repair_context = getattr(payload, "repair_context", None)
        if repair_context is not None and not isinstance(repair_context, dict):
            repair_context = repair_context.model_dump()
        is_repair = bool(repair_context)

        messages = build_story_messages(
            story,
            chapter,
            lorebook_rows,
            payload.message,
            deps.write_system_prompt(payload),
            generation_mode,
            starting_blocks,
            repair_context,
        )
        body: dict[str, Any] = {
            "model": deps.openrouter_request_model(payload.model, payload.nitro_mode),
            "messages": messages,
            "temperature": payload.temperature,
            "max_tokens": payload.max_tokens,
            "stream": True,
        }
        effectiveThinkingEnabled = deps.effective_thinking_enabled(
            payload.model, payload.thinking_enabled
        )
        reasoningConfig = deps.enabled_reasoning_config(
            payload.model, payload.thinking_enabled, payload.reasoning_effort
        )
        if reasoningConfig:
            body["reasoning"] = reasoningConfig
        if generation_mode == "edit" and deps.model_supports_structured_output(payload.model):
            body["response_format"] = chapter_edit_response_format()

        generated_text: list[str] = []
        reasoning_text: list[str] = []
        finish_reason: str | None = None
        error_text: str | None = None
        generation_id: str | None = None
        usage: dict[str, Any] | None = None
        story_generation_id = str(uuid.uuid4())
        history_run_id = str(uuid.uuid4())
        model_label = display_model_name(payload.model)
        reasoning_started_at: float | None = None
        content_started_at: float | None = None
        stream_completed = False
        received_done = False
        cancelled = False

        def save_history(
            label: str,
            detail: str = "",
            kind: str | None = None,
            words_added: int | None = None,
            words_removed: int | None = None,
            cost: float | None = None,
        ) -> dict[str, Any]:
            with deps.get_db() as conn:
                return insert_chapter_history_entry(
                    conn,
                    story_id=story_id,
                    chapter_id=chapter_id,
                    run_id=history_run_id,
                    label=label,
                    detail=detail,
                    now=deps.utc_now(),
                    kind=kind,
                    words_added=words_added,
                    words_removed=words_removed,
                    cost=cost,
                )

        def revision_conflict_event(conn: sqlite3.Connection) -> dict[str, Any]:
            currentChapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
            return {
                "code": CHAPTER_REVISION_CONFLICT,
                "message": "Chapter changed while generation was running.",
                "chapter": row_to_chapter(currentChapter) if currentChapter else None,
            }

        try:
            yield emit(
                "history",
                save_history("User prompt", " ".join(payload.message.split()), kind="prompt"),
            )
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
                        yield emit("error", error_text)
                        return
                    generation_id = response.headers.get("X-Generation-Id") or generation_id

                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            received_done = True
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        generation_id = generation_id or chunk.get("id")
                        next_usage = deps.normalize_usage(chunk.get("usage"))
                        if next_usage:
                            usage = next_usage
                            continue
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finish_reason = choice.get("finish_reason") or finish_reason
                        delta = choice.get("delta") or {}
                        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                        if reasoning and effectiveThinkingEnabled:
                            if reasoning_started_at is None:
                                reasoning_started_at = time.perf_counter()
                            value = str(reasoning)
                            reasoning_text.append(value)
                            yield emit("reasoning", value)
                        content = delta.get("content")
                        if content:
                            if reasoning_started_at is not None:
                                duration_ms = (time.perf_counter() - reasoning_started_at) * 1000
                                yield emit(
                                    "history",
                                    save_history(
                                        f"{model_label} thought for {format_duration(duration_ms)}",
                                        kind="thinking",
                                    ),
                                )
                                reasoning_started_at = None
                            if content_started_at is None:
                                content_started_at = time.perf_counter()
                            value = str(content)
                            generated_text.append(value)
                            yield emit("content", value)

                    if generation_id:
                        generation_usage = await deps.fetch_generation_usage(api_key, generation_id)
                        if generation_usage:
                            usage = {**(usage or {}), **generation_usage}
                    if usage:
                        yield emit(
                            "usage",
                            {"generation_id": generation_id, "model": payload.model, **usage},
                        )
                    stream_completed = received_done
        except asyncio.CancelledError:
            cancelled = True
            error_text = "generation_cancelled"
            raise
        except Exception as exc:  # noqa: BLE001
            error_text = str(exc)
            yield emit("error", f"RouterChat error: {error_text}")
        finally:
            content = "".join(generated_text)
            now = deps.utc_now()
            chapter_update_event: dict[str, Any] | None = None
            error_event: dict[str, Any] | None = None
            edit_batch: dict[str, Any] | None = None

            if not stream_completed and not error_text:
                error_text = "generation_incomplete_stream"
                error_event = {
                    "code": "generation_incomplete_stream",
                    "message": "Generation ended before the provider completed the stream.",
                }
            if cancelled:
                error_event = {
                    "code": "generation_cancelled",
                    "message": "Generation was cancelled.",
                }

            edit_truncated = False

            if stream_completed and generation_mode == "edit" and content:
                try:
                    edit_batch = parse_chapter_edit_batch(content)
                    edit_truncated = bool(edit_batch.get("truncated")) or finish_reason == "length"
                except ChapterEditError as exc:
                    message = exc.message
                    code = exc.code
                    if finish_reason == "length" and code == CHAPTER_EDIT_INVALID_JSON:
                        #the json was fine, it just never got to finish, and saying so beats blaming the model for bad output
                        code = CHAPTER_EDIT_TRUNCATED
                        message = "the response hit the token limit before a single complete edit came through"
                    error_event = repairable_error_event(code, message, is_repair)
                    error_text = f"{code}: {message}"
                    edit_batch = None

            with deps.get_db() as conn:
                if stream_completed and content:
                    conn.execute("BEGIN IMMEDIATE")
                current = conn.execute(
                    "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                    (chapter_id, story_id),
                ).fetchone()
                current_content = current["content"] if current else ""

                if stream_completed and content and generation_mode == "edit" and edit_batch is not None:
                    try:
                        if not current or current["revision"] != base_revision:
                            error_event = revision_conflict_event(conn)
                            error_text = CHAPTER_REVISION_CONFLICT
                        else:
                            operation_result = apply_chapter_edits(
                                current_content,
                                edit_batch,
                                baseRevision=base_revision,
                                partial=True,
                            )
                            nextContent = operation_result["content"]
                            result = conn.execute(
                                """
                                UPDATE chapters
                                SET content = ?, word_count = ?, revision = revision + 1, updated_at = ?
                                WHERE id = ? AND story_id = ? AND revision = ?
                                """,
                                (
                                    nextContent,
                                    word_count(nextContent),
                                    now,
                                    chapter_id,
                                    story_id,
                                    base_revision,
                                ),
                            )
                            if result.rowcount != 1:
                                error_event = revision_conflict_event(conn)
                                error_text = CHAPTER_REVISION_CONFLICT
                            else:
                                savedChapter = conn.execute(
                                    "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                                    (chapter_id, story_id),
                                ).fetchone()
                                rejected_edits = operation_result.get("rejected") or []
                                applied_count = len(operation_result["edits"])
                                #a run cut off at the token limit lost whatever it had not written yet, and that work is invisible here: it never became an edit we could reject, so truncation has to count as incomplete on its own
                                incomplete = bool(rejected_edits) or edit_truncated
                                chapter_update_event = {
                                    "chapter": row_to_chapter(savedChapter),
                                    "edits": operation_result["edits"],
                                    "rejected": rejected_edits,
                                    "truncated": edit_truncated,
                                    #the applied edits are committed by now, so a repair is a fresh run on top of them and can never take them back
                                    "repairable": incomplete and not is_repair,
                                }
                                if rejected_edits:
                                    error_text = (
                                        f"partial: applied {applied_count} of "
                                        f"{applied_count + len(rejected_edits)} edits"
                                    )
                                elif edit_truncated:
                                    error_text = (
                                        f"partial: applied {format_edit_count(applied_count)} "
                                        "before the token limit"
                                    )
                    except ChapterEditError as exc:
                        error_event = repairable_error_event(exc.code, exc.message, is_repair)
                        error_text = f"{exc.code}: {exc.message}"
                elif stream_completed and content and generation_mode != "edit":
                    operation_result = append_chapter_text(current_content, content)
                    nextContent = operation_result["content"]
                    result = conn.execute(
                        """
                        UPDATE chapters
                        SET content = ?, word_count = ?, revision = revision + 1, updated_at = ?
                        WHERE id = ? AND story_id = ? AND revision = ?
                        """,
                        (
                            nextContent,
                            word_count(nextContent),
                            now,
                            chapter_id,
                            story_id,
                            base_revision,
                        ),
                    )
                    if result.rowcount == 1:
                        savedChapter = conn.execute(
                            "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                            (chapter_id, story_id),
                        ).fetchone()
                        chapter_update_event = {
                            "chapter": row_to_chapter(savedChapter),
                            "edits": [
                                {
                                    "operation": operation_result["operation"],
                                    "deletedBlockIds": operation_result["deletedBlockIds"],
                                    "insertedBlockIds": operation_result["insertedBlockIds"],
                                    "appliedText": operation_result["appliedText"],
                                }
                            ],
                        }
                    else:
                        error_event = revision_conflict_event(conn)
                        error_text = CHAPTER_REVISION_CONFLICT

                conn.execute(
                    """
                    INSERT INTO story_generations (
                      id, story_id, chapter_id, prompt, generated_text, model,
                      finish_reason, error, generation_id, prompt_tokens,
                      completion_tokens, reasoning_tokens, total_tokens, cost,
                      provider_name, generation_time, latency, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        story_generation_id,
                        story_id,
                        chapter_id,
                        payload.message,
                        content,
                        payload.model,
                        finish_reason,
                        error_text,
                        generation_id,
                        usage.get("prompt_tokens") if usage else None,
                        usage.get("completion_tokens") if usage else None,
                        usage.get("reasoning_tokens") if usage else None,
                        usage.get("total_tokens") if usage else None,
                        usage.get("cost") if usage else None,
                        usage.get("provider_name") if usage else None,
                        usage.get("generation_time") if usage else None,
                        usage.get("latency") if usage else None,
                        now,
                    ),
                )
                conn.execute(
                    "UPDATE stories SET updated_at = ? WHERE id = ?",
                    (now, story_id),
                )
            if error_event is not None:
                yield emit("error", error_event)
                #a run that failed still burned tokens, so it gets a line and carries the cost the wrote for line never got to report
                yield emit(
                    "history",
                    save_history(
                        f"{model_label} could not apply the edit",
                        detail=str(error_event.get("message") or ""),
                        kind="write_failed",
                        cost=usage.get("cost") if usage else None,
                    ),
                )
            if chapter_update_event is not None:
                yield emit("chapter_updated", chapter_update_event, chapter_update_event["chapter"]["revision"])
                if content_started_at is not None:
                    duration_ms = (time.perf_counter() - content_started_at) * 1000
                    written_added, written_removed = word_diff_counts(
                        current_content, chapter_update_event["chapter"]["content"]
                    )
                    #whole run rides here including any thinking tokens, the thought for line stays cost free on purpose
                    skipped = chapter_update_event.get("rejected") or []
                    applied_count = len(chapter_update_event.get("edits") or [])
                    if skipped:
                        label = f"{model_label} applied {applied_count} of {applied_count + len(skipped)} edits"
                        detail = "\n".join(
                            f"skipped edit {item['index'] + 1}: {item['message']}" for item in skipped
                        )
                    elif chapter_update_event.get("truncated"):
                        label = (
                            f"{model_label} applied {format_edit_count(applied_count)} "
                            "before the token limit"
                        )
                        detail = "the response was cut off, so any edits it had not written yet are missing"
                    else:
                        label = f"{model_label} wrote for {format_duration(duration_ms)}"
                        detail = ""

                    yield emit(
                        "history",
                        save_history(
                            label,
                            detail=detail,
                            kind="write",
                            words_added=written_added,
                            words_removed=written_removed,
                            cost=usage.get("cost") if usage else None,
                        ),
                    )
                    content_started_at = None

                with deps.get_db() as conn:
                    auto_row = conn.execute(
                        "SELECT lorebook_auto FROM stories WHERE id = ?", (story_id,)
                    ).fetchone()

                #manual runs get their own button, this is only for the folks who opted into auto
                if auto_row and bool(auto_row["lorebook_auto"]):
                    lorebook_started_at = time.perf_counter()
                    yield emit("lorebook_start", {"generation_id": story_generation_id})

                    lorebook_result = await run_lorebook_update(
                        story_id,
                        chapter_id,
                        chapter_update_event["chapter"]["content"],
                        payload.model,
                        payload.max_tokens,
                        generation_row_id=story_generation_id,
                    )
                    lorebook_duration_ms = (time.perf_counter() - lorebook_started_at) * 1000
                    #a skipped run never reached the model, so there is no activity to record
                    if not lorebook_result.get("skipped"):
                        for action in lorebook_run_history_actions(
                            model_label,
                            lorebook_result.get("applied") or [],
                            lorebook_duration_ms,
                            lorebook_result.get("cost"),
                        ):
                            yield emit(
                                "history",
                                save_history(
                                    action["label"],
                                    kind=action["kind"],
                                    words_added=action["words_added"],
                                    words_removed=action["words_removed"],
                                    cost=action["cost"],
                                ),
                            )

                    yield emit("lorebook", lorebook_result)

    @router.get("/api/stories")
    def list_stories() -> dict[str, Any]:
        with deps.get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM stories WHERE temporary = 0 ORDER BY updated_at DESC, created_at DESC"
            ).fetchall()
        return {"stories": [row_to_story(row) for row in rows]}

    @router.post("/api/stories")
    def create_story(payload: StoryCreateRequest) -> dict[str, Any]:
        now = deps.utc_now()
        story_id = str(uuid.uuid4())
        model = payload.model or deps.default_model_id()
        with deps.get_db() as conn:
            conn.execute(
                """
                INSERT INTO stories (
                  id, title, author, language, synopsis, model, system_prompt,
                  temperature, max_tokens, thinking_enabled, reasoning_effort, temporary,
                  lorebook_auto, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    story_id,
                    payload.title.strip() or "New story",
                    payload.author,
                    payload.language,
                    payload.synopsis,
                    model,
                    payload.system_prompt,
                    payload.temperature,
                    payload.max_tokens,
                    int(payload.thinking_enabled),
                    payload.reasoning_effort,
                    int(payload.temporary),
                    int(payload.lorebook_auto),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
        return {"story": row_to_story(row)}

    @router.post("/api/stories/with-initial-chapter")
    def create_story_with_initial_chapter(
        payload: StoryWithInitialChapterRequest,
    ) -> dict[str, Any]:
        now = deps.utc_now()
        story_id = str(uuid.uuid4())
        chapter_id = str(uuid.uuid4())
        model = payload.model or deps.default_model_id()
        initial_chapter = payload.initial_chapter
        content = initial_chapter.content

        with deps.get_db() as conn:
            conn.execute(
                """
                INSERT INTO stories (
                  id, title, author, language, synopsis, model, system_prompt,
                  temperature, max_tokens, thinking_enabled, reasoning_effort, temporary,
                  lorebook_auto, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    story_id,
                    payload.title.strip() or "New story",
                    payload.author,
                    payload.language,
                    payload.synopsis,
                    model,
                    payload.system_prompt,
                    payload.temperature,
                    payload.max_tokens,
                    int(payload.thinking_enabled),
                    payload.reasoning_effort,
                    int(payload.temporary),
                    int(payload.lorebook_auto),
                    now,
                    now,
                ),
            )
            conn.execute(
                """
                INSERT INTO chapters (
                  id, story_id, title, content, word_count, order_index, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chapter_id,
                    story_id,
                    initial_chapter.title.strip() or "New chapter",
                    content,
                    word_count(content),
                    0,
                    now,
                    now,
                ),
            )
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ?", (chapter_id,)
            ).fetchone()

        return {"story": row_to_story(story), "chapter": row_to_chapter(chapter)}

    @router.get("/api/stories/{story_id}")
    def get_story(story_id: str) -> dict[str, Any]:
        return get_story_bundle(story_id)

    @router.patch("/api/stories/{story_id}")
    def update_story(story_id: str, payload: StoryPatchRequest) -> dict[str, Any]:
        updates = request_updates(payload, reject_null=True)
        if not updates:
            return get_story_bundle(story_id)
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in updates.items():
            if key in {"thinking_enabled", "lorebook_auto"}:
                value = int(bool(value))
            if key == "title":
                value = str(value).strip() or "New story"
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        values.append(deps.utc_now())
        values.append(story_id)
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            conn.execute(f"UPDATE stories SET {', '.join(assignments)} WHERE id = ?", values)
        return get_story_bundle(story_id)

    @router.delete("/api/stories/{story_id}")
    def delete_story(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            conn.execute("DELETE FROM brainstorm_generations WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM brainstorm_edges WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM brainstorm_nodes WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM brainstorm_viewports WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM lorebook_update_runs WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM story_generations WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM lorebook_entries WHERE story_id = ?", (story_id,))
            conn.execute("DELETE FROM chapters WHERE story_id = ?", (story_id,))
            result = conn.execute("DELETE FROM stories WHERE id = ?", (story_id,))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Story not found.")
        return {"ok": True}

    @router.post("/api/stories/{story_id}/close")
    def close_story(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            story = conn.execute(
                "SELECT temporary FROM stories WHERE id = ?", (story_id,)
            ).fetchone()
        if not story or not bool(story["temporary"]):
            return {"ok": True}
        return delete_story(story_id)

    @router.get("/api/stories/{story_id}/chapters")
    def list_chapters(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            rows = conn.execute(
                """
                SELECT * FROM chapters
                WHERE story_id = ?
                ORDER BY order_index ASC, created_at ASC
                """,
                (story_id,),
            ).fetchall()
            history_rows = conn.execute(
                """
                SELECT * FROM chapter_history_entries
                WHERE story_id = ?
                ORDER BY entry_order ASC, created_at ASC
                """,
                (story_id,),
            ).fetchall()
        history_by_chapter: dict[str, list[dict[str, Any]]] = {}
        for row in history_rows:
            history_by_chapter.setdefault(row["chapter_id"], []).append(
                row_to_chapter_history_entry(row)
            )
        chapters = []
        for row in rows:
            chapter = row_to_chapter(row)
            chapter["history"] = history_by_chapter.get(row["id"], [])
            chapters.append(chapter)
        return {"chapters": chapters}

    @router.post("/api/stories/{story_id}/chapters")
    def create_chapter(story_id: str, payload: ChapterCreateRequest) -> dict[str, Any]:
        now = deps.utc_now()
        chapter_id = str(uuid.uuid4())
        content = payload.content
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            conn.execute(
                """
                INSERT INTO chapters (
                  id, story_id, title, content, word_count, order_index, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chapter_id,
                    story_id,
                    payload.title.strip() or "New chapter",
                    content,
                    word_count(content),
                    next_chapter_order(conn, story_id),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
        return {"chapter": row_to_chapter(row)}

    @router.patch("/api/stories/{story_id}/chapters/{chapter_id}")
    def update_chapter(
        story_id: str, chapter_id: str, payload: ChapterPatchRequest
    ) -> dict[str, Any]:
        updates = request_updates(payload, reject_null=True)
        base_revision = updates.pop("revision", None)
        if "content" in updates:
            updates["word_count"] = word_count(updates["content"])
        if "title" in updates:
            updates["title"] = str(updates["title"]).strip() or "New chapter"
        if not updates:
            with deps.get_db() as conn:
                chapter = conn.execute(
                    "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                    (chapter_id, story_id),
                ).fetchone()
            if not chapter:
                raise HTTPException(status_code=404, detail="Chapter not found.")
            return {"chapter": row_to_chapter(chapter)}
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in updates.items():
            assignments.append(f"{key} = ?")
            values.append(value)
        assignments.append("updated_at = ?")
        now = deps.utc_now()
        values.append(now)
        content_changed = "content" in updates
        with deps.get_db() as conn:
            chapter = conn.execute(
                "SELECT id FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
            if not chapter:
                raise HTTPException(status_code=404, detail="Chapter not found.")
            if base_revision is None:
                values.extend([chapter_id, story_id])
                conn.execute(
                    f"""
                    UPDATE chapters
                    SET {', '.join(assignments)}, revision = revision + 1
                    WHERE id = ? AND story_id = ?
                    """,
                    values,
                )
            else:
                values.extend([chapter_id, story_id, base_revision])
                result = conn.execute(
                    f"""
                    UPDATE chapters
                    SET {', '.join(assignments)}, revision = revision + 1
                    WHERE id = ? AND story_id = ? AND revision = ?
                    """,
                    values,
                )
                if result.rowcount == 0:
                    current = conn.execute(
                        "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                        (chapter_id, story_id),
                    ).fetchone()
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "chapter_revision_conflict",
                            "message": "Chapter changed on the server.",
                            "chapter": row_to_chapter(current),
                        },
                    )
            if content_changed:
                conn.execute(
                    "UPDATE stories SET updated_at = ? WHERE id = ?",
                    (now, story_id),
                )
            row = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
        return {"chapter": row_to_chapter(row)}

    @router.patch("/api/stories/{story_id}/chapters/{chapter_id}/content")
    def save_chapter_content(
        story_id: str, chapter_id: str, payload: ChapterContentRequest
    ) -> dict[str, Any]:
        return update_chapter(
            story_id,
            chapter_id,
            ChapterPatchRequest(content=payload.content, revision=payload.revision),
        )

    @router.delete("/api/stories/{story_id}/chapters/{chapter_id}")
    def delete_chapter(story_id: str, chapter_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            result = conn.execute(
                "DELETE FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Chapter not found.")
        return {"ok": True}

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
        result = await run_lorebook_update(
            story_id,
            payload.chapter_id,
            source_text,
            story["model"],
            story["max_tokens"],
        )
        applied = result.get("applied") or []

        model_label = display_model_name(story["model"])
        history_run_id = str(uuid.uuid4())
        history_entries: list[dict[str, Any]] = []
        duration_ms = (time.perf_counter() - started_at) * 1000
        actions = lorebook_run_history_actions(
            model_label, applied, duration_ms, result.get("cost")
        )

        with deps.get_db() as conn:
            for action in actions:
                history_entries.append(
                    insert_chapter_history_entry(
                        conn,
                        story_id=story_id,
                        chapter_id=payload.chapter_id,
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

        with deps.get_db() as conn:
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

    @router.post("/api/stories/{story_id}/lorebook")
    def create_lorebook_entry(story_id: str, payload: LorebookEntryRequest) -> dict[str, Any]:
        now = deps.utc_now()
        entry_id = str(uuid.uuid4())
        category = normalize_lorebook_category(payload.category)
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
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
                    payload.name.strip(),
                    category,
                    (
                        normalize_timeline_description(payload.description)
                        if category == "timeline"
                        else payload.description
                    ),
                    json.dumps(sanitize_lorebook_aliases(category, payload.aliases, payload.name.strip())),
                    json.dumps(payload.tags),
                    json.dumps(sanitize_lorebook_metadata(category, payload.metadata)),
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
                "SELECT id FROM lorebook_entries WHERE id = ? AND story_id = ?",
                (entry_id, story_id),
            ).fetchone()
            if not entry:
                raise HTTPException(status_code=404, detail="Lorebook entry not found.")
            conn.execute(
                """
                UPDATE lorebook_entries
                SET name = ?, category = ?, description = ?, aliases_json = ?,
                    tags_json = ?, metadata_json = ?, disabled = ?, updated_at = ?
                WHERE id = ? AND story_id = ?
                """,
                (
                    payload.name.strip(),
                    category,
                    (
                        normalize_timeline_description(payload.description)
                        if category == "timeline"
                        else payload.description
                    ),
                    json.dumps(sanitize_lorebook_aliases(category, payload.aliases, payload.name.strip())),
                    json.dumps(payload.tags),
                    json.dumps(sanitize_lorebook_metadata(category, payload.metadata)),
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

    @router.get("/api/stories/{story_id}/brainstorm")
    def get_brainstorm(story_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            nodes = conn.execute(
                "SELECT * FROM brainstorm_nodes WHERE story_id = ? ORDER BY created_at ASC",
                (story_id,),
            ).fetchall()
            edges = conn.execute(
                "SELECT * FROM brainstorm_edges WHERE story_id = ? ORDER BY created_at ASC",
                (story_id,),
            ).fetchall()
            viewport = conn.execute(
                "SELECT * FROM brainstorm_viewports WHERE story_id = ?",
                (story_id,),
            ).fetchone()
            generation_rows = conn.execute(
                """
                SELECT prompt_node_id, reasoning, duration_ms
                FROM brainstorm_generations
                WHERE story_id = ?
                ORDER BY created_at ASC
                """,
                (story_id,),
            ).fetchall()
            latest_generation = conn.execute(
                """
                SELECT * FROM brainstorm_generations
                WHERE story_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (story_id,),
            ).fetchone()

        reasoningByPromptId = {
            row["prompt_node_id"]: row["reasoning"]
            for row in generation_rows
            if row["reasoning"]
        }
        durationByPromptId = {
            row["prompt_node_id"]: row["duration_ms"]
            for row in generation_rows
            if row["duration_ms"] is not None
        }
        usage = None
        if latest_generation:
            usage = {
                "generation_id": latest_generation["generation_id"],
                "model": latest_generation["model"],
                "prompt_tokens": latest_generation["prompt_tokens"],
                "completion_tokens": latest_generation["completion_tokens"],
                "reasoning_tokens": latest_generation["reasoning_tokens"],
                "total_tokens": latest_generation["total_tokens"],
                "cost": latest_generation["cost"],
                "provider_name": latest_generation["provider_name"],
                "generation_time": latest_generation["generation_time"],
                "latency": latest_generation["latency"],
            }
        return {
            "nodes": [
                row_to_brainstorm_node(
                    row,
                    reasoningByPromptId.get(row["id"]),
                    durationByPromptId.get(row["id"]),
                )
                for row in nodes
            ],
            "edges": [row_to_brainstorm_edge(row) for row in edges],
            "viewport": (
                {
                    "x": viewport["position_x"],
                    "y": viewport["position_y"],
                    "zoom": viewport["zoom"],
                }
                if viewport
                else {"x": 0, "y": 0, "zoom": 1}
            ),
            "latest_generation": usage,
        }

    @router.patch("/api/stories/{story_id}/brainstorm/nodes/{node_id}")
    def update_brainstorm_node(
        story_id: str,
        node_id: str,
        payload: BrainstormNodePatchRequest,
    ) -> dict[str, Any]:
        updates = request_updates(payload, reject_null=True)
        if not updates:
            raise HTTPException(status_code=400, detail="No node changes provided.")

        with deps.get_db() as conn:
            node = conn.execute(
                "SELECT * FROM brainstorm_nodes WHERE id = ? AND story_id = ?",
                (node_id, story_id),
            ).fetchone()
            if not node:
                raise HTTPException(status_code=404, detail="Brainstorm node not found.")
            if node["node_type"] != "idea" and ({"title", "content"} & updates.keys()):
                raise HTTPException(status_code=400, detail="Prompt text cannot be edited.")

            assignments: list[str] = []
            values: list[Any] = []
            for key, value in updates.items():
                if key in {"title", "content"}:
                    value = str(value or "").strip()
                    if not value:
                        raise HTTPException(status_code=400, detail=f"Node {key} cannot be empty.")
                assignments.append(f"{key} = ?")
                values.append(value)
            assignments.append("updated_at = ?")
            values.append(deps.utc_now())
            values.extend([node_id, story_id])
            conn.execute(
                f"UPDATE brainstorm_nodes SET {', '.join(assignments)} WHERE id = ? AND story_id = ?",
                values,
            )
            updated = conn.execute(
                "SELECT * FROM brainstorm_nodes WHERE id = ?", (node_id,)
            ).fetchone()
        return {"node": row_to_brainstorm_node(updated)}

    @router.patch("/api/stories/{story_id}/brainstorm/viewport")
    def update_brainstorm_viewport(
        story_id: str,
        payload: BrainstormViewportRequest,
    ) -> dict[str, Any]:
        now = deps.utc_now()
        with deps.get_db() as conn:
            story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            conn.execute(
                """
                INSERT INTO brainstorm_viewports (
                  story_id, position_x, position_y, zoom, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(story_id) DO UPDATE SET
                  position_x = excluded.position_x,
                  position_y = excluded.position_y,
                  zoom = excluded.zoom,
                  updated_at = excluded.updated_at
                """,
                (story_id, payload.position_x, payload.position_y, payload.zoom, now),
            )
        return {"viewport": {"x": payload.position_x, "y": payload.position_y, "zoom": payload.zoom}}

    @router.delete("/api/stories/{story_id}/brainstorm/nodes/{node_id}")
    def delete_brainstorm_node(
        story_id: str,
        node_id: str,
        cascade: bool = False,
    ) -> dict[str, Any]:
        with deps.get_db() as conn:
            nodes = conn.execute(
                "SELECT id FROM brainstorm_nodes WHERE story_id = ?", (story_id,)
            ).fetchall()
            node_ids = {row["id"] for row in nodes}
            if node_id not in node_ids:
                raise HTTPException(status_code=404, detail="Brainstorm node not found.")
            edges = conn.execute(
                "SELECT source_node_id, target_node_id FROM brainstorm_edges WHERE story_id = ?",
                (story_id,),
            ).fetchall()
            children_by_source: dict[str, list[str]] = {}
            for edge in edges:
                children_by_source.setdefault(edge["source_node_id"], []).append(
                    edge["target_node_id"]
                )

            delete_ids = {node_id}
            pending = [node_id]
            while pending:
                current_id = pending.pop()
                for child_id in children_by_source.get(current_id, []):
                    if child_id not in delete_ids:
                        delete_ids.add(child_id)
                        pending.append(child_id)

            if len(delete_ids) > 1 and not cascade:
                raise HTTPException(
                    status_code=409,
                    detail="This node has descendants. Confirm branch deletion first.",
                )
            placeholders = ",".join("?" for _ in delete_ids)
            values = list(delete_ids)
            conn.execute(
                f"DELETE FROM brainstorm_generations WHERE prompt_node_id IN ({placeholders})",
                values,
            )
            conn.execute(
                f"DELETE FROM brainstorm_edges WHERE story_id = ? AND (source_node_id IN ({placeholders}) OR target_node_id IN ({placeholders}))",
                [story_id, *values, *values],
            )
            conn.execute(
                f"DELETE FROM brainstorm_nodes WHERE story_id = ? AND id IN ({placeholders})",
                [story_id, *values],
            )
        return {"deleted_node_ids": values}

    async def stream_brainstorm_generation(
        story_id: str,
        payload: StreamMessageRequest,
        story: sqlite3.Row,
        chapters: list[sqlite3.Row],
        lorebook_rows: list[sqlite3.Row],
        branch_nodes: list[sqlite3.Row],
        prompt_node: sqlite3.Row,
        prompt_edges: list[sqlite3.Row],
    ) -> AsyncIterator[bytes]:
        api_key = deps.read_openrouter_key()
        prompt_node_id = prompt_node["id"]
        generation_row_id = str(uuid.uuid4())
        messages = build_brainstorm_messages(
            story, chapters, lorebook_rows, branch_nodes, payload.message, payload.brainstorm_idea_count
        )
        body: dict[str, Any] = {
            "model": deps.openrouter_request_model(payload.model, payload.nitro_mode),
            "messages": messages,
            "temperature": payload.temperature,
            "max_tokens": payload.max_tokens,
            "stream": True,
        }
        effectiveThinkingEnabled = deps.effective_thinking_enabled(
            payload.model, payload.thinking_enabled
        )
        reasoningConfig = deps.enabled_reasoning_config(
            payload.model, payload.thinking_enabled, payload.reasoning_effort
        )
        if reasoningConfig:
            body["reasoning"] = reasoningConfig

        generated_text: list[str] = []
        reasoning_text: list[str] = []
        generation_started_at = time.perf_counter()
        duration_ms: float | None = None
        generation_id: str | None = None
        finish_reason: str | None = None
        usage: dict[str, Any] = {}
        saved_generation = False

        def save_generation(status: str, error: str | None = None) -> None:
            nonlocal duration_ms, saved_generation
            if saved_generation:
                return
            saved_generation = True
            duration_ms = (time.perf_counter() - generation_started_at) * 1000
            with deps.get_db() as conn:
                conn.execute(
                    "UPDATE brainstorm_nodes SET status = ?, updated_at = ? WHERE id = ?",
                    (status, deps.utc_now(), prompt_node_id),
                )
                conn.execute(
                    """
                    INSERT INTO brainstorm_generations (
                      id, story_id, prompt_node_id, prompt, reasoning, duration_ms,
                      model, finish_reason, error,
                      generation_id, prompt_tokens, completion_tokens, reasoning_tokens,
                      total_tokens, cost, provider_name, generation_time, latency, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        generation_row_id,
                        story_id,
                        prompt_node_id,
                        payload.message,
                        "".join(reasoning_text) or None,
                        duration_ms,
                        payload.model,
                        finish_reason,
                        error,
                        generation_id,
                        usage.get("prompt_tokens"),
                        usage.get("completion_tokens"),
                        usage.get("reasoning_tokens"),
                        usage.get("total_tokens"),
                        usage.get("cost"),
                        usage.get("provider_name"),
                        usage.get("generation_time"),
                        usage.get("latency"),
                        deps.utc_now(),
                    ),
                )

        try:
            promptNodeValue = row_to_brainstorm_node(prompt_node)
            promptNodeValue["generation_phase"] = (
                "thinking" if effectiveThinkingEnabled else "working"
            )
            yield deps.stream_event(
                "prompt",
                {
                    "node": promptNodeValue,
                    "edges": [row_to_brainstorm_edge(edge) for edge in prompt_edges],
                },
            )
            working_started = False
            async with httpx.AsyncClient(timeout=OPENROUTER_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    f"{deps.openrouter_base_url}/chat/completions",
                    headers={**deps.headers_for_key(api_key), "Content-Type": "application/json"},
                    json=body,
                ) as response:
                    if response.status_code >= 400:
                        raw_error = (await response.aread()).decode("utf-8", errors="replace")
                        error = deps.openrouter_error_message(response.status_code, raw_error)
                        save_generation("failed", error)
                        yield deps.stream_event("error", error)
                        return
                    generation_id = response.headers.get("X-Generation-Id")

                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        generation_id = generation_id or chunk.get("id")
                        next_usage = deps.normalize_usage(chunk.get("usage"))
                        if next_usage:
                            usage.update(next_usage)
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finish_reason = choice.get("finish_reason") or finish_reason
                        delta = choice.get("delta") or {}
                        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                        if reasoning and effectiveThinkingEnabled:
                            reasoningValue = str(reasoning)
                            reasoning_text.append(reasoningValue)
                            yield deps.stream_event("reasoning", reasoningValue)
                        content = delta.get("content")
                        if content:
                            if not working_started:
                                working_started = True
                                yield deps.stream_event("working", None)
                            generated_text.append(str(content))

            if generation_id:
                generation_usage = await deps.fetch_generation_usage(api_key, generation_id)
                if generation_usage:
                    usage.update(generation_usage)

            ideas = parse_brainstorm_ideas("".join(generated_text))
            if len(ideas) < payload.brainstorm_idea_count:
                raise ValueError(
                    f"Brainstorm output returned {len(ideas)} ideas instead of "
                    f"{payload.brainstorm_idea_count}."
                )
            ideas = ideas[:payload.brainstorm_idea_count]
            prompt_x = float(prompt_node["position_x"])
            prompt_y = float(prompt_node["position_y"])
            child_x = prompt_x + 390
            child_gap = 210
            first_y = prompt_y - ((len(ideas) - 1) * child_gap / 2)
            now = deps.utc_now()
            created_nodes: list[dict[str, Any]] = []
            created_edges: list[dict[str, Any]] = []
            with deps.get_db() as conn:
                for index, idea in enumerate(ideas):
                    idea_id = str(uuid.uuid4())
                    edge_id = str(uuid.uuid4())
                    conn.execute(
                        """
                        INSERT INTO brainstorm_nodes (
                          id, story_id, node_type, title, content, position_x,
                          position_y, status, created_at, updated_at
                        ) VALUES (?, ?, 'idea', ?, ?, ?, ?, 'complete', ?, ?)
                        """,
                        (
                            idea_id,
                            story_id,
                            idea["title"],
                            idea["content"],
                            child_x,
                            first_y + index * child_gap,
                            now,
                            now,
                        ),
                    )
                    conn.execute(
                        """
                        INSERT INTO brainstorm_edges (
                          id, story_id, source_node_id, target_node_id, created_at
                        ) VALUES (?, ?, ?, ?, ?)
                        """,
                        (edge_id, story_id, prompt_node_id, idea_id, now),
                    )
                    node_row = conn.execute(
                        "SELECT * FROM brainstorm_nodes WHERE id = ?", (idea_id,)
                    ).fetchone()
                    edge_row = conn.execute(
                        "SELECT * FROM brainstorm_edges WHERE id = ?", (edge_id,)
                    ).fetchone()
                    created_nodes.append(row_to_brainstorm_node(node_row))
                    created_edges.append(row_to_brainstorm_edge(edge_row))
            save_generation("complete")
            yield deps.stream_event(
                "ideas",
                {
                    "nodes": created_nodes,
                    "edges": created_edges,
                    "duration_ms": duration_ms,
                },
            )
            if usage:
                yield deps.stream_event(
                    "usage", {"generation_id": generation_id, "model": payload.model, **usage}
                )
        except asyncio.CancelledError:
            save_generation("cancelled", "Generation cancelled.")
            raise
        except Exception as exc:  # noqa: BLE001
            error = str(exc)
            save_generation("failed", error)
            yield deps.stream_event("error", error)

    @router.post("/api/stories/{story_id}/brainstorm/generate/stream")
    async def generate_brainstorm(
        story_id: str,
        payload: StreamMessageRequest,
    ) -> StreamingResponse:
        if not deps.read_openrouter_key():
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
        if not payload.message.strip():
            raise HTTPException(status_code=400, detail="Message cannot be empty.")

        selected_ids = list(dict.fromkeys(payload.selected_idea_ids))
        now = deps.utc_now()
        prompt_node_id = str(uuid.uuid4())
        prompt_edges: list[sqlite3.Row] = []
        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            chapters = conn.execute(
                "SELECT * FROM chapters WHERE story_id = ? ORDER BY order_index ASC, created_at ASC",
                (story_id,),
            ).fetchall()
            lorebook_rows = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY updated_at DESC",
                (story_id,),
            ).fetchall()
            all_nodes = conn.execute(
                "SELECT * FROM brainstorm_nodes WHERE story_id = ? ORDER BY created_at ASC",
                (story_id,),
            ).fetchall()
            all_edges = conn.execute(
                "SELECT * FROM brainstorm_edges WHERE story_id = ? ORDER BY created_at ASC",
                (story_id,),
            ).fetchall()
            nodes_by_id = {row["id"]: row for row in all_nodes}
            if any(
                selected_id not in nodes_by_id
                or nodes_by_id[selected_id]["node_type"] != "idea"
                for selected_id in selected_ids
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Every selected brainstorm node must be an idea from this story.",
                )

            parent_by_target: dict[str, list[str]] = {}
            for edge in all_edges:
                parent_by_target.setdefault(edge["target_node_id"], []).append(
                    edge["source_node_id"]
                )
            branch_ids = set(selected_ids)
            pending = list(selected_ids)
            while pending:
                current_id = pending.pop()
                for parent_id in parent_by_target.get(current_id, []):
                    if parent_id not in branch_ids:
                        branch_ids.add(parent_id)
                        pending.append(parent_id)
            branch_nodes = [row for row in all_nodes if row["id"] in branch_ids]

            if selected_ids:
                prompt_x = max(float(nodes_by_id[node_id]["position_x"]) for node_id in selected_ids) + 390
                prompt_y = sum(
                    float(nodes_by_id[node_id]["position_y"]) for node_id in selected_ids
                ) / len(selected_ids)
            else:
                prompt_x, prompt_y = next_brainstorm_root_position(
                    all_nodes,
                    all_edges,
                    payload.brainstorm_idea_count,
                )

            conn.execute(
                """
                INSERT INTO brainstorm_nodes (
                  id, story_id, node_type, title, content, position_x,
                  position_y, status, created_at, updated_at
                ) VALUES (?, ?, 'prompt', 'Prompt', ?, ?, ?, 'generating', ?, ?)
                """,
                (prompt_node_id, story_id, payload.message.strip(), prompt_x, prompt_y, now, now),
            )
            for selected_id in selected_ids:
                edge_id = str(uuid.uuid4())
                conn.execute(
                    """
                    INSERT INTO brainstorm_edges (
                      id, story_id, source_node_id, target_node_id, created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (edge_id, story_id, selected_id, prompt_node_id, now),
                )
                prompt_edges.append(
                    conn.execute(
                        "SELECT * FROM brainstorm_edges WHERE id = ?", (edge_id,)
                    ).fetchone()
                )
            conn.execute(
                """
                UPDATE stories SET model = ?, temperature = ?, max_tokens = ?,
                  thinking_enabled = ?, reasoning_effort = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.model,
                    payload.temperature,
                    payload.max_tokens,
                    int(payload.thinking_enabled),
                    payload.reasoning_effort,
                    now,
                    story_id,
                ),
            )
            prompt_node = conn.execute(
                "SELECT * FROM brainstorm_nodes WHERE id = ?", (prompt_node_id,)
            ).fetchone()

        return StreamingResponse(
            stream_brainstorm_generation(
                story_id,
                payload,
                story,
                chapters,
                lorebook_rows,
                branch_nodes,
                prompt_node,
                prompt_edges,
            ),
            media_type="application/x-ndjson; charset=utf-8",
        )

    @router.post("/api/stories/{story_id}/chapters/{chapter_id}/generate/stream")
    async def stream_story_chapter_generation(
        story_id: str,
        chapter_id: str,
        payload: StreamMessageRequest,
    ) -> StreamingResponse:
        if not deps.read_openrouter_key():
            raise HTTPException(status_code=401, detail="Add an OpenRouter API key first.")
        if not payload.message.strip():
            raise HTTPException(status_code=400, detail="Message cannot be empty.")

        with deps.get_db() as conn:
            story = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not story:
                raise HTTPException(status_code=404, detail="Story not found.")
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE id = ? AND story_id = ?",
                (chapter_id, story_id),
            ).fetchone()
            if not chapter:
                raise HTTPException(status_code=404, detail="Chapter not found.")
            base_revision = payload.chapter_revision
            if base_revision is None:
                raise HTTPException(status_code=422, detail="chapter_revision is required.")
            if base_revision != chapter["revision"]:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "chapter_revision_conflict",
                        "message": "Chapter changed on the server.",
                        "chapter": row_to_chapter(chapter),
                    },
                )
            lorebook_rows = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY updated_at DESC",
                (story_id,),
            ).fetchall()
            conn.execute(
                """
                UPDATE stories
                SET model = ?, system_prompt = ?, temperature = ?, max_tokens = ?,
                    thinking_enabled = ?, reasoning_effort = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.model,
                    deps.write_system_prompt(payload),
                    payload.temperature,
                    payload.max_tokens,
                    int(payload.thinking_enabled),
                    payload.reasoning_effort,
                    deps.utc_now(),
                    story_id,
                ),
            )

        return StreamingResponse(
            stream_story_generation(
                story_id,
                chapter_id,
                payload,
                story,
                chapter,
                lorebook_rows,
                base_revision,
            ),
            media_type="application/x-ndjson; charset=utf-8",
        )

    return router
