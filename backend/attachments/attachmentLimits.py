from __future__ import annotations

import sqlite3

from fastapi import HTTPException

from backend.attachments.attachmentFiles import read_attachment_bytes, readable_size
from backend.attachments.pdfPages import countPdfPages
from backend.providers.base import Provider


def idPlaceholders(attachmentIds: list[str]) -> str:
    return ", ".join("?" for _ in attachmentIds)


def checkImageSizes(
    conn: sqlite3.Connection,
    attachmentIds: list[str],
    provider: Provider,
) -> None:
    maxImageBytes = provider.capabilities.maxImageBytes
    if not attachmentIds or maxImageBytes is None:
        return

    oversized = conn.execute(
        f"""
        SELECT filename FROM attachments
        WHERE id IN ({idPlaceholders(attachmentIds)}) AND kind = 'image' AND size_bytes > ?
        ORDER BY created_at ASC
        """,
        (*attachmentIds, maxImageBytes),
    ).fetchone()

    if oversized:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{oversized['filename']} is larger than {readable_size(maxImageBytes)}, "
                f"the most {provider.name} accepts for an image."
            ),
        )


def newAttachmentBytes(conn: sqlite3.Connection, attachmentIds: list[str]) -> int:
    if not attachmentIds:
        return 0

    row = conn.execute(
        f"""
        SELECT COALESCE(SUM(size_bytes), 0) AS total FROM attachments
        WHERE id IN ({idPlaceholders(attachmentIds)})
        """,
        tuple(attachmentIds),
    ).fetchone()
    return int(row["total"])


def earlierChatFilter(
    chatId: str,
    attachmentIds: list[str],
    throughMessageId: str | None,
) -> tuple[str, list[str]]:
    query = """
        FROM attachments
        JOIN messages ON messages.id = attachments.message_id
        WHERE attachments.chat_id = ? AND messages.error IS NULL
    """
    values: list[str] = [chatId]

    if attachmentIds:
        query += f" AND attachments.id NOT IN ({idPlaceholders(attachmentIds)})"
        values.extend(attachmentIds)

    if throughMessageId:
        query += """
            AND messages.message_order <= (
              SELECT message_order FROM messages WHERE id = ? AND chat_id = ?
            )
        """
        values.extend([throughMessageId, chatId])

    return query, values


def earlierChatAttachmentBytes(
    conn: sqlite3.Connection,
    chatId: str,
    attachmentIds: list[str],
    throughMessageId: str | None,
) -> int:
    query, values = earlierChatFilter(chatId, attachmentIds, throughMessageId)
    row = conn.execute(
        f"SELECT COALESCE(SUM(attachments.size_bytes), 0) AS total {query}",
        tuple(values),
    ).fetchone()
    return int(row["total"])


def pdfPageCount(conn: sqlite3.Connection, row: sqlite3.Row) -> int:
    if row["page_count"] is not None:
        return int(row["page_count"])

    pageCount = countPdfPages(read_attachment_bytes(row)) or 0
    conn.execute("UPDATE attachments SET page_count = ? WHERE id = ?", (pageCount, row["id"]))
    return pageCount


def newPdfPages(conn: sqlite3.Connection, attachmentIds: list[str]) -> int:
    if not attachmentIds:
        return 0

    rows = conn.execute(
        f"""
        SELECT id, stored_path, page_count FROM attachments
        WHERE id IN ({idPlaceholders(attachmentIds)}) AND kind = 'pdf'
        """,
        tuple(attachmentIds),
    ).fetchall()
    return sum(pdfPageCount(conn, row) for row in rows)


def earlierChatPdfPages(
    conn: sqlite3.Connection,
    chatId: str,
    attachmentIds: list[str],
    throughMessageId: str | None,
) -> int:
    query, values = earlierChatFilter(chatId, attachmentIds, throughMessageId)
    rows = conn.execute(
        f"""
        SELECT attachments.id, attachments.stored_path, attachments.page_count
        {query} AND attachments.kind = 'pdf'
        """,
        tuple(values),
    ).fetchall()
    return sum(pdfPageCount(conn, row) for row in rows)


def checkRequestSize(
    conn: sqlite3.Connection,
    attachmentIds: list[str],
    provider: Provider,
    chatId: str | None,
    throughMessageId: str | None,
) -> None:
    maxRequestBytes = provider.capabilities.maxRequestAttachmentBytes
    if maxRequestBytes is None:
        return

    earlierBytes = 0
    if chatId:
        earlierBytes = earlierChatAttachmentBytes(conn, chatId, attachmentIds, throughMessageId)

    totalBytes = earlierBytes + newAttachmentBytes(conn, attachmentIds)
    if totalBytes <= maxRequestBytes:
        return

    limitNote = (
        f"{provider.name} accepts about {readable_size(maxRequestBytes)} of files per request"
    )
    if earlierBytes:
        detail = (
            f"The files in this chat add up to {readable_size(totalBytes)}, and {limitNote}. "
            "Earlier files are sent again with every message, "
            "so remove a file or start a new chat."
        )
    else:
        detail = (
            f"These files add up to {readable_size(totalBytes)}, and {limitNote}. "
            "Remove a file and try again."
        )

    raise HTTPException(status_code=400, detail=detail)


def checkPdfPages(
    conn: sqlite3.Connection,
    attachmentIds: list[str],
    provider: Provider,
    modelId: str | None,
    chatId: str | None,
    throughMessageId: str | None,
) -> None:
    maxPages = provider.maxPdfPages(modelId) if modelId else None
    if maxPages is None:
        return

    earlierPages = 0
    if chatId:
        earlierPages = earlierChatPdfPages(conn, chatId, attachmentIds, throughMessageId)

    totalPages = earlierPages + newPdfPages(conn, attachmentIds)
    if totalPages <= maxPages:
        return

    limitNote = f"{provider.name} accepts {maxPages} PDF pages per request with this model"
    if earlierPages:
        detail = (
            f"The PDFs in this chat add up to {totalPages} pages, and {limitNote}. "
            "Earlier files are sent again with every message, "
            "so remove a PDF or start a new chat."
        )
    else:
        detail = (
            f"These PDFs add up to {totalPages} pages, and {limitNote}. "
            "Remove a PDF and try again."
        )

    raise HTTPException(status_code=400, detail=detail)


def checkAttachmentLimits(
    conn: sqlite3.Connection,
    attachmentIds: list[str],
    provider: Provider,
    chatId: str | None = None,
    throughMessageId: str | None = None,
    modelId: str | None = None,
) -> None:
    checkImageSizes(conn, attachmentIds, provider)
    checkRequestSize(conn, attachmentIds, provider, chatId, throughMessageId)
    checkPdfPages(conn, attachmentIds, provider, modelId, chatId, throughMessageId)
