import sqlite3
from typing import Any

from backend.lorebook.lorebookRows import json_dict, normalize_lorebook_category
from backend.lorebook.timeline import normalize_timeline_description

SUMMARY_INSTRUCTION = (
    "Always create or update one synopsis named exactly after the chapter. Make it as short as "
    "possible without leaving out key events, outcomes, or continuity details."
)


def lorebook_summary_chapter_id(row: sqlite3.Row) -> str:
    if normalize_lorebook_category(row["category"]) != "synopsis":
        return ""
    return str(json_dict(row["metadata_json"]).get("chapter_id") or "").strip()


def rename_linked_chapter_summaries(
    conn: sqlite3.Connection,
    storyId: str,
    chapterId: str,
    chapterTitle: str,
    now: str,
) -> None:
    summaryRows = conn.execute(
        "SELECT * FROM lorebook_entries WHERE story_id = ? AND category = 'synopsis'",
        (storyId,),
    ).fetchall()
    for summaryRow in summaryRows:
        if lorebook_summary_chapter_id(summaryRow) != chapterId:
            continue
        conn.execute(
            "UPDATE lorebook_entries SET name = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
            (chapterTitle, now, summaryRow["id"]),
        )


def delete_linked_chapter_summaries(
    conn: sqlite3.Connection,
    storyId: str,
    chapterId: str,
) -> None:
    summaryRows = conn.execute(
        "SELECT * FROM lorebook_entries WHERE story_id = ? AND category = 'synopsis'",
        (storyId,),
    ).fetchall()
    linkedIds = [
        row["id"]
        for row in summaryRows
        if lorebook_summary_chapter_id(row) == chapterId
    ]
    for entryId in linkedIds:
        conn.execute("DELETE FROM lorebook_entries WHERE id = ?", (entryId,))


def find_enabled_chapter_summary(
    conn: sqlite3.Connection,
    story_id: str,
    chapter_id: str,
    chapter_title: str,
) -> sqlite3.Row | None:
    rows = conn.execute(
        """
        SELECT * FROM lorebook_entries
        WHERE story_id = ? AND category = 'synopsis' AND disabled = 0
        ORDER BY updated_at DESC, created_at DESC
        """,
        (story_id,),
    ).fetchall()

    linked = [row for row in rows if lorebook_summary_chapter_id(row) == chapter_id]
    if linked:
        return linked[0]

    #old summaries shipped without a chapter id, so claim one only when the title match is clear
    legacy = [
        row
        for row in rows
        if not lorebook_summary_chapter_id(row)
        and str(row["name"] or "").casefold() == chapter_title.casefold()
    ]
    return legacy[0] if len(legacy) == 1 else None


def normalize_required_summary_update(
    updates: list[Any],
    chapter: sqlite3.Row,
    lorebook_rows: list[sqlite3.Row] | None = None,
) -> list[dict[str, Any]]:
    validUpdates = [update for update in updates if isinstance(update, dict)]
    targeted = any(
        str(update.get("action") or "").lower() in {"edit", "exclude", "keep"}
        for update in validUpdates
    )
    if targeted:
        rowsById = {str(row["id"]): row for row in (lorebook_rows or [])}

        def updateCategory(update: dict[str, Any]) -> str:
            if str(update.get("action") or "").lower() == "create":
                return normalize_lorebook_category(update.get("category"))
            row = rowsById.get(str(update.get("entryId") or ""))
            return normalize_lorebook_category(row["category"]) if row else ""

        summaries = [update for update in validUpdates if updateCategory(update) == "synopsis"]
        if len(summaries) != 1:
            raise ValueError("The lorebook update must contain exactly one chapter summary decision.")
        summary = summaries[0]
        summaryAction = str(summary.get("action") or "").lower()
        if summaryAction == "exclude":
            raise ValueError("The active chapter summary cannot be excluded.")
        if summaryAction == "create":
            description = str(summary.get("description") or "").strip()
            if not description:
                raise ValueError("The lorebook update returned an invalid chapter summary.")
            summary = {
                **summary,
                "name": str(chapter["title"] or "New chapter").strip() or "New chapter",
                "category": "synopsis",
                "aliases": [],
                "tags": [],
                "metadata": {"chapter_id": str(chapter["id"])},
            }
        else:
            summaryRow = rowsById.get(str(summary.get("entryId") or ""))
            if not summaryRow:
                raise ValueError("The chapter summary target was not found.")
            linkedChapterId = lorebook_summary_chapter_id(summaryRow)
            legacyTitleMatch = (
                not linkedChapterId
                and str(summaryRow["name"] or "").casefold()
                == str(chapter["title"] or "").casefold()
            )
            if linkedChapterId != str(chapter["id"]) and not legacyTitleMatch:
                raise ValueError("The lorebook update targeted the wrong chapter summary.")
            for operation in summary.get("operations") or []:
                if isinstance(operation, dict) and operation.get("operation") == "setField":
                    raise ValueError("Chapter summary identity cannot be changed by lorebook edits.")
            summary = {
                **summary,
                "_summaryChapterId": str(chapter["id"]),
                "_summaryName": str(chapter["title"] or "New chapter").strip() or "New chapter",
            }

        timelines = [update for update in validUpdates if updateCategory(update) == "timeline"]
        if len(timelines) != 1:
            raise ValueError("The lorebook update must contain exactly one Timeline decision.")
        timeline = timelines[0]
        timelineAction = str(timeline.get("action") or "").lower()
        if timelineAction == "exclude":
            raise ValueError("Timeline cannot be excluded.")
        if timelineAction == "create":
            timeline = {
                **timeline,
                "name": "Timeline",
                "category": "timeline",
                "description": normalize_timeline_description(
                    str(timeline.get("description") or "")
                ),
                "aliases": ["Timeline"],
                "tags": [],
                "metadata": {},
            }
            if not timeline["description"]:
                raise ValueError("The lorebook update returned an invalid Timeline.")
        else:
            for operation in timeline.get("operations") or []:
                if (
                    isinstance(operation, dict)
                    and operation.get("operation") == "setField"
                    and operation.get("field") in {"name", "category"}
                ):
                    raise ValueError("Timeline identity cannot be changed by lorebook edits.")

        normalized: list[dict[str, Any]] = []
        for update in validUpdates:
            if update is summaries[0]:
                normalized.append(summary)
            elif update is timelines[0]:
                normalized.append(timeline)
            else:
                normalized.append(update)
        return normalized

    summaries = [
        update
        for update in validUpdates
        if normalize_lorebook_category(update.get("category")) == "synopsis"
    ]
    if len(summaries) != 1:
        raise ValueError("The lorebook update must contain exactly one chapter summary.")

    summary = summaries[0]
    description = str(summary.get("description") or "").strip()
    if not description or str(summary.get("action") or "create").lower() == "delete":
        raise ValueError("The lorebook update returned an invalid chapter summary.")

    normalizedSummary = {
        **summary,
        "action": "update",
        "name": str(chapter["title"] or "New chapter").strip() or "New chapter",
        "category": "synopsis",
        "description": description,
        "aliases": [],
        "tags": [],
        "metadata": {"chapter_id": str(chapter["id"])},
    }
    ordinaryUpdates = [update for update in validUpdates if update is not summary]
    return [*ordinaryUpdates, normalizedSummary]
