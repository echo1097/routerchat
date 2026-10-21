from __future__ import annotations

import re

MACRO_PATTERN = re.compile(r"\{\{\s*(char|user)\s*\}\}", re.IGNORECASE)


def expandMacros(text: str, characterName: str = "", userName: str = "") -> str:
    if not text:
        return ""

    replacements = {
        "char": characterName or "the character",
        "user": userName or "you",
    }

    return MACRO_PATTERN.sub(
        lambda match: replacements[match.group(1).lower()], text
    )
