from __future__ import annotations

import hmac
from typing import Any

from fastapi import Request, Response
from fastapi.responses import JSONResponse

from backend.security.localAccessConfig import localAccessConfig
from backend.tos.loadTos import loadTos
from backend.tos.tosAcceptance import latestTosAcceptance

SESSION_COOKIE_NAME = "routerchat_session"
BOOTSTRAP_PATH = "/api/bootstrap"
HEALTH_PATH = "/api/health"
TOS_EXEMPT_PATHS = {HEALTH_PATH, BOOTSTRAP_PATH, "/api/tos", "/api/tos/accept"}
MUTATION_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
API_AUTH_REQUIRED_DETAIL = {
    "code": "api_auth_required",
    "message": "Open RouterChat through its launcher to authorize this browser.",
}
INVALID_REQUEST_HOST_DETAIL = {
    "code": "invalid_request_host",
    "message": "The request Host is not allowed.",
}
INVALID_REQUEST_ORIGIN_DETAIL = {
    "code": "invalid_request_origin",
    "message": "The request origin is not allowed.",
}
TOS_MISSING_DETAIL = {
    "code": "tos_missing",
    "message": "TOS.md could not be read. Restore it from the repository to use RouterChat.",
}
TOS_REQUIRED_DETAIL = {
    "code": "tos_required",
    "message": "The current Terms of Service have not been accepted.",
}


def requestHeaderValues(request: Request, name: bytes) -> list[str]:
    values = []
    for headerName, headerValue in request.scope.get("headers", []):
        if headerName.lower() != name:
            continue
        try:
            values.append(headerValue.decode("ascii"))
        except UnicodeDecodeError:
            values.append("")
    return values


def securityError(statusCode: int, detail: dict[str, str]) -> JSONResponse:
    return JSONResponse(
        status_code=statusCode,
        content={"detail": detail},
        headers={"Cache-Control": "no-store"},
    )


def isApiPath(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


async def enforceLocalApiSecurity(request: Request, call_next: Any) -> Response:
    config = localAccessConfig(request.app)
    hostValues = requestHeaderValues(request, b"host")
    if len(hostValues) != 1 or hostValues[0] != config.allowedHost:
        return securityError(400, INVALID_REQUEST_HOST_DETAIL)

    path = request.url.path
    if not isApiPath(path) or path in {HEALTH_PATH, BOOTSTRAP_PATH}:
        return await call_next(request)

    sessionSecret = request.cookies.get(SESSION_COOKIE_NAME, "")
    if not hmac.compare_digest(sessionSecret, config.secret):
        return securityError(401, API_AUTH_REQUIRED_DETAIL)

    if request.method in MUTATION_METHODS:
        originValues = requestHeaderValues(request, b"origin")
        if len(originValues) != 1 or originValues[0] not in config.trustedOrigins:
            return securityError(403, INVALID_REQUEST_ORIGIN_DETAIL)

        fetchSiteValues = requestHeaderValues(request, b"sec-fetch-site")
        if len(fetchSiteValues) > 1 or (
            fetchSiteValues and fetchSiteValues[0].lower() != "same-origin"
        ):
            return securityError(403, INVALID_REQUEST_ORIGIN_DETAIL)

    #guard every api route rather than the handful that talk to openrouter, so a new endpoint cant quietly skip the gate
    if path in TOS_EXEMPT_PATHS:
        return await call_next(request)

    tos = loadTos()
    if not tos:
        return JSONResponse(status_code=503, content={"detail": TOS_MISSING_DETAIL})

    if not latestTosAcceptance(tos["hash"]):
        return JSONResponse(status_code=403, content={"detail": TOS_REQUIRED_DETAIL})

    return await call_next(request)
