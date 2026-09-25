import difflib
import re
from typing import Any


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

#what we hand the model in the block map, generous enough to clear the minimum even after it trims a word. every extra character here is paid on every block of every edit request, and is one more character the model can retype wrong
ANCHOR_PROMPT_LENGTH = 40

#a reworded quote still scores far above this against the block it came from, a quote belonging to a different paragraph lands far below it
ANCHOR_SIMILARITY_THRESHOLD = 0.6


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


def anchor_resembles_block(normalizedAnchor: str, blockText: str) -> bool:
    #models retype the quote from memory instead of copying it, so a few reworded words are sloppiness rather than the wrong paragraph
    if not normalizedAnchor:
        return False

    normalizedBlock = normalize_anchor(blockText)
    window = normalizedBlock[:max(len(normalizedAnchor) + ANCHOR_MINIMUM_LENGTH, ANCHOR_MINIMUM_LENGTH)]
    similarity = difflib.SequenceMatcher(None, normalizedAnchor, window).ratio()
    return similarity >= ANCHOR_SIMILARITY_THRESHOLD


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
