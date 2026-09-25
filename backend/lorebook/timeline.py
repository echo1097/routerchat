import re

TIMELINE_BULLET_MARKERS = ("-", "*", "•")
INLINE_TIMELINE_BULLET = re.compile(r"\s+[-*•]\s+")
SENTENCE_ENDINGS = ".!?\"')"


def split_crammed_timeline_bullets(line: str) -> list[str]:
    body = line
    for marker in TIMELINE_BULLET_MARKERS:
        body = body.removeprefix(marker)
    body = body.strip()

    separators = list(INLINE_TIMELINE_BULLET.finditer(body))
    if not separators:
        return []

    #a bullet boundary reads like the end of a sentence, a hyphen sitting inside one does not, so a
    #lone separator has to earn it, two or more is already too repetitive to be ordinary prose
    endsSentence = all(body[separator.start() - 1] in SENTENCE_ENDINGS for separator in separators)
    if not endsSentence and len(separators) < 2:
        return []

    parts = [part.strip() for part in INLINE_TIMELINE_BULLET.split(body)]
    parts = [part for part in parts if part]
    if len(parts) < 2:
        return []

    #a real event is a sentence, so any one or two word fragment means we chopped something like a
    #date range in half rather than finding actual bullets, and we leave the line alone
    if any(len(part.split()) < 3 for part in parts):
        return []
    return parts


def normalize_timeline_description(description: str) -> str:
    rawLines = [line.strip() for line in str(description or "").splitlines()]
    rawLines = [line for line in rawLines if line]

    #some models ignore the newline instruction and cram every bullet onto one line, only worth
    #unpicking when nothing split on its own, otherwise we would go hunting inside good output
    if len(rawLines) == 1:
        crammedBullets = split_crammed_timeline_bullets(rawLines[0])
        if crammedBullets:
            rawLines = crammedBullets

    lines = []
    for value in rawLines:
        if value.startswith("- "):
            lines.append(value)
            continue
        lines.append(f"- {value.removeprefix('-').removeprefix('*').strip()}")
    return "\n".join(lines)
