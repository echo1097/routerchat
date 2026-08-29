from __future__ import annotations

import base64
import mimetypes
import sqlite3
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response


MAX_FILES_PER_MESSAGE = 5
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_TEXT_BYTES = 256 * 1024
MAX_TEXT_CHARACTERS = 120000

IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

PDF_TYPES = {".pdf": "application/pdf"}

TEXT_TYPES = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".xml": "text/xml",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".py": "text/x-python",
    ".rb": "text/x-ruby",
    ".go": "text/x-go",
    ".rs": "text/x-rust",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".h": "text/x-c",
    ".cpp": "text/x-c++",
    ".cs": "text/x-csharp",
    ".php": "text/x-php",
    ".sh": "text/x-sh",
    ".sql": "text/x-sql",
    ".toml": "text/x-toml",
    ".ini": "text/plain",
    ".log": "text/plain",
}

CODE_FENCE_LANGUAGES = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "jsx",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".rb": "ruby",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".php": "php",
    ".sh": "bash",
    ".sql": "sql",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".toml": "toml",
    ".md": "markdown",
    ".markdown": "markdown",
    ".csv": "csv",
}

KIND_LIMITS = {
    "image": MAX_IMAGE_BYTES,
    "pdf": MAX_PDF_BYTES,
    "text": MAX_TEXT_BYTES,
}


@dataclass(frozen=True)
class AttachmentsDeps:
    get_db: Callable[[], sqlite3.Connection]
    utc_now: Callable[[], str]
    data_dir: Callable[[], Path]


def attachments_dir(deps: AttachmentsDeps) -> Path:
    directory = deps.data_dir() / "attachments"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def file_extension(filename: str) -> str:
    return Path(filename or "").suffix.lower()


def classify_upload(filename: str) -> tuple[str, str]:
    extension = file_extension(filename)

    if extension in IMAGE_TYPES:
        return "image", IMAGE_TYPES[extension]
    if extension in PDF_TYPES:
        return "pdf", PDF_TYPES[extension]
    if extension in TEXT_TYPES:
        return "text", TEXT_TYPES[extension]

    raise HTTPException(
        status_code=400,
        detail=f"{filename or 'That file'} is not a supported file type.",
    )


def readable_size(byteCount: int) -> str:
    if byteCount >= 1024 * 1024:
        return f"{byteCount / (1024 * 1024):.0f}MB"
    return f"{max(1, byteCount // 1024)}KB"


def safe_filename(filename: str) -> str:
    cleaned = Path(filename or "file").name.strip()
    return cleaned[:180] or "file"


