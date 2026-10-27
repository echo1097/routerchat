import re
import sqlite3
from typing import Any

excerptLength = 260


def emptySummary() -> dict[str, Any]:
    return {"chapter_count": 0, "word_count": 0, "resume": None}


def plainParagraphs(content: str) -> list[str]:
    paragraphs = []
    for block in re.split(r"\n\s*\n", content or ""):
        lines = [line for line in block.strip().splitlines() if not line.lstrip().startswith("#")]
        text = " ".join(line.strip().lstrip(">").strip() for line in lines)
        text = re.sub(r"[*_~`]+", "", text).strip()
        if text:
            paragraphs.append(text)
    return paragraphs


def chapterExcerpt(content: str) -> str:
    paragraphs = plainParagraphs(content)
    if not paragraphs:
        return ""

    excerpt = paragraphs[-1]
    for paragraph in reversed(paragraphs[:-1]):
        if len(excerpt) >= excerptLength:
            break
        excerpt = f"{paragraph}\n\n{excerpt}"

    if len(excerpt) <= excerptLength:
        return excerpt

    tail = excerpt[-excerptLength:]
    firstSpace = tail.find(" ")
    if 0 <= firstSpace < 40:
        tail = tail[firstSpace + 1:]
    return f"…{tail}"


def listStorySummaries(conn: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    summaries: dict[str, dict[str, Any]] = {}

    countRows = conn.execute(
        """
        SELECT story_id, COUNT(*) AS chapter_count, COALESCE(SUM(word_count), 0) AS word_count
        FROM chapters
        GROUP BY story_id
        """
    ).fetchall()
    for row in countRows:
        summaries[row["story_id"]] = {
            "chapter_count": row["chapter_count"],
            "word_count": row["word_count"],
            "resume": None,
        }

    latestRows = conn.execute(
        """
        SELECT chapter.id, chapter.story_id, chapter.title, chapter.content
        FROM chapters AS chapter
        WHERE chapter.id = (
          SELECT latest.id FROM chapters AS latest
          WHERE latest.story_id = chapter.story_id
          ORDER BY latest.updated_at DESC, latest.order_index DESC
          LIMIT 1
        )
        """
    ).fetchall()
    for row in latestRows:
        summary = summaries.setdefault(row["story_id"], emptySummary())
        summary["resume"] = {
            "chapter_id": row["id"],
            "chapter_title": row["title"],
            "excerpt": chapterExcerpt(row["content"]),
        }

    return summaries
