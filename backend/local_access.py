from __future__ import annotations

import argparse
import html
import os
import re
import secrets
import stat
import time
import webbrowser
from collections.abc import Callable, Sequence
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit


SECRET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43,256}$")


def validate_base_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("RouterChat base URL is invalid.") from exc

    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("RouterChat base URL must be an exact 127.0.0.1 HTTP origin.")

    return f"http://127.0.0.1:{port}"


def create_secret_file(secret_path: Path) -> str:
    secretPath = Path(secret_path)
    secretPath.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "posix":
        secretPath.parent.chmod(0o700)

    secret = secrets.token_urlsafe(48)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW

    descriptor = os.open(secretPath, flags, 0o600)
    try:
        os.write(descriptor, secret.encode("ascii"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

    if os.name == "posix":
        secretPath.chmod(0o600)
    return secret


def read_secret_file(secret_path: Path) -> str:
    secretPath = Path(secret_path)
    try:
        fileInfo = secretPath.lstat()
    except OSError as exc:
        raise RuntimeError("RouterChat API credential file is missing.") from exc

    if stat.S_ISLNK(fileInfo.st_mode) or not stat.S_ISREG(fileInfo.st_mode):
        raise RuntimeError("RouterChat API credential must be a regular file.")

    if os.name == "posix":
        if fileInfo.st_uid != os.getuid():
            raise RuntimeError("RouterChat API credential must be owned by the current user.")
        if stat.S_IMODE(fileInfo.st_mode) & 0o077:
            raise RuntimeError("RouterChat API credential permissions are too broad.")

    if fileInfo.st_size > 256:
        raise RuntimeError("RouterChat API credential is invalid.")

    try:
        secret = secretPath.read_text(encoding="ascii")
    except (OSError, UnicodeError) as exc:
        raise RuntimeError("RouterChat API credential could not be read.") from exc

    if not SECRET_PATTERN.fullmatch(secret):
        raise RuntimeError("RouterChat API credential is invalid.")
    return secret


def bootstrap_page(secret: str, base_url: str) -> bytes:
    baseUrl = validate_base_url(base_url)
    bootstrapUrl = html.escape(f"{baseUrl}/api/bootstrap", quote=True)
    escapedSecret = html.escape(secret, quote=True)
    page = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Cache-Control" content="no-store">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; form-action {bootstrapUrl}">
  <title>Opening RouterChat</title>
</head>
<body>
  <form id="bootstrap" method="post" action="{bootstrapUrl}">
    <input type="hidden" name="secret" value="{escapedSecret}">
  </form>
  <script>document.getElementById("bootstrap").submit();</script>
</body>
</html>
"""
    return page.encode("utf-8")


def open_bootstrap_page(
    secret_path: Path,
    base_url: str,
    *,
    browser_open: Callable[[str], bool] = webbrowser.open,
    timeout: float = 15.0,
) -> None:
    secret = read_secret_file(secret_path)
    page = bootstrap_page(secret, base_url)
    oneTimePath = f"/{secrets.token_urlsafe(24)}"
    served = False

    class BootstrapHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            nonlocal served
            if served or self.path != oneTimePath:
                self.send_error(404)
                return

            served = True
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Pragma", "no-cache")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(page)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = HTTPServer(("127.0.0.1", 0), BootstrapHandler)
    try:
        port = server.server_address[1]
        launcherUrl = f"http://127.0.0.1:{port}{oneTimePath}"
        if not browser_open(launcherUrl):
            raise RuntimeError("The browser could not be opened automatically.")

        deadline = time.monotonic() + timeout
        while not served and time.monotonic() < deadline:
            server.timeout = min(0.25, max(0.01, deadline - time.monotonic()))
            server.handle_request()

        if not served:
            raise RuntimeError("The browser did not load the RouterChat bootstrap page in time.")
    finally:
        server.server_close()


def serve_local_app(
    secret_path: Path,
    base_url: str,
    trusted_origins: Sequence[str],
) -> None:
    baseUrl = validate_base_url(base_url)
    origins = [validate_base_url(origin) for origin in trusted_origins]
    if not origins:
        raise RuntimeError("RouterChat needs at least one trusted frontend origin.")

    secretPath = Path(secret_path)
    create_secret_file(secretPath)
    os.environ["ROUTERCHAT_API_SECRET_FILE"] = str(secretPath.resolve())
    os.environ["ROUTERCHAT_BASE_URL"] = baseUrl
    os.environ["ROUTERCHAT_TRUSTED_ORIGINS"] = ",".join(origins)

    port = urlsplit(baseUrl).port
    try:
        import uvicorn

        uvicorn.run(
            "backend.main:app",
            host="127.0.0.1",
            port=port,
        )
    finally:
        try:
            secretPath.unlink()
        except FileNotFoundError:
            pass


def parse_args(arguments: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create and deliver RouterChat local API access")
    commands = parser.add_subparsers(dest="command", required=True)

    createCommand = commands.add_parser("create-secret")
    createCommand.add_argument("--secret-file", type=Path, required=True)

    openCommand = commands.add_parser("open-browser")
    openCommand.add_argument("--secret-file", type=Path, required=True)
    openCommand.add_argument("--base-url", required=True)
    openCommand.add_argument("--timeout", type=float, default=15.0)

    serveCommand = commands.add_parser("serve")
    serveCommand.add_argument("--secret-file", type=Path, required=True)
    serveCommand.add_argument("--base-url", required=True)
    serveCommand.add_argument("--trusted-origin", action="append", required=True)
    return parser.parse_args(arguments)


def main(arguments: Sequence[str] | None = None) -> None:
    args = parse_args(arguments)
    if args.command == "create-secret":
        create_secret_file(args.secret_file)
        return

    if args.command == "serve":
        serve_local_app(args.secret_file, args.base_url, args.trusted_origin)
        return

    open_bootstrap_page(
        args.secret_file,
        args.base_url,
        timeout=args.timeout,
    )


if __name__ == "__main__":
    main()
