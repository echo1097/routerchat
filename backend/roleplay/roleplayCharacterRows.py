from __future__ import annotations

import sqlite3
from typing import Any

from backend.roleplay.roleplayCharacterQueries import listActiveCharacters
from backend.roleplay.roleplayMacros import expandMacros

CHARACTER_KINDS = {"cast", "user"}

CHARACTER_DETAIL_LABELS = (
    ("description", "About"),
    ("appearance", "Appearance"),
    ("personality", "Personality"),
    ("speech_style", "Voice"),
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
        "greeting": row["greeting"],
        "example_dialogue": row["example_dialogue"],
        "color": row["color"],
        "disabled": bool(row["disabled"]),
        "character_order": row["character_order"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def characterDetailLines(
    character: dict[str, Any], userName: str = "", indent: str = ""
) -> list[str]:
    lines = []
    for field, label in CHARACTER_DETAIL_LABELS:
        value = expandMacros(
            str(character.get(field) or "").strip(), character.get("name", ""), userName
        )
        if value:
            lines.append(f"{indent}{label}: {value}")
    return lines


def exampleDialogueBlock(cast: list[dict[str, Any]], userName: str) -> list[str]:
    examples = [
        (character["name"], expandMacros(
            str(character.get("example_dialogue") or "").strip(),
            character["name"],
            userName,
        ))
        for character in cast
    ]
    examples = [(name, text) for name, text in examples if text]

    if not examples:
        return []

    lines = ["", "How they sound, for reference only. Never replay these as the scene:"]
    for name, example in examples:
        lines.append("")
        lines.append(f"{name}")
        lines.append(example)
    return lines


def castPromptBlock(
    characters: list[dict[str, Any]], scenario: str = ""
) -> str:
    cast = [character for character in characters if character["kind"] == "cast"]
    userCharacter = next(
        (character for character in characters if character["kind"] == "user"), None
    )
    userName = str(userCharacter["name"]).strip() if userCharacter else ""
    scenarioText = expandMacros(
        str(scenario or "").strip(),
        cast[0]["name"] if cast else "",
        userName,
    )

    if not cast and not userCharacter and not scenarioText:
        return ""

    lines: list[str] = []

    if scenarioText:
        lines.append("The scene")
        lines.append("")
        lines.append(scenarioText)
        lines.append("")

    if cast:
        lines.append("Roleplay cast")
        lines.append("")
        lines.append(
            "Play the characters below. Write each reply on its own line, starting with "
            "that character's name and a colon."
        )
        lines.append("")
        lines.append("Characters you play:")
        for character in cast:
            lines.append("")
            lines.append(character["name"])
            lines.extend(characterDetailLines(character, userName))

    if userCharacter:
        lines.append("")
        if cast:
            lines.append(
                f"{userCharacter['name']} is the person playing with you. "
                f"Never write a line as {userCharacter['name']}."
            )
        else:
            lines.append(f"You are playing opposite {userCharacter['name']}.")
        lines.extend(characterDetailLines(userCharacter, userName))

    if cast:
        lines.extend(exampleDialogueBlock(cast, userName))

    if cast:
        names = ", ".join(character["name"] for character in cast)
        lines.append("")
        lines.append("How to reply:")
        lines.append(f"- Start every line with one of these exact names and a colon: {names}")
        lines.append(
            "- A reply is whatever that character would do here: a single word, a line of "
            "dialogue, or a paragraph of what they do, notice and feel. Let the scene set "
            "the length, not a habit."
        )
        lines.append(
            "- Break a turn into separate lines when it reads as separate beats, like another "
            "character cutting in, or a pause before someone speaks again. Keep it as one line "
            "when it is one beat."
        )
        lines.append(
            "- Send as many as the moment calls for. A glance might be one, a real argument "
            "might be twenty. Stop where the scene would naturally rest."
        )
        lines.append(
            "- A character can take several lines in a row, and a character can say nothing all turn."
        )
        lines.append(
            "- Only the characters who would really be there answer. Someone asleep, elsewhere, "
            "out of earshot, or who just walked off stays out until they come back, and then they "
            "come back to whatever they missed."
        )
        lines.append(
            "- Stay in character. Each one keeps their own voice, wants what they want, and only "
            "knows what they would actually know."
        )
        lines.append("- Let the characters react to each other, not only to whoever spoke last.")
        lines.append(
            "- Write only as the characters. No narrator, no scene headings, and no summing up "
            "what just happened."
        )

    return "\n".join(lines).strip()


def roleplayCastPrompt(
    conn: sqlite3.Connection, roleplayId: str, scenario: str = ""
) -> str:
    characters = [rowToCharacter(row) for row in listActiveCharacters(conn, roleplayId)]
    return castPromptBlock(characters, scenario)


def roleplayUserCharacterName(conn: sqlite3.Connection, roleplayId: str) -> str:
    for row in listActiveCharacters(conn, roleplayId):
        if normalizeCharacterKind(row["kind"]) == "user":
            return str(row["name"] or "").strip()
    return ""


def openingGreeting(conn: sqlite3.Connection, roleplayId: str) -> str:
    characters = [rowToCharacter(row) for row in listActiveCharacters(conn, roleplayId)]
    cast = [character for character in characters if character["kind"] == "cast"]
    userName = next(
        (character["name"] for character in characters if character["kind"] == "user"),
        "",
    )

    lines = []
    for character in cast:
        greeting = expandMacros(
            str(character.get("greeting") or "").strip(), character["name"], userName
        )
        if greeting:
            lines.append(f"{character['name']}: {greeting}")

    return "\n".join(lines)
