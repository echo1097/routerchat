from __future__ import annotations

import base64
import sqlite3
from typing import Any

from backend.attachments.attachmentFiles import (
    CODE_FENCE_LANGUAGES,
    MAX_TEXT_CHARACTERS,
    file_extension,
    read_attachment_bytes,
)


def row_to_attachment(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "filename": row["filename"],
        "mime": row["mime"],
        "kind": row["kind"],
        "size_bytes": row["size_bytes"],
        "created_at": row["created_at"],
    }


def attachments_by_message(
    conn: sqlite3.Connection, chat_id: str
) -> dict[str, list[dict[str, Any]]]:
    rows = conn.execute(
        """
        SELECT * FROM attachments
        WHERE chat_id = ? AND message_id IS NOT NULL
        ORDER BY created_at ASC, rowid ASC
        """,
        (chat_id,),
    ).fetchall()

    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(row["message_id"], []).append(row_to_attachment(row))
    return grouped


def selected_attachment_rows(
    conn: sqlite3.Connection, attachmentIds: list[str]
) -> list[sqlite3.Row]:
    if not attachmentIds:
        return []

    placeholders = ",".join("?" for _ in attachmentIds)
    rows = conn.execute(
        f"SELECT * FROM attachments WHERE id IN ({placeholders})",
        tuple(attachmentIds),
    ).fetchall()

    byId = {row["id"]: row for row in rows}
    return [byId[attachmentId] for attachmentId in attachmentIds if attachmentId in byId]


def text_content_part(row: sqlite3.Row) -> dict[str, Any] | None:
    raw = read_attachment_bytes(row)
    if not raw:
        return None

    decoded = raw.decode("utf-8", errors="replace")
    truncated = len(decoded) > MAX_TEXT_CHARACTERS
    if truncated:
        decoded = decoded[:MAX_TEXT_CHARACTERS]

    language = CODE_FENCE_LANGUAGES.get(file_extension(row["filename"]), "")
    body = f"Attached file: {row['filename']}\n\n```{language}\n{decoded}\n```"
    if truncated:
        body += "\n\n(This file was truncated because it is very long.)"

    return {"type": "text", "text": body}


def data_url(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def attachment_content_parts(
    conn: sqlite3.Connection, attachmentIds: list[str]
) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []

    for row in selected_attachment_rows(conn, attachmentIds):
        if row["kind"] == "image":
            raw = read_attachment_bytes(row)
            if not raw:
                continue
            parts.append(
                {
                    "type": "image_url",
                    "image_url": {"url": data_url(row["mime"], raw)},
                }
            )
            continue

        if row["kind"] == "pdf":
            raw = read_attachment_bytes(row)
            if not raw:
                continue
            parts.append(
                {
                    "type": "file",
                    "file": {
                        "filename": row["filename"],
                        "file_data": data_url("application/pdf", raw),
                    },
                }
            )
            continue

        textPart = text_content_part(row)
        if textPart:
            parts.append(textPart)

    return parts


def user_content_with_attachments(
    conn: sqlite3.Connection, attachmentIds: list[str], text: str
) -> Any:
    parts = attachment_content_parts(conn, attachmentIds)
    if not parts:
        return text

    if text.strip():
        parts.append({"type": "text", "text": text})

    return parts


def has_pdf_attachment(conn: sqlite3.Connection, attachmentIds: list[str]) -> bool:
    return any(row["kind"] == "pdf" for row in selected_attachment_rows(conn, attachmentIds))


def chat_has_pdf_attachment(conn: sqlite3.Connection, chat_id: str) -> bool:
    row = conn.execute(
        """
        SELECT 1 FROM attachments
        WHERE chat_id = ? AND kind = 'pdf'
        LIMIT 1
        """,
        (chat_id,),
    ).fetchone()
    return row is not None


def pdf_parser_plugins() -> list[dict[str, Any]]:
    return [{"id": "file-parser", "pdf": {"engine": "pdf-text"}}]
