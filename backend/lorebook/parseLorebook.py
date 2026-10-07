import json
from typing import Any


def stripJsonFence(value: str) -> str:
    text = value.strip()
    if not text.startswith("```"):
        return text

    lines = text.splitlines()
    if len(lines) < 2:
        return text
    if lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return "\n".join(lines[1:]).strip()


def firstJsonObject(value: str) -> str:
    start = value.find("{")
    if start < 0:
        raise ValueError("No JSON object found in lorebook output.")

    depth = 0
    inString = False
    escapeNext = False
    for index, char in enumerate(value[start:], start):
        if escapeNext:
            escapeNext = False
            continue
        if char == "\\" and inString:
            escapeNext = True
            continue
        if char == "\"":
            inString = not inString
            continue
        if inString:
            continue
        if char == "{":
            depth += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                return value[start:index + 1]

    raise ValueError("Unclosed JSON object in lorebook output.")


def parseLorebookJson(raw_output: str) -> dict[str, Any]:
    parse_errors: list[str] = []
    candidates = [raw_output.strip(), stripJsonFence(raw_output)]

    try:
        candidates.append(firstJsonObject(candidates[-1]))
    except ValueError as exc:
        parse_errors.append(str(exc))

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError as exc:
            parse_errors.append(str(exc))
            continue
        if isinstance(parsed, dict):
            return parsed
        parse_errors.append("Lorebook output JSON was not an object.")

    raise ValueError("; ".join(parse_errors) or "Could not parse lorebook JSON.")
