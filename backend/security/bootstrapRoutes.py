from __future__ import annotations

import hmac
from urllib.parse import parse_qs

from fastapi import APIRouter, Request, Response
from fastapi.responses import RedirectResponse

from backend.security.apiSecurity import (
    API_AUTH_REQUIRED_DETAIL,
    BOOTSTRAP_PATH,
    SESSION_COOKIE_NAME,
    security_error,
)
from backend.security.localAccessConfig import local_access_config

router = APIRouter()


@router.post(BOOTSTRAP_PATH, include_in_schema=False)
async def bootstrap_local_session(request: Request) -> Response:
    contentType = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    contentLength = request.headers.get("content-length", "")
    try:
        declaredLength = int(contentLength) if contentLength else 0
    except ValueError:
        declaredLength = 513

    suppliedSecret = ""
    if contentType == "application/x-www-form-urlencoded" and declaredLength <= 512:
        body = await request.body()
        if len(body) <= 512:
            try:
                fields = parse_qs(body.decode("ascii"), keep_blank_values=True)
                secretsFound = fields.get("secret", [])
                if len(secretsFound) == 1:
                    suppliedSecret = secretsFound[0]
            except (UnicodeDecodeError, ValueError):
                suppliedSecret = ""

    config = local_access_config(request.app)
    if not hmac.compare_digest(suppliedSecret, config.secret):
        return security_error(401, API_AUTH_REQUIRED_DETAIL)

    response = RedirectResponse(url="/", status_code=303)
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(
        SESSION_COOKIE_NAME,
        config.secret,
        httponly=True,
        secure=False,
        samesite="strict",
        path="/api",
    )
    return response
