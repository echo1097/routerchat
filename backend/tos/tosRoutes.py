from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.core.paths import APP_VERSION
from backend.security.apiSecurity import TOS_MISSING_DETAIL
from backend.tos.loadTos import loadTos
from backend.tos.tosAcceptance import (
    latestTosAcceptance,
    recordTosAcceptance,
    tosPayload,
)

router = APIRouter()


class TosAcceptRequest(BaseModel):
    hash: str = Field(min_length=1)


@router.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "version": APP_VERSION,
    }


@router.get("/api/tos")
def getTos() -> dict[str, Any]:
    tos = loadTos()
    if not tos:
        raise HTTPException(status_code=503, detail=TOS_MISSING_DETAIL)
    return tosPayload(tos)


@router.post("/api/tos/accept")
def acceptTos(payload: TosAcceptRequest) -> dict[str, Any]:
    tos = loadTos()
    if not tos:
        raise HTTPException(status_code=503, detail=TOS_MISSING_DETAIL)

    if payload.hash.strip().lower() != tos["hash"]:
        #client was holding a stale copy, make it re-read whatever is on disk now
        raise HTTPException(
            status_code=409,
            detail={
                "code": "tos_stale",
                "message": "The terms changed while you were reading them. Please read and accept the current version.",
            },
        )

    if not latestTosAcceptance(tos["hash"]):
        recordTosAcceptance(tos["hash"], tos["date"])

    return tosPayload(tos)
