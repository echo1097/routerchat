import re
from typing import Any

from backend.writing.chapterEdits.editErrors import (
    CHAPTER_EDIT_INVALID_OPERATION,
    CHAPTER_EDIT_OPERATIONS,
    CHAPTER_EDIT_TARGET_MISMATCH,
    ChapterEditError,
)
from backend.writing.chapterEdits.proseCleanup import validateChapterEditText

CHAPTER_EDIT_FIELD_ALIASES = {
    "startBlockId": "blockId",
    "text": "newText",
}

CHAPTER_EDIT_IGNORED_FIELDS = {
    "expectedTextHash",
    "startExpectedTextHash",
    "endExpectedTextHash",
    "textHash",
    "hash",
    "anchorText",
    "startAnchorText",
    "endAnchorText",
    "anchor",
    "startAnchor",
    "endAnchor",
    "chapterRevision",
    "revision",
}

REPLACE_OPERATIONS = {"replaceBlock", "replaceBlockRange"}
BLOCK_ID_PATTERN = re.compile(r"^([ps])?_?0*(\d+)$", re.IGNORECASE)


def normalizeChapterOperationFields(operation: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(operation)
    for ignored in CHAPTER_EDIT_IGNORED_FIELDS:
        normalized.pop(ignored, None)

    for alias, canonical in CHAPTER_EDIT_FIELD_ALIASES.items():
        if alias not in normalized:
            continue
        value = normalized.pop(alias)
        normalized.setdefault(canonical, value)

    return normalized


def normalizeBlockId(value: Any) -> str:
    if type(value) is int:
        value = str(value)
    if not isinstance(value, str):
        return ""

    text = value.strip()
    match = BLOCK_ID_PATTERN.match(text)
    if not match:
        return text

    prefix = (match.group(1) or "p").lower()
    return f"{prefix}_{int(match.group(2)):03d}"


def requireKnownBlock(blockId: str, blocksById: dict[str, dict[str, Any]]) -> dict[str, Any]:
    block = blocksById.get(blockId)
    if block is None:
        raise ChapterEditError(
            CHAPTER_EDIT_TARGET_MISMATCH,
            f"unknown block id: {blockId}",
        )
    return block


def validateChapterOperation(
    operation: dict[str, Any],
    blocks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not isinstance(operation, dict):
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "chapter edit output must be a JSON object",
        )

    operation = normalizeChapterOperationFields(operation)

    operationType = operation.get("operation")
    if not isinstance(operationType, str) or operationType not in CHAPTER_EDIT_OPERATIONS:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            f"unsupported chapter edit operation: {operationType or 'missing'}",
        )

    blockId = normalizeBlockId(operation.get("blockId"))
    endBlockId = normalizeBlockId(operation.get("endBlockId"))

    missingFields = set()
    if "newText" not in operation:
        missingFields.add("newText")
    if operationType != "appendToChapter" and not blockId:
        missingFields.add("blockId")
    if operationType == "replaceBlockRange" and not endBlockId:
        missingFields.add("endBlockId")
    if missingFields:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            f"missing fields: {', '.join(sorted(missingFields))}",
        )

    newText = operation.get("newText")
    if not isinstance(newText, (str, list)):
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "newText must be an array of paragraphs",
        )
    cleanText = validateChapterEditText(newText)

    if operationType == "appendToChapter":
        return {"operation": operationType, "newText": cleanText}

    isRange = operationType in REPLACE_OPERATIONS and bool(endBlockId) and endBlockId != blockId

    if blocks is not None:
        blocksById = {block["blockId"]: block for block in blocks}
        startBlock = requireKnownBlock(blockId, blocksById)

        if isRange:
            endBlock = requireKnownBlock(endBlockId, blocksById)
            if startBlock["startChar"] > endBlock["startChar"]:
                raise ChapterEditError(
                    CHAPTER_EDIT_TARGET_MISMATCH,
                    "range start block must not follow range end block",
                )

    if isRange:
        return {
            "operation": "replaceBlockRange",
            "startBlockId": blockId,
            "endBlockId": endBlockId,
            "newText": cleanText,
        }

    if operationType in REPLACE_OPERATIONS:
        operationType = "replaceBlock"

    return {"operation": operationType, "blockId": blockId, "newText": cleanText}
