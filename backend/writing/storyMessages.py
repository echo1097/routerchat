import json
import sqlite3
from typing import Any

from backend.lorebook.lorebookRows import lorebook_context_line
from backend.writing.chapterEdits.anchors import block_map_for_prompt


def effective_generation_mode(requested_mode: str | None, chapter_content: str) -> str:
    mode = str(requested_mode or "new").lower()
    if mode not in {"edit", "new"}:
        mode = "new"
    if mode == "edit" and not chapter_content.strip():
        return "new"
    return mode


def build_story_messages(
    story: sqlite3.Row,
    chapter: sqlite3.Row,
    lorebook_rows: list[sqlite3.Row],
    prompt: str,
    system_prompt: str,
    generation_mode: str = "new",
    blocks: list[dict[str, Any]] | None = None,
    repair_context: dict[str, Any] | None = None,
    attachment_parts: list[dict[str, Any]] | None = None,
    previous_chapters: list[sqlite3.Row] | None = None,
) -> list[dict[str, Any]]:
    lorebook_text = "\n".join(
        lorebook_context_line(row)
        for row in lorebook_rows
        if not bool(row["disabled"]) and row["description"].strip()
    )
    visiblePrevious = [row for row in (previous_chapters or []) if not bool(row["disabled"])]
    previousChapterTexts = [
        f"previous chapter {index + 1}: {row['title']}\n{row['content'] or 'empty chapter'}"
        for index, row in enumerate(visiblePrevious)
    ]

    storyParts = [
        f"story title: {story['title']}",
        f"author: {story['author'] or 'unknown'}",
        f"language: {story['language'] or 'English'}",
        f"synopsis: {story['synopsis'] or 'none yet'}",
    ]

    chapterParts = [
        f"chapter title: {chapter['title']}",
        f"chapter revision: {chapter['revision']}",
        f"current chapter draft:\n{chapter['content'] or 'empty chapter'}",
    ]
    if generation_mode == "edit":
        chapterParts.append(
            "chapter block map:\n"
            + json.dumps(block_map_for_prompt(blocks or []), ensure_ascii=False, indent=2)
        )

    messages: list[dict[str, Any]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})

    messages.append({"role": "user", "content": "\n\n".join(storyParts)})
    if lorebook_text:
        messages.append({"role": "user", "content": f"lorebook:\n{lorebook_text}"})

    for previousChapterText in previousChapterTexts:
        messages.append({"role": "user", "content": previousChapterText})

    if generation_mode == "edit":
        messages.append(
            {
                "role": "user",
                "content": (
                    "You are editing the active chapter. Return only one JSON object with no "
                    "Markdown fence, explanation, or wrapper text, shaped as {\"chapterRevision\": N, "
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
                    "newText is an array of paragraphs: one array entry per paragraph, in the "
                    "order they should appear, each entry chapter Markdown rather than wrapper "
                    "Markdown. Three paragraphs of prose means three entries. Write each entry "
                    "as ordinary running text with no line breaks inside it, and never write a "
                    "\\n escape anywhere. Preserve normal spaces between every word and sentence, "
                    "and never join the end of one sentence directly to the start of the next. "
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
                "role": "user",
                "content": (
                    "You are writing prose for the active chapter. Return only the prose "
                    "to insert into the chapter, with no analysis or wrapper text."
                ),
            }
        )

    chapterText = "\n\n".join(chapterParts)
    requestText = f"request:\n{prompt}" if prompt.strip() else ""

    if attachment_parts:
        promptContent = [{"type": "text", "text": chapterText}, *attachment_parts]
        if requestText:
            promptContent.append({"type": "text", "text": requestText})
        messages.append({"role": "user", "content": promptContent})
    else:
        lastText = f"{chapterText}\n\n{requestText}" if requestText else chapterText
        messages.append({"role": "user", "content": lastText})

    #a repair sees its own failed output plus a block map rebuilt from the chapter as it stands now, which is the part it got wrong last time
    if generation_mode == "edit" and repair_context:
        previous = str(repair_context.get("previous_output") or "").strip()
        if previous:
            messages.append({"role": "assistant", "content": previous})
        messages.append({"role": "user", "content": repair_instructions(repair_context)})

    return messages


def mark_story_cache_points(
    messages: list[dict[str, Any]],
    cache_control: dict[str, Any],
) -> list[dict[str, Any]]:
    stableIndex = lastUserMessageIndex(messages, ("story title:", "lorebook:"))
    previousChapterIndex = lastUserMessageIndex(messages, ("previous chapter ",))
    markedIndexes = {index for index in (stableIndex, previousChapterIndex) if index is not None}

    marked: list[dict[str, Any]] = []
    for index, message in enumerate(messages):
        if index in markedIndexes:
            message = {
                **message,
                "content": [{"type": "text", "text": message["content"], "cache_control": cache_control}],
            }
        marked.append(message)

    return marked


def lastUserMessageIndex(messages: list[dict[str, Any]], prefixes: tuple[str, ...]) -> int | None:
    found = None
    for index, message in enumerate(messages):
        content = message["content"]
        if message["role"] == "user" and isinstance(content, str) and content.startswith(prefixes):
            found = index
    return found


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
            "These are the edits that failed. If an error mentions targeting, reuse the prose and "
            "re-anchor it against the block map. If it mentions newText, resend it as an array "
            "with one entry per paragraph:\n"
            + json.dumps(failed, ensure_ascii=False, indent=2)
        )
    parts.append(
        "Reply with one corrected JSON object in the same shape, containing only the edits that "
        "still need to be made. Copy anchorText exactly from the block map."
    )
    return "\n\n".join(parts)
