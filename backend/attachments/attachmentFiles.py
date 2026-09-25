from __future__ import annotations

import sqlite3
import unicodedata
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException

from backend.core import paths

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


def attachments_dir() -> Path:
    directory = paths.DATA_DIR / "attachments"
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


def content_disposition(filename: str, *, inline: bool = False) -> str:
    normalized = unicodedata.normalize("NFKD", filename)
    asciiName = "".join(
        character
        for character in normalized.encode("ascii", "ignore").decode("ascii")
        if character.isprintable() and character not in '"\\'
    ).strip()

    if not asciiName or asciiName.startswith("."):
        asciiName = f"file{asciiName}"

    disposition = "inline" if inline else "attachment"
    return (
        f'{disposition}; filename="{asciiName}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )


def read_attachment_bytes(row: sqlite3.Row) -> bytes:
    path = Path(row["stored_path"])
    try:
        return path.read_bytes()
    except OSError:
        return b""
