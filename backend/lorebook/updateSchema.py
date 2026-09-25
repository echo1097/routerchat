from typing import Any

from backend.lorebook.chapterSummaries import SUMMARY_INSTRUCTION
from backend.lorebook.lorebookRows import LOREBOOK_CATEGORIES

LOREBOOK_UPDATE_SYSTEM_PROMPT = (
    "Extract important durable lore from new prose. Return one strict JSON object with an updates "
    "array and no explanation. Existing entries are identified only by entryId and entryRevision. "
    "Never recreate or restate a complete existing entry. Use action edit with small operations: "
    "replaceText changes one exact unique excerpt in description, appendText adds genuinely new "
    "description text, setField corrects name or category, and addItems or removeItems changes "
    "aliases or tags. Copy replaceText oldText exactly from existing_lorebook. Use action create "
    "only for a genuinely new entry. Use exclude only when prose actively contradicts or retires "
    "an entry; absence from this chapter is not a reason to exclude it. Use keep when the required "
    "chapter summary or Timeline needs no change. "
    "Aliases are only nicknames, shortened names, titles used as names, or alternate names used in "
    "the story. Never use aliases for jobs, roles, species, traits, relationships, or categories. "
    "Character age, appearance, personality, and background belong in description. Notes and "
    "synopses have no aliases. "
    f"{SUMMARY_INSTRUCTION} Return exactly one create, edit, or keep decision for the active "
    "chapter synopsis. Existing summaries must be targeted by their entryId. "
    "Return exactly one create, edit, or keep decision for Timeline. Timeline description is a "
    "chronological Markdown bullet list; use targeted replacements or append one brief event per "
    "bullet. Keep entries concise and factual, preserve concrete continuity details, and omit "
    "transient action, mood, or copied prose style."
)


def lorebook_edit_operation_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "oneOf": [
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "operation": {"const": "replaceText"},
                    "field": {"const": "description"},
                    "oldText": {"type": "string", "minLength": 1},
                    "newText": {"type": "string"},
                },
                "required": ["operation", "field", "oldText", "newText"],
            },
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "operation": {"const": "appendText"},
                    "field": {"const": "description"},
                    "newText": {"type": "string", "minLength": 1},
                },
                "required": ["operation", "field", "newText"],
            },
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "operation": {"const": "setField"},
                    "field": {"type": "string", "enum": ["name", "category"]},
                    "value": {"type": "string", "minLength": 1},
                },
                "required": ["operation", "field", "value"],
            },
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "operation": {"type": "string", "enum": ["addItems", "removeItems"]},
                    "field": {"type": "string", "enum": ["aliases", "tags"]},
                    "values": {
                        "type": "array",
                        "minItems": 1,
                        "items": {"type": "string", "minLength": 1},
                    },
                },
                "required": ["operation", "field", "values"],
            },
        ],
    }


def lorebook_update_response_format() -> dict[str, Any]:
    createUpdate = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "action": {"const": "create"},
            "name": {"type": "string", "minLength": 1},
            "category": {"type": "string", "enum": sorted(LOREBOOK_CATEGORIES)},
            "description": {"type": "string", "minLength": 1},
            "aliases": {"type": "array", "items": {"type": "string"}},
            "tags": {"type": "array", "items": {"type": "string"}},
            "metadata": {
                "type": "object",
                "additionalProperties": False,
                "properties": {},
            },
        },
        "required": [
            "action", "name", "category", "description", "aliases", "tags", "metadata",
        ],
    }
    editUpdate = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "action": {"const": "edit"},
            "entryId": {"type": "string", "minLength": 1},
            "entryRevision": {"type": "integer", "minimum": 0},
            "operations": {
                "type": "array",
                "minItems": 1,
                "items": lorebook_edit_operation_schema(),
            },
        },
        "required": ["action", "entryId", "entryRevision", "operations"],
    }
    existingDecision = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "action": {"type": "string", "enum": ["exclude", "keep"]},
            "entryId": {"type": "string", "minLength": 1},
            "entryRevision": {"type": "integer", "minimum": 0},
        },
        "required": ["action", "entryId", "entryRevision"],
    }
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
                            "oneOf": [createUpdate, editUpdate, existingDecision],
                        },
                    },
                },
                "required": ["updates"],
            },
        },
    }
