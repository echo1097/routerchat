from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from backend.attachments.attachmentCleanup import delete_attachment_files
from backend.attachments.attachmentFiles import (
    IMAGE_TYPES,
    KIND_LIMITS,
    MAX_FILES_PER_MESSAGE,
    attachments_dir,
    classify_upload,
    content_disposition,
    file_extension,
    read_attachment_bytes,
    readable_size,
    safe_filename,
)
from backend.core.database import get_db
from backend.core.utils import utc_now

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

    storage = attachments_dir()
    created: list[dict[str, Any]] = []
    writtenPaths: list[Path] = []

    try:
        for upload in files:
            filename = safe_filename(upload.filename or "file")
            kind, mime = classify_upload(filename)
            limit = KIND_LIMITS[kind]
            raw = await upload.read(limit + 1)

            if not raw:
                raise HTTPException(
                    status_code=400, detail=f"{filename} is empty."
                )

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

        now = utc_now()
        with get_db() as conn:
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
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM attachments WHERE id = ?", (attachment_id,)
        ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found.")

    raw = read_attachment_bytes(row)
    if not raw:
        raise HTTPException(status_code=404, detail="Attachment file is missing.")

    isInlineImage = row["kind"] == "image" and row["mime"] in IMAGE_TYPES.values()
    mediaType = row["mime"] if isInlineImage else "application/octet-stream"
    return Response(
        content=raw,
        media_type=mediaType,
        headers={
            "Content-Disposition": content_disposition(row["filename"], inline=isInlineImage),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Cache-Control": "no-store",
        },
    )


@router.delete("/api/attachments/{attachment_id}")
def delete_attachment(attachment_id: str) -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM attachments WHERE id = ?", (attachment_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Attachment not found.")
        delete_attachment_files([row])
        conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))

    return {"ok": True}
