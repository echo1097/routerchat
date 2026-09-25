import difflib
import sqlite3
import uuid
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel


def word_count(value: str) -> int:
    return len(value.split())


def word_diff_counts(before: str, after: str) -> tuple[int, int]:
    #words not lines, because a prose line is a whole paragraph and one swapped word would otherwise score the same as a full rewrite
    beforeLines = [line for line in (before or "").splitlines() if line.strip()]
    afterLines = [line for line in (after or "").splitlines() if line.strip()]

    wordsAdded = 0
    wordsRemoved = 0
    #line pass first so the expensive word pass only runs on the blocks that actually moved
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, beforeLines, afterLines).get_opcodes():
        if tag == "equal":
            continue
        if tag == "insert":
            wordsAdded += sum(len(line.split()) for line in afterLines[j1:j2])
            continue
        if tag == "delete":
            wordsRemoved += sum(len(line.split()) for line in beforeLines[i1:i2])
            continue

        beforeWords = " ".join(beforeLines[i1:i2]).split()
        afterWords = " ".join(afterLines[j1:j2]).split()
        #autojunk off, it treats common words like "the" as noise and wrecks the counts on real prose
        matcher = difflib.SequenceMatcher(None, beforeWords, afterWords, autojunk=False)
        for wordTag, a1, a2, b1, b2 in matcher.get_opcodes():
            if wordTag in {"replace", "delete"}:
                wordsRemoved += a2 - a1
            if wordTag in {"replace", "insert"}:
                wordsAdded += b2 - b1

    return wordsAdded, wordsRemoved


def format_duration(ms: float) -> str:
    seconds = max(1, round(ms / 1000))
    return f"{seconds} {'second' if seconds == 1 else 'seconds'}"


def display_model_name(model: str) -> str:
    name = str(model or "Model").split("/")[-1]
    name = name.replace(":free", "").replace("-", " ").replace("_", " ")
    return " ".join(part[:1].upper() + part[1:] for part in name.split())


def request_updates(payload: BaseModel, reject_null: bool = False) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        updates = payload.model_dump(exclude_unset=True)
    else:
        updates = payload.dict(exclude_unset=True)

    if reject_null:
        null_fields = [key for key, value in updates.items() if value is None]
        if null_fields:
            raise HTTPException(
                status_code=422,
                detail=f"Fields cannot be null: {', '.join(null_fields)}.",
            )
    return updates


def row_to_story(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "author": row["author"],
        "language": row["language"],
        "synopsis": row["synopsis"],
        "model": row["model"],
        "system_prompt": row["system_prompt"],
        "temperature": row["temperature"],
        "max_tokens": row["max_tokens"],
        "thinking_enabled": bool(row["thinking_enabled"]),
        "reasoning_effort": row["reasoning_effort"],
        "temporary": bool(row["temporary"]),
        "lorebook_auto": bool(row["lorebook_auto"]),
        "lorebook_model": row["lorebook_model"] or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_chapter(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "title": row["title"],
        "content": row["content"],
        "word_count": row["word_count"],
        "revision": row["revision"],
        "order_index": row["order_index"],
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_chapter_history_entry(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "chapter_id": row["chapter_id"],
        "run_id": row["run_id"],
        "label": row["label"],
        "detail": row["detail"],
        "entry_order": row["entry_order"],
        "kind": row["kind"],
        "words_added": row["words_added"],
        "words_removed": row["words_removed"],
        "cost": row["cost"],
        "created_at": row["created_at"],
    }


def row_to_story_generation(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "story_id": row["story_id"],
        "chapter_id": row["chapter_id"],
        "model": row["model"],
        "generation_id": row["generation_id"],
        "prompt_tokens": row["prompt_tokens"],
        "completion_tokens": row["completion_tokens"],
        "reasoning_tokens": row["reasoning_tokens"],
        "total_tokens": row["total_tokens"],
        "cost": row["cost"],
        "provider_name": row["provider_name"],
        "generation_time": row["generation_time"],
        "latency": row["latency"],
        "created_at": row["created_at"],
    }


def next_chapter_order(conn: sqlite3.Connection, story_id: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order
        FROM chapters
        WHERE story_id = ?
        """,
        (story_id,),
    ).fetchone()
    return int(row["next_order"])


def next_chapter_history_order(conn: sqlite3.Connection, chapter_id: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(entry_order), -1) + 1 AS next_order
        FROM chapter_history_entries
        WHERE chapter_id = ?
        """,
        (chapter_id,),
    ).fetchone()
    return int(row["next_order"])


def insert_chapter_history_entry(
    conn: sqlite3.Connection,
    *,
    story_id: str,
    chapter_id: str,
    run_id: str,
    label: str,
    detail: str,
    now: str,
    kind: str | None = None,
    words_added: int | None = None,
    words_removed: int | None = None,
    cost: float | None = None,
) -> dict[str, Any]:
    entry_id = str(uuid.uuid4())
    entry_order = next_chapter_history_order(conn, chapter_id)
    conn.execute(
        """
        INSERT INTO chapter_history_entries (
          id, story_id, chapter_id, run_id, label, detail, entry_order,
          kind, words_added, words_removed, cost, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            entry_id,
            story_id,
            chapter_id,
            run_id,
            label,
            detail,
            entry_order,
            kind,
            words_added,
            words_removed,
            cost,
            now,
        ),
    )
    return {
        "id": entry_id,
        "story_id": story_id,
        "chapter_id": chapter_id,
        "run_id": run_id,
        "label": label,
        "detail": detail,
        "entry_order": entry_order,
        "kind": kind,
        "words_added": words_added,
        "words_removed": words_removed,
        "cost": cost,
        "created_at": now,
    }
