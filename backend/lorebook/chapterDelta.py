import difflib
from typing import Any

from backend.writing.chapterEdits.anchors import chapterBlocks

NEW_PROSE_OPEN = "<<new>>"
NEW_PROSE_CLOSE = "<</new>>"

PROSE_NOTE = (
    "Paragraphs between <<new>> and <</new>> are new or changed since the last lorebook update. "
    "Everything outside the markers was already recorded; do not add it again. removed_prose "
    "lists deleted paragraphs whose facts may need removing."
)


def chapterDelta(previousText: str, currentText: str) -> dict[str, Any]:
    previousBlocks = chapterBlocks(previousText or "")
    currentBlocks = chapterBlocks(currentText or "")
    matcher = difflib.SequenceMatcher(
        None,
        [block["text"] for block in previousBlocks],
        [block["text"] for block in currentBlocks],
        autojunk=False,
    )

    changedIndexes: set[int] = set()
    removed: list[str] = []
    for tag, previousStart, previousEnd, currentStart, currentEnd in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag in {"replace", "insert"}:
            changedIndexes.update(range(currentStart, currentEnd))
        if tag == "delete":
            removed.extend(block["text"] for block in previousBlocks[previousStart:previousEnd])

    pieces: list[str] = []
    cursor = 0
    for index, block in enumerate(currentBlocks):
        if index not in changedIndexes:
            continue
        pieces.append(currentText[cursor:block["startChar"]])
        pieces.append(NEW_PROSE_OPEN)
        pieces.append(currentText[block["startChar"]:block["endChar"]])
        pieces.append(NEW_PROSE_CLOSE)
        cursor = block["endChar"]
    pieces.append(currentText[cursor:])

    return {
        "changed": bool(changedIndexes) or bool(removed),
        "markedText": "".join(pieces),
        "removed": removed,
    }


def lorebookProseForPrompt(snapshotText: str | None, sourceText: str) -> dict[str, Any]:
    if snapshotText is None:
        return {"new_prose": sourceText}

    delta = chapterDelta(snapshotText, sourceText)
    return {
        "new_prose": delta["markedText"],
        "removed_prose": delta["removed"],
        "prose_note": PROSE_NOTE,
    }
