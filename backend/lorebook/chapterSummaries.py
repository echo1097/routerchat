import sqlite3
from typing import Any

from backend.lorebook.editOperations import skippedLorebookUpdate
from backend.lorebook.lorebookRows import jsonDict, normalizeLorebookCategory
from backend.lorebook.timeline import normalizeTimelineDescription

SUMMARY_INSTRUCTION = (
    "Always create or update one synopsis named exactly after the chapter. Make it as short as "
    "possible without leaving out key events, outcomes, or continuity details."
)


def lorebookSummaryChapterId(row: sqlite3.Row) -> str:
    if normalizeLorebookCategory(row["category"]) != "synopsis":
        return ""
    return str(jsonDict(row["metadata_json"]).get("chapter_id") or "").strip()


def renameLinkedChapterSummaries(
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
        if lorebookSummaryChapterId(summaryRow) != chapterId:
            continue
        conn.execute(
            "UPDATE lorebook_entries SET name = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
            (chapterTitle, now, summaryRow["id"]),
        )


def deleteLinkedChapterSummaries(
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
        if lorebookSummaryChapterId(row) == chapterId
    ]
    for entryId in linkedIds:
        conn.execute("DELETE FROM lorebook_entries WHERE id = ?", (entryId,))


def findEnabledChapterSummary(
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

    linked = [row for row in rows if lorebookSummaryChapterId(row) == chapter_id]
    if linked:
        return linked[0]

    #old summaries shipped without a chapter id, so claim one only when the title match is clear
    legacy = [
        row
        for row in rows
        if not lorebookSummaryChapterId(row)
        and str(row["name"] or "").casefold() == chapter_title.casefold()
    ]
    return legacy[0] if len(legacy) == 1 else None


def decisionCategory(update: dict[str, Any], rows_by_id: dict[str, sqlite3.Row]) -> str:
    if str(update.get("action") or "").lower() == "create":
        return normalizeLorebookCategory(update.get("category"))
    row = rows_by_id.get(str(update.get("entryId") or ""))
    return normalizeLorebookCategory(row["category"]) if row else ""


def dropIdentityOperations(
    update: dict[str, Any],
    update_index: int,
    skipped: list[dict[str, Any]],
    reason: str,
) -> dict[str, Any] | None:
    operations = update.get("operations")
    if not isinstance(operations, list):
        return update
    kept = []
    for operationIndex, operation in enumerate(operations):
        if isinstance(operation, dict) and operation.get("operation") == "setField":
            skipped.append(skippedLorebookUpdate(
                update_index, "lorebook_edit_invalid_operation", reason, update, operationIndex
            ))
            continue
        kept.append(operation)
    if not kept:
        skipped.append(skippedLorebookUpdate(
            update_index,
            "lorebook_edit_invalid_operations",
            "every operation on this entry was dropped",
            update,
        ))
        return None
    return {**update, "operations": kept}


def normalizeRequiredSummaryUpdate(
    updates: list[Any],
    chapter: sqlite3.Row,
    lorebook_rows: list[sqlite3.Row] | None = None,
    require_decisions: bool = True,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rowsById = {str(row["id"]): row for row in (lorebook_rows or [])}
    chapterId = str(chapter["id"])
    chapterTitle = str(chapter["title"] or "New chapter").strip() or "New chapter"
    skipped: list[dict[str, Any]] = []
    normalized: list[dict[str, Any]] = []
    summarySeen = False
    timelineSeen = False

    for updateIndex, update in enumerate(updates):
        if not isinstance(update, dict):
            normalized.append(update)
            continue
        category = decisionCategory(update, rowsById)
        action = str(update.get("action") or "").lower()

        if category == "synopsis":
            if summarySeen:
                skipped.append(skippedLorebookUpdate(
                    updateIndex,
                    "lorebook_summary_duplicate",
                    "only one chapter summary decision is allowed per run",
                    update,
                ))
                continue
            if action == "exclude":
                summarySeen = True
                skipped.append(skippedLorebookUpdate(
                    updateIndex,
                    "lorebook_summary_required",
                    "the active chapter summary cannot be excluded",
                    update,
                ))
                continue
            if action == "create":
                summarySeen = True
                if not str(update.get("description") or "").strip():
                    skipped.append(skippedLorebookUpdate(
                        updateIndex,
                        "lorebook_create_invalid",
                        "the chapter summary needs a description",
                        update,
                    ))
                    continue
                normalized.append({
                    **update,
                    "name": chapterTitle,
                    "category": "synopsis",
                    "aliases": [],
                    "tags": [],
                    "metadata": {"chapter_id": chapterId},
                })
                continue
            summaryRow = rowsById.get(str(update.get("entryId") or ""))
            linkedChapterId = lorebookSummaryChapterId(summaryRow) if summaryRow else ""
            legacyTitleMatch = (
                summaryRow is not None
                and not linkedChapterId
                and str(summaryRow["name"] or "").casefold() == str(chapter["title"] or "").casefold()
            )
            if linkedChapterId != chapterId and not legacyTitleMatch:
                normalized.append(update)
                continue
            summarySeen = True
            if action == "edit":
                update = dropIdentityOperations(
                    update, updateIndex, skipped, "chapter summary identity cannot be changed"
                )
                if update is None:
                    continue
            normalized.append({
                **update,
                "_summaryChapterId": chapterId,
                "_summaryName": chapterTitle,
            })
            continue

        if category == "timeline":
            if timelineSeen:
                skipped.append(skippedLorebookUpdate(
                    updateIndex,
                    "lorebook_timeline_duplicate",
                    "only one Timeline decision is allowed per run",
                    update,
                ))
                continue
            timelineSeen = True
            if action == "exclude":
                skipped.append(skippedLorebookUpdate(
                    updateIndex,
                    "lorebook_timeline_required",
                    "Timeline cannot be excluded",
                    update,
                ))
                continue
            if action == "create":
                description = normalizeTimelineDescription(str(update.get("description") or ""))
                if not description:
                    skipped.append(skippedLorebookUpdate(
                        updateIndex,
                        "lorebook_create_invalid",
                        "the Timeline needs a description",
                        update,
                    ))
                    continue
                normalized.append({
                    **update,
                    "name": "Timeline",
                    "category": "timeline",
                    "description": description,
                    "aliases": ["Timeline"],
                    "tags": [],
                    "metadata": {},
                })
                continue
            if action == "edit":
                update = dropIdentityOperations(
                    update, updateIndex, skipped, "Timeline identity cannot be changed"
                )
                if update is None:
                    continue
            normalized.append(update)
            continue

        normalized.append(update)

    if require_decisions and not summarySeen:
        skipped.append({
            "index": -1,
            "code": "lorebook_summary_missing",
            "message": "the run returned no decision for the active chapter summary",
            "entryId": "",
        })
    return normalized, skipped
