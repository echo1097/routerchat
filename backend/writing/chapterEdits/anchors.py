import re
from typing import Any


def isSceneBreak(value: str) -> bool:
    text = value.strip()
    if text in {"***", "---", "# # #"}:
        return True
    return bool(re.fullmatch(r"[*_\-]{3,}", text))


ANCHOR_MINIMUM_LENGTH = 24
ANCHOR_PROMPT_LENGTH = 40


def anchorForBlock(text: str) -> str:
    if len(text) <= ANCHOR_PROMPT_LENGTH:
        return text

    head = text[:ANCHOR_PROMPT_LENGTH]
    lastSpace = head.rfind(" ")
    if lastSpace >= ANCHOR_MINIMUM_LENGTH:
        head = head[:lastSpace]
    return head.strip()


def chapterBlocks(content: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    paragraph_index = 0
    scene_index = 0

    #dot stops at \n by default, so this is naturally one match per physical line, blank lines just fall through as separators
    for match in re.finditer(r"\S.*", content or ""):
        text = match.group(0).strip()
        if not text:
            continue

        if isSceneBreak(text):
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
                "anchorText": anchorForBlock(text),
                "startChar": match.start(),
                "endChar": match.start() + len(match.group(0).rstrip()),
            }
        )

    return blocks


def blockMapForPrompt(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "blockId": block["blockId"],
            "type": block["type"],
            "index": block["index"],
            "startsWith": block["anchorText"],
        }
        for block in blocks
    ]
