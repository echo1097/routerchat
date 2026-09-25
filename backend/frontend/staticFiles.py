from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import Scope


class FrontendStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Any:
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404:
                response = await super().get_response("index.html", scope)
            else:
                raise

        if response.media_type == "text/html":
            response.headers["Cache-Control"] = "no-store, max-age=0"
            response.headers["Pragma"] = "no-cache"
        elif path.startswith("assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"

        return response


def configure_static_files(target_app: FastAPI, static_dir: Path) -> None:
    if static_dir.is_dir():
        target_app.mount("/", FrontendStaticFiles(directory=static_dir, html=True), name="static")
        return

    @target_app.get("/", include_in_schema=False)
    def missing_frontend_build() -> PlainTextResponse:
        return PlainTextResponse(
            "frontend build missing, run npm run build",
            status_code=503,
        )
