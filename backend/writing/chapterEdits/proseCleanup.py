import re
from typing import Any

from backend.writing.chapterEdits.editErrors import (
    CHAPTER_EDIT_INVALID_OPERATION,
    ChapterEditError,
)


def clean_insert_text(value: Any) -> str:
    return str(value or "").strip()


RUN_TOGETHER_SENTENCE_PATTERN = re.compile(r"([.!?])([\u2019\u201d\"')\]]?)([A-Z])")
AMBIGUOUS_QUOTES = {"'", '"'}
UNBROKEN_PROSE_WORD_LIMIT = 300
AUTO_PARAGRAPH_TARGET_WORDS = 110
SENTENCE_END_PATTERN = re.compile(r"[.!?](?:[\"\u2019\u201d')\]]+)?(?=\s+)")
MARKDOWN_LINE_PATTERN = re.compile(
    r"^(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|```|~~~|[*_-]{3,}\s*$)"
)


def paragraphize_unbroken_prose(text: str) -> str:
    if "\n" in text or len(text.split()) <= UNBROKEN_PROSE_WORD_LIMIT:
        return text

    paragraphs: list[str] = []
    paragraphStart = 0
    for match in SENTENCE_END_PATTERN.finditer(text):
        candidate = text[paragraphStart:match.end()].strip()
        if len(candidate.split()) < AUTO_PARAGRAPH_TARGET_WORDS:
            continue

        paragraphs.append(candidate)
        paragraphStart = match.end()

    remainder = text[paragraphStart:].strip()
    if remainder:
        paragraphs.append(remainder)

    #a giant run-on sentence has no safe boundary, so leave it for the format guard to reject
    return "\n\n".join(paragraphs) if len(paragraphs) > 1 else text


def chapter_edit_text_source(value: Any) -> str:
    #paragraphs arrive as a list so the model never has to type an escape sequence, a plain string still works for anything that sends the old shape
    if isinstance(value, (list, tuple)):
        paragraphs = [str(item or "").strip() for item in value]
        return "\n\n".join(paragraph for paragraph in paragraphs if paragraph)
    return str(value or "")


def ends_an_initial(text: str, index: int) -> bool:
    #"G.H." and "A.J." are initials, so the dot after a lone capital is punctuation rather than a sentence end
    letter = index - 1
    if letter < 0 or not text[letter].isupper():
        return False
    return letter == 0 or not text[letter - 1].isalpha()


def quote_opens_dialogue(text: str, quoteIndex: int) -> bool:
    #a straight quote reads as both ends of a quotation, so parity over the ones already used says which end this is. an apostrophe inside a word is punctuation and never counts
    quote = text[quoteIndex]
    used = 0
    for index in range(quoteIndex):
        if text[index] != quote:
            continue
        before = text[index - 1] if index else " "
        after = text[index + 1] if index + 1 < len(text) else " "
        if before.isalpha() and after.isalpha():
            continue
        used += 1

    return used % 2 == 0


def repair_run_together_sentences(text: str) -> str:
    def spaceOut(match: re.Match[str]) -> str:
        index = match.start()
        #the last dot of an ellipsis is normal punctuation, "...Fine." is not two sentences
        if text[max(0, index - 2):index] == "..":
            return match.group(0)
        if ends_an_initial(text, index):
            return match.group(0)

        sentenceEnd, quote, nextSentence = match.groups()
        #the space belongs in front of a quote that is opening the next line of dialogue, not behind it
        if quote in AMBIGUOUS_QUOTES and quote_opens_dialogue(text, match.start(2)):
            return f"{sentenceEnd} {quote}{nextSentence}"
        return f"{sentenceEnd}{quote} {nextSentence}"

    return RUN_TOGETHER_SENTENCE_PATTERN.sub(spaceOut, text)


def repair_prose_lines(text: str) -> str:
    repairedLines: list[str] = []
    inFence = False
    for line in text.split("\n"):
        stripped = line.lstrip()
        isFence = stripped.startswith("```") or stripped.startswith("~~~")

        if not inFence and not isFence:
            line = repair_run_together_sentences(line)

        repairedLines.append(line)
        if isFence:
            inFence = not inFence

    return "\n".join(repairedLines)


def normalize_chapter_edit_text(value: Any) -> str:
    text = chapter_edit_text_source(value).replace("\r\n", "\n").replace("\r", "\n")
    text = repair_prose_lines(text)
    text = paragraphize_unbroken_prose(text)
    lines = [line.rstrip() for line in text.split("\n")]

    normalizedLines: list[str] = []
    inFence = False
    for line in lines:
        stripped = line.lstrip()
        isFence = stripped.startswith("```") or stripped.startswith("~~~")

        if normalizedLines and line and normalizedLines[-1]:
            previous = normalizedLines[-1].lstrip()
            previousIsMarkdown = bool(MARKDOWN_LINE_PATTERN.match(previous))
            currentIsMarkdown = bool(MARKDOWN_LINE_PATTERN.match(stripped))
            #models commonly use one newline between prose paragraphs, markdown needs two to keep them separate
            if not inFence and not previousIsMarkdown and not currentIsMarkdown:
                normalizedLines.append("")

        normalizedLines.append(line)
        if isFence:
            inFence = not inFence

    compactLines: list[str] = []
    inFence = False
    blankCount = 0
    for line in normalizedLines:
        stripped = line.lstrip()
        isFence = stripped.startswith("```") or stripped.startswith("~~~")
        if not line and not inFence:
            blankCount += 1
            if blankCount > 1:
                continue
        else:
            blankCount = 0

        compactLines.append(line)
        if isFence:
            inFence = not inFence

    return "\n".join(compactLines).strip()


def validate_chapter_edit_text(value: Any) -> str:
    #formatting is repaired on the way in rather than rejected, prose the author paid for is never thrown away over punctuation
    normalized = normalize_chapter_edit_text(value)
    if not normalized:
        raise ChapterEditError(
            CHAPTER_EDIT_INVALID_OPERATION,
            "newText must contain at least one non-empty paragraph",
        )
    return normalized
