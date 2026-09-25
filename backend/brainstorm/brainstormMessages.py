import sqlite3
from typing import Any

from backend.lorebook.lorebookRows import lorebook_context_line
from backend.lorebook.parseLorebook import parse_lorebook_json


def brainstorm_response_format(ideaCount: int) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "brainstorm_ideas",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "ideas": {
                        "type": "array",
                        "minItems": ideaCount,
                        "maxItems": ideaCount,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "title": {"type": "string", "minLength": 1},
                                "content": {"type": "string", "minLength": 1},
                            },
                            "required": ["title", "content"],
                        },
                    },
                },
                "required": ["ideas"],
            },
        },
    }


def parse_brainstorm_ideas(raw_output: str) -> list[dict[str, str]]:
    try:
        parsed = parse_lorebook_json(raw_output)
    except ValueError as exc:
        raise ValueError("Could not parse the brainstorm ideas response.") from exc
    raw_ideas = parsed.get("ideas")
    if not isinstance(raw_ideas, list):
        raise ValueError("Brainstorm output must contain an ideas array.")

    ideas: list[dict[str, str]] = []
    for raw_idea in raw_ideas:
        if not isinstance(raw_idea, dict):
            raise ValueError("Every brainstorm idea must be an object.")
        title = str(raw_idea.get("title") or "").strip()
        content = str(raw_idea.get("content") or "").strip()
        if not title or not content:
            raise ValueError("Every brainstorm idea must include a title and content.")
        ideas.append({"title": title, "content": content})

    if not ideas:
        raise ValueError("Brainstorm output must contain at least one complete idea.")
    return ideas


def build_brainstorm_messages(
    story: sqlite3.Row,
    chapters: list[sqlite3.Row],
    lorebook_rows: list[sqlite3.Row],
    branch_nodes: list[sqlite3.Row],
    prompt: str,
    idea_count: int = 3,
) -> list[dict[str, str]]:
    visibleChapters = [chapter for chapter in chapters if not bool(chapter["disabled"])]
    chapterText = "\n\n".join(
        f"chapter {index + 1}: {chapter['title']}\n{chapter['content'] or 'empty chapter'}"
        for index, chapter in enumerate(visibleChapters)
    ) or "no visible chapters yet"
    lorebook_text = "\n".join(
        lorebook_context_line(row)
        for row in lorebook_rows
        if not bool(row["disabled"]) and row["description"].strip()
    ) or "no enabled lorebook entries"
    branch_text = "\n\n".join(
        f"{row['node_type']}: {row['title']}\n{row['content']}"
        for row in branch_nodes
    ) or "this is a new root brainstorm"

    context = (
        f"story title: {story['title']}\n"
        f"author: {story['author'] or 'unknown'}\n"
        f"language: {story['language'] or 'English'}\n"
        f"synopsis: {story['synopsis'] or 'none yet'}\n\n"
        f"all visible chapters:\n{chapterText}\n\n"
        f"lorebook:\n{lorebook_text}\n\n"
        f"selected brainstorm branch:\n{branch_text}"
    )

    messages: list[dict[str, str]] = []
    if story["system_prompt"].strip():
        messages.append({"role": "system", "content": story["system_prompt"].strip()})
    messages.append(
        {
            "role": "system",
            "content": (
                "You are a fiction brainstorming partner. Use the complete story context and the "
                "selected branch to propose distinct, story-specific continuations. Return only one "
                f"JSON object with an ideas array containing exactly {idea_count} objects. Every object must have a "
                "short title and a content field with 2 to 4 concise sentences. Do not write prose "
                "for the chapter and do not wrap the JSON in markdown."
            ),
        }
    )
    messages.append({"role": "user", "content": context})
    messages.append({"role": "user", "content": prompt})
    return messages
