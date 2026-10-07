from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from backend.attachments.attachmentCleanup import deleteAttachmentFiles
from backend.attachments.attachmentFiles import (
    IMAGE_TYPES,
    KIND_LIMITS,
    MAX_FILES_PER_MESSAGE,
    attachmentsDir,
    classifyUpload,
    contentDisposition,
    fileExtension,
    readAttachmentBytes,
    readableSize,
    safeFilename,
)
from backend.attachments.pdfPages import countPdfPages
from backend.core.database import getDb
from backend.core.utils import utcNow

router = APIRouter()


@router.post("/api/attachments")
async def uploadAttachments(
    files: list[UploadFile] = File(...),
) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded.")
    if len(files) > MAX_FILES_PER_MESSAGE:
        raise HTTPException(
            status_code=400,
            detail=f"Attach at most {MAX_FILES_PER_MESSAGE} files at a time.",
        )

    storage = attachmentsDir()
    created: list[dict[str, Any]] = []
    writtenPaths: list[Path] = []

    try:
        for upload in files:
            filename = safeFilename(upload.filename or "file")
            kind, mime = classifyUpload(filename)
            limit = KIND_LIMITS[kind]
            raw = await upload.read(limit + 1)

            if not raw:
                raise HTTPException(
                    status_code=400, detail=f"{filename} is empty."
                )

            if len(raw) > limit:
                raise HTTPException(
                    status_code=400,
                    detail=f"{filename} is larger than {readableSize(limit)}.",
                )

            attachmentId = str(uuid.uuid4())
            storedPath = storage / f"{attachmentId}{fileExtension(filename)}"
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
                    "page_count": (countPdfPages(raw) or 0) if kind == "pdf" else None,
                }
            )

        now = utcNow()
        with getDb() as conn:
            for attachment in created:
                conn.execute(
                    """
                    INSERT INTO attachments (
                      id, chat_id, message_id, story_id, filename, mime,
                      kind, size_bytes, stored_path, created_at, page_count
                    )
                    VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        attachment["id"],
                        attachment["filename"],
                        attachment["mime"],
                        attachment["kind"],
                        attachment["size_bytes"],
                        attachment["stored_path"],
                        now,
                        attachment["page_count"],
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
def readAttachmentRaw(attachment_id: str) -> Response:
    with getDb() as conn:
        row = conn.execute(
            "SELECT * FROM attachments WHERE id = ?", (attachment_id,)
        ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found.")

    raw = readAttachmentBytes(row)
    if not raw:
        raise HTTPException(status_code=404, detail="Attachment file is missing.")

    isInlineImage = row["kind"] == "image" and row["mime"] in IMAGE_TYPES.values()
    mediaType = row["mime"] if isInlineImage else "application/octet-stream"
    return Response(
        content=raw,
        media_type=mediaType,
        headers={
            "Content-Disposition": contentDisposition(row["filename"], inline=isInlineImage),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Cache-Control": "no-store",
        },
    )


@router.delete("/api/attachments/{attachment_id}")
def deleteAttachment(attachment_id: str) -> dict[str, Any]:
    with getDb() as conn:
        row = conn.execute(
            "SELECT * FROM attachments WHERE id = ?", (attachment_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Attachment not found.")
        deleteAttachmentFiles([row])
        conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))

    return {"ok": True}
