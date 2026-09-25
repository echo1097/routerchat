from typing import Any

from backend.writing.chapterEdits.anchors import chapter_blocks
from backend.writing.chapterEdits.editErrors import (
    CHAPTER_EDIT_CONFLICTING_EDITS,
    CHAPTER_EDIT_INVALID_OPERATION,
    CHAPTER_EDIT_REVISION_MISMATCH,
    CHAPTER_EDIT_TARGET_MISMATCH,
    ChapterEditError,
)
from backend.writing.chapterEdits.proseCleanup import clean_insert_text
from backend.writing.chapterEdits.validateEdits import validate_chapter_operation


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
    for index, (edit, footprint) in enumerate(zip(batch["edits"], footprints, strict=True)):
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
