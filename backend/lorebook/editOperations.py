import re
import sqlite3
from typing import Any

from backend.lorebook.lorebookRows import (
    LOREBOOK_CATEGORIES,
    jsonDict,
    jsonList,
    normalizeLorebookCategory,
    sanitizeLorebookAliases,
    sanitizeLorebookMetadata,
)
from backend.lorebook.timeline import normalizeTimelineDescription


def skippedLorebookUpdate(
    index: int,
    code: str,
    message: str,
    update: Any,
    operation_index: int | None = None,
) -> dict[str, Any]:
    item = {
        "index": index,
        "code": code,
        "message": message,
        "entryId": str(update.get("entryId") or "") if isinstance(update, dict) else "",
    }
    if operation_index is not None:
        item["operationIndex"] = operation_index
    return item


def appendLorebookText(description: str, new_text: str, category: str) -> str:
    addition = str(new_text or "").strip()
    if not addition:
        raise ValueError("appendText newText cannot be empty")
    if not description.strip():
        return addition
    separator = "\n" if category == "timeline" else "\n\n"
    return description.rstrip() + separator + addition


def applyLorebookEditOperations(
    entry: sqlite3.Row,
    operations: Any,
    update_index: int,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[str]]:
    nextEntry = {
        "name": str(entry["name"]),
        "category": normalizeLorebookCategory(entry["category"]),
        "description": str(entry["description"] or ""),
        "aliases": jsonList(entry["aliases_json"]),
        "tags": jsonList(entry["tags_json"]),
        "metadata": jsonDict(entry["metadata_json"]),
    }
    skipped: list[dict[str, Any]] = []
    appliedOperations: list[str] = []
    if not isinstance(operations, list) or not operations:
        return nextEntry, [skippedLorebookUpdate(
            update_index,
            "lorebook_edit_invalid_operations",
            "edit operations must contain at least one operation",
            {"entryId": entry["id"]},
        )], appliedOperations

    replacementSpans: dict[int, tuple[int, int, str]] = {}
    replacementErrors: dict[int, str] = {}
    claimedSpans: list[tuple[int, int]] = []
    originalDescription = nextEntry["description"]
    for operationIndex, operation in enumerate(operations):
        if not isinstance(operation, dict) or operation.get("operation") != "replaceText":
            continue
        if operation.get("field") != "description":
            replacementErrors[operationIndex] = "replaceText only supports the description field"
            continue
        oldText = str(operation.get("oldText") or "")
        if not oldText:
            replacementErrors[operationIndex] = "replaceText oldText cannot be empty"
            continue
        matches = [match.start() for match in re.finditer(re.escape(oldText), originalDescription)]
        if not matches:
            replacementErrors[operationIndex] = "replaceText oldText was not found in the entry"
            continue
        if len(matches) != 1:
            replacementErrors[operationIndex] = "replaceText oldText matched more than once"
            continue
        span = (matches[0], matches[0] + len(oldText))
        if any(span[0] < claimedEnd and claimedStart < span[1] for claimedStart, claimedEnd in claimedSpans):
            replacementErrors[operationIndex] = "replaceText overlaps another replacement"
            continue
        claimedSpans.append(span)
        replacementSpans[operationIndex] = (
            span[0], span[1], str(operation.get("newText") or "")
        )

    for start, end, newText in sorted(replacementSpans.values(), reverse=True):
        nextEntry["description"] = (
            nextEntry["description"][:start] + newText + nextEntry["description"][end:]
        )

    for operationIndex, operation in enumerate(operations):
        if not isinstance(operation, dict):
            skipped.append(skippedLorebookUpdate(
                update_index,
                "lorebook_edit_invalid_operation",
                "operation must be an object",
                {"entryId": entry["id"]},
                operationIndex,
            ))
            continue

        operationType = str(operation.get("operation") or "")
        try:
            if operationType == "replaceText":
                if operationIndex in replacementErrors:
                    raise ValueError(replacementErrors[operationIndex])
                if operationIndex not in replacementSpans:
                    raise ValueError("replaceText could not be resolved")
            elif operationType == "appendText":
                if operation.get("field") != "description":
                    raise ValueError("appendText only supports the description field")
                nextEntry["description"] = appendLorebookText(
                    nextEntry["description"],
                    str(operation.get("newText") or ""),
                    nextEntry["category"],
                )
            elif operationType == "setField":
                field = str(operation.get("field") or "")
                value = str(operation.get("value") or "").strip()
                if field == "name":
                    if not value:
                        raise ValueError("entry name cannot be empty")
                    nextEntry["name"] = value
                elif field == "category":
                    normalizedCategory = normalizeLorebookCategory(value)
                    if value.strip().lower() not in LOREBOOK_CATEGORIES:
                        raise ValueError("setField category is not supported")
                    if (
                        normalizedCategory in {"synopsis", "timeline"}
                        and normalizedCategory != normalizeLorebookCategory(entry["category"])
                    ):
                        raise ValueError("setField cannot turn a normal entry into a synopsis or Timeline")
                    nextEntry["category"] = normalizedCategory
                else:
                    raise ValueError("setField only supports name or category")
            elif operationType in {"addItems", "removeItems"}:
                field = str(operation.get("field") or "")
                if field not in {"aliases", "tags"}:
                    raise ValueError("list operations only support aliases or tags")
                values = operation.get("values")
                if not isinstance(values, list) or not values:
                    raise ValueError("list operation values cannot be empty")
                cleanValues = [str(value).strip() for value in values if str(value).strip()]
                if not cleanValues:
                    raise ValueError("list operation values cannot be empty")
                currentValues = [str(value) for value in nextEntry[field]]
                if operationType == "addItems":
                    known = {value.casefold() for value in currentValues}
                    for value in cleanValues:
                        normalizedValue = value.casefold()
                        if normalizedValue in known:
                            continue
                        currentValues.append(value)
                        known.add(normalizedValue)
                else:
                    removed = {value.casefold() for value in cleanValues}
                    currentValues = [
                        value for value in currentValues if value.casefold() not in removed
                    ]
                nextEntry[field] = currentValues
            else:
                raise ValueError(f"unsupported lorebook edit operation: {operationType or 'missing'}")
        except ValueError as exc:
            skipped.append(skippedLorebookUpdate(
                update_index,
                "lorebook_edit_invalid_operation",
                str(exc),
                {"entryId": entry["id"]},
                operationIndex,
            ))
            continue

        appliedOperations.append(operationType)

    nextEntry["aliases"] = sanitizeLorebookAliases(
        nextEntry["category"], nextEntry["aliases"], nextEntry["name"]
    )
    nextEntry["metadata"] = sanitizeLorebookMetadata(
        nextEntry["category"], nextEntry["metadata"]
    )
    if nextEntry["category"] == "timeline":
        nextEntry["name"] = "Timeline"
        nextEntry["description"] = normalizeTimelineDescription(nextEntry["description"])
    return nextEntry, skipped, appliedOperations