def content_disposition(filename: str) -> str:
    normalized = unicodedata.normalize("NFKD", filename)
    asciiName = "".join(
        character
        for character in normalized.encode("ascii", "ignore").decode("ascii")
        if character.isprintable() and character not in '"\\'
    ).strip()

    if not asciiName or asciiName.startswith("."):
        asciiName = f"file{asciiName}"

    return (
        f'inline; filename="{asciiName}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
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


def read_attachment_bytes(row: sqlite3.Row) -> bytes:
    path = Path(row["stored_path"])
    try:
        return path.read_bytes()
    except OSError:
        return b""


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


def claim_attachments(
    conn: sqlite3.Connection,
    attachmentIds: list[str],
    chat_id: str | None = None,
    message_id: str | None = None,
    story_id: str | None = None,
) -> None:
    if not attachmentIds:
        return

    for attachmentId in attachmentIds:
        conn.execute(
            """
            UPDATE attachments
            SET chat_id = COALESCE(?, chat_id),
                message_id = COALESCE(?, message_id),
                story_id = COALESCE(?, story_id)
            WHERE id = ?
            """,
            (chat_id, message_id, story_id, attachmentId),
        )


def delete_attachment_files(rows: list[sqlite3.Row]) -> None:
    for row in rows:
        try:
            Path(row["stored_path"]).unlink(missing_ok=True)
        except OSError:
            continue


def delete_attachments_for_chat(conn: sqlite3.Connection, chat_id: str) -> None:
    rows = conn.execute(
        "SELECT * FROM attachments WHERE chat_id = ?", (chat_id,)
    ).fetchall()
    delete_attachment_files(rows)
    conn.execute("DELETE FROM attachments WHERE chat_id = ?", (chat_id,))


def delete_attachments_for_story(conn: sqlite3.Connection, story_id: str) -> None:
    rows = conn.execute(
        "SELECT * FROM attachments WHERE story_id = ?", (story_id,)
    ).fetchall()
    delete_attachment_files(rows)
    conn.execute("DELETE FROM attachments WHERE story_id = ?", (story_id,))


def delete_attachments_for_missing_messages(conn: sqlite3.Connection) -> int:
    rows = conn.execute(
        """
        SELECT * FROM attachments
        WHERE message_id IS NOT NULL
          AND message_id NOT IN (SELECT id FROM messages)
        """
    ).fetchall()
    if not rows:
        return 0

    delete_attachment_files(rows)
    conn.execute(
        """
        DELETE FROM attachments
        WHERE message_id IS NOT NULL
          AND message_id NOT IN (SELECT id FROM messages)
        """
    )

    return len(rows)


def delete_orphaned_attachments(
    conn: sqlite3.Connection, olderThanHours: int = 24
) -> int:
    cutoff = (
        datetime.now(timezone.utc) - timedelta(hours=olderThanHours)
    ).isoformat().replace("+00:00", "Z")

    rows = conn.execute(
        """
        SELECT * FROM attachments
        WHERE message_id IS NULL AND story_id IS NULL AND created_at < ?
        """,
        (cutoff,),
    ).fetchall()
    if not rows:
        return 0

    delete_attachment_files(rows)
    conn.execute(
        """
        DELETE FROM attachments
        WHERE message_id IS NULL AND story_id IS NULL AND created_at < ?
        """,
        (cutoff,),
    )

    return len(rows)


def create_attachments_router(deps: AttachmentsDeps) -> APIRouter:
    router = APIRouter()

    @router.post("/api/attachments")
    async def upload_attachments(
        files: list[UploadFile] = File(...),
    ) -> dict[str, Any]:
        if not files:
            raise HTTPException(status_code=400, detail="No files were uploaded.")
        if len(files) > MAX_FILES_PER_MESSAGE:
            raise HTTPException(
                status_code=400,
                detail=f"Attach at most {MAX_FILES_PER_MESSAGE} files at a time.",
            )

        storage = attachments_dir(deps)
        created: list[dict[str, Any]] = []
        writtenPaths: list[Path] = []

        try:
            for upload in files:
                filename = safe_filename(upload.filename or "file")
                kind, mime = classify_upload(filename)
                raw = await upload.read()

                if not raw:
                    raise HTTPException(
                        status_code=400, detail=f"{filename} is empty."
                    )

                limit = KIND_LIMITS[kind]
                if len(raw) > limit:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{filename} is larger than {readable_size(limit)}.",
                    )

                attachmentId = str(uuid.uuid4())
                storedPath = storage / f"{attachmentId}{file_extension(filename)}"
                storedPath.write_bytes(raw)
                writtenPaths.append(storedPath)

                created.append(
                    {
                        "id": attachmentId,
                        "filename": filename,
                        "mime": mime,
                        "kind": kind,
                        "size_bytes": len(raw),
                        "stored_path": str(storedPath),
                    }
                )

            now = deps.utc_now()
            with deps.get_db() as conn:
                for attachment in created:
                    conn.execute(
                        """
                        INSERT INTO attachments (
                          id, chat_id, message_id, story_id, filename, mime,
                          kind, size_bytes, stored_path, created_at
                        )
                        VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            attachment["id"],
                            attachment["filename"],
                            attachment["mime"],
                            attachment["kind"],
                            attachment["size_bytes"],
                            attachment["stored_path"],
                            now,
                        ),
                    )
        except Exception:
            for path in writtenPaths:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    continue
            raise

        return {
            "attachments": [
                {
                    "id": attachment["id"],
                    "filename": attachment["filename"],
                    "mime": attachment["mime"],
                    "kind": attachment["kind"],
                    "size_bytes": attachment["size_bytes"],
                    "created_at": now,
                }
                for attachment in created
            ]
        }

    @router.get("/api/attachments/{attachment_id}/raw")
    def read_attachment_raw(attachment_id: str) -> Response:
        with deps.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM attachments WHERE id = ?", (attachment_id,)
            ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Attachment not found.")

        raw = read_attachment_bytes(row)
        if not raw:
            raise HTTPException(status_code=404, detail="Attachment file is missing.")

        mime = row["mime"] or mimetypes.guess_type(row["filename"])[0] or "application/octet-stream"
        return Response(
            content=raw,
            media_type=mime,
            headers={
                "Content-Disposition": content_disposition(row["filename"]),
                "Cache-Control": "no-store",
            },
        )

    @router.delete("/api/attachments/{attachment_id}")
    def delete_attachment(attachment_id: str) -> dict[str, Any]:
        with deps.get_db() as conn:
            row = conn.execute(
                "SELECT * FROM attachments WHERE id = ?", (attachment_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Attachment not found.")
            delete_attachment_files([row])
            conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))

        return {"ok": True}

    return router
