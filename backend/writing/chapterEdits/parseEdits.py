import json
import re
from typing import Any

from backend.writing.chapterEdits.editErrors import (
    CHAPTER_EDIT_INVALID_JSON,
    CHAPTER_EDIT_INVALID_OPERATION,
    CHAPTER_EDIT_TRUNCATED,
    ChapterEditError,
)
from backend.writing.chapterEdits.validateEdits import validate_chapter_operation


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


#a cut off replacement would delete the original block and leave half a sentence in its place, so only the operations that purely add prose are worth rescuing
SALVAGEABLE_TRUNCATED_OPERATIONS = {"appendToChapter", "insertBeforeBlock", "insertAfterBlock"}
LAST_FINISHED_SENTENCE_PATTERN = re.compile(r".*[.!?][\"’”')\]]*", re.DOTALL)


def decode_partial_json_string(raw: str, complete: bool) -> str:
    #the tail of a cut off response can land mid escape sequence, so shave a char at a time until what is left decodes
    candidate = raw[:-1] if not complete and raw.endswith("\\") else raw
    while candidate:
        try:
            return json.loads(f'"{candidate}"')
        except json.JSONDecodeError:
            candidate = candidate[:-1]
    return ""


def read_json_string_at(text: str, start: int) -> tuple[str, bool, int]:
    #reads however much of one json string has arrived and reports where it ended, so the caller can keep walking the array
    opening = re.match(r'\s*"', text[start:])
    if not opening:
        return "", False, start

    raw = ""
    escaped = False
    index = start + opening.end()

    while index < len(text):
        char = text[index]
        if escaped:
            raw += char
            escaped = False
        elif char == "\\":
            raw += char
            escaped = True
        elif char == '"':
            return decode_partial_json_string(raw, True), True, index + 1
        else:
            raw += char
        index += 1

    return decode_partial_json_string(raw, False), False, index


def closed_json_field(fragment: str, field: str) -> str | None:
    #only matches once the closing quote landed, a field still being written is not worth guessing at
    match = re.search(rf'"{field}"\s*:\s*"((?:\\.|[^"\\])*)"', fragment)
    if not match:
        return None
    try:
        return json.loads(f'"{match.group(1)}"')
    except json.JSONDecodeError:
        return None


def read_finished_paragraphs(fragment: str, start: int) -> list[str]:
    #only the entries that closed are finished paragraphs, the one still being written is half a thought
    paragraphs: list[str] = []
    cursor = start

    while cursor < len(fragment):
        text, complete, end = read_json_string_at(fragment, cursor)
        if not complete:
            break
        if text.strip():
            paragraphs.append(text)

        cursor = end
        separator = re.match(r"\s*,", fragment[cursor:])
        if not separator:
            break
        cursor += separator.end()

    return paragraphs


def trim_to_last_finished_sentence(text: str) -> str:
    #a string cut off mid word reads as broken prose, so the last sentence end is the last thing worth keeping
    match = LAST_FINISHED_SENTENCE_PATTERN.match(text)
    return match.group(0).rstrip() if match else ""


def salvage_partial_edit(fragment: str) -> dict[str, Any] | None:
    #the edit that was still being written when the run stopped has finished prose in it, and losing that is losing the whole run
    operation = closed_json_field(fragment, "operation")
    if operation not in SALVAGEABLE_TRUNCATED_OPERATIONS:
        return None

    newTextKey = re.search(r'"newText"\s*:\s*(\[)?', fragment)
    if not newTextKey:
        return None

    if newTextKey.group(1):
        paragraphs = read_finished_paragraphs(fragment, newTextKey.end())
    else:
        text, complete, _ = read_json_string_at(fragment, newTextKey.end())
        if not complete:
            text = trim_to_last_finished_sentence(text)
        paragraphs = [text] if text.strip() else []

    if not paragraphs:
        return None

    edit: dict[str, Any] = {"operation": operation, "newText": paragraphs}
    #the anchors are written before the prose, so a run that got this far already has them
    for field in ("blockId", "anchorText"):
        value = closed_json_field(fragment, field)
        if value:
            edit[field] = value
    return edit


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

    #still inside an object at the end of the buffer means the run stopped mid edit, and that edit is usually the only one there is
    if depth > 0 and elementStart is not None:
        partialEdit = salvage_partial_edit(partial[elementStart:])
        if partialEdit is not None:
            edits.append(partialEdit)

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
