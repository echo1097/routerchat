from typing import Any

from backend.writing.chapterEdits.anchors import (
    anchor_resembles_block,
    normalize_anchor,
    resolve_block_by_anchor,
)
from backend.writing.chapterEdits.editErrors import (
    CHAPTER_EDIT_INVALID_OPERATION,
    CHAPTER_EDIT_OPERATIONS,
    CHAPTER_EDIT_REVISION_MISMATCH,
    CHAPTER_EDIT_TARGET_MISMATCH,
    ChapterEditError,
)
from backend.writing.chapterEdits.proseCleanup import validate_chapter_edit_text

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
    if not isinstance(newText, (str, list)):
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "newText must be an array of paragraphs",
        )
    operation["newText"] = validate_chapter_edit_text(newText)

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

            namedBlock = block
            if namedBlock is not None and normalizedAnchor in normalize_anchor(namedBlock["text"]):
                targetBlocks.append(namedBlock)
                operation[blockIdField] = namedBlock["blockId"]
                continue

            #the quoted prose is a better witness than the models block id bookkeeping, so an exact quote elsewhere still wins the block
            block = resolve_block_by_anchor(blocks, normalizedAnchor)

            #nothing quoted it exactly, so a block id that names a real paragraph the quote clearly came from is the model rewording rather than losing its place
            if block is None and namedBlock is not None and anchor_resembles_block(normalizedAnchor, namedBlock["text"]):
                block = namedBlock

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
