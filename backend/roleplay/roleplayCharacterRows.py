from __future__ import annotations

import sqlite3
from typing import Any

from backend.roleplay.roleplayCharacterQueries import listActiveCharacters

CHARACTER_KINDS = {"cast", "user"}

CHARACTER_DETAIL_LABELS = (
    ("description", "About"),
    ("appearance", "Appearance"),
    ("personality", "Personality"),
    ("speech_style", "Texts like"),
)


def normalizeCharacterKind(kind: Any) -> str:
    value = str(kind or "cast").strip().lower()
    return value if value in CHARACTER_KINDS else "cast"


def rowToCharacter(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "roleplay_id": row["roleplay_id"],
        "name": row["name"],
        "kind": normalizeCharacterKind(row["kind"]),
        "description": row["description"],
        "appearance": row["appearance"],
        "personality": row["personality"],
        "speech_style": row["speech_style"],
        "color": row["color"],
        "disabled": bool(row["disabled"]),
        "character_order": row["character_order"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def characterDetailLines(character: dict[str, Any], indent: str = "") -> list[str]:
    lines = []
    for field, label in CHARACTER_DETAIL_LABELS:
        value = str(character.get(field) or "").strip()
        if value:
            lines.append(f"{indent}{label}: {value}")
    return lines


def castPromptBlock(characters: list[dict[str, Any]]) -> str:
    cast = [character for character in characters if character["kind"] == "cast"]
    userCharacter = next(
        (character for character in characters if character["kind"] == "user"), None
    )

    if not cast and not userCharacter:
        return ""

    lines: list[str] = []

    if cast:
        lines.append("Roleplay cast")
        lines.append("")
        lines.append(
            "This is a group message thread. Reply as the characters below, "
            "one message per line, each line starting with that character's name "
            "and a colon."
        )
        lines.append("")
        lines.append("Characters you play:")
        for character in cast:
            lines.append("")
            lines.append(character["name"])
            lines.extend(characterDetailLines(character))

    if userCharacter:
        lines.append("")
        if cast:
            lines.append(
                f"{userCharacter['name']} is the person you are texting. "
                f"Never write a message as {userCharacter['name']}."
            )
        else:
            lines.append(f"You are texting {userCharacter['name']}.")
        lines.extend(characterDetailLines(userCharacter))

    if cast:
        names = ", ".join(character["name"] for character in cast)
        lines.append("")
        lines.append("How to reply:")
        lines.append(f"- Start every line with one of these exact names and a colon: {names}")
        lines.append(
            "- Send one to four messages a turn. A character can send two in a row, "
            "and a character can stay quiet."
        )
        lines.append("- Keep each message about as long as a real text message.")
        lines.append("- Let the characters react to each other, not only to whoever texted last.")
        lines.append("- No narrator voice, no stage directions, no headings. Only the messages.")

    return "\n".join(lines).strip()


def roleplayCastPrompt(conn: sqlite3.Connection, roleplayId: str) -> str:
    characters = [rowToCharacter(row) for row in listActiveCharacters(conn, roleplayId)]
    return castPromptBlock(characters)


def roleplayUserCharacterName(conn: sqlite3.Connection, roleplayId: str) -> str:
    for row in listActiveCharacters(conn, roleplayId):
        if normalizeCharacterKind(row["kind"]) == "user":
            return str(row["name"] or "").strip()
    return ""
