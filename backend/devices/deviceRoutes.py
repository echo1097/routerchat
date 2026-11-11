from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from backend.devices.deviceSession import DEVICE_COOKIE_LIFETIME, DEVICE_COOKIE_NAME
from backend.devices.deviceTokens import (
    createDevice,
    deviceLimitReached,
    listDevices,
    removeDevice,
)
from backend.devices.pairingCodes import (
    clearPairingCode,
    createPairingCode,
    pairingCodeActive,
    redeemPairingCode,
)
from backend.devices.phoneAccess import phoneAccessEnabled, setPhoneAccess
from backend.security.localAccessConfig import localAccessConfig

router = APIRouter()

PAIRING_FAILED_DETAIL = {
    "code": "pairing_failed",
    "message": "That code didn't work. Get a new one from settings on your computer.",
}
PHONE_ACCESS_OFF_DETAIL = {
    "code": "phone_access_off",
    "message": "Phone access is not running. Turn it on in settings and restart RouterChat.",
}
DEVICE_LIMIT_DETAIL = {
    "code": "device_limit",
    "message": "Too many phones are paired. Remove one in settings first.",
}


class PhoneAccessRequest(BaseModel):
    enabled: bool


class PairRequest(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(default="", max_length=200)


def phoneOrigin(request: Request) -> str | None:
    return localAccessConfig(request.app).phoneOrigin


def phoneAccessRunning(request: Request) -> bool:
    return phoneOrigin(request) is not None and phoneAccessEnabled()


def devicesPayload(request: Request) -> dict[str, Any]:
    enabled = phoneAccessEnabled()
    address = phoneOrigin(request)

    return {
        "enabled": enabled,
        "running": address is not None,
        "address": address,
        "restartNeeded": enabled != (address is not None),
        "pairingActive": pairingCodeActive(),
        "devices": listDevices(),
    }


@router.get("/api/devices/session")
def getSession(request: Request, response: Response) -> dict[str, str]:
    response.headers["Cache-Control"] = "no-store"
    return {"kind": request.state.sessionKind}


@router.get("/api/devices")
def getDevices(request: Request, response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return devicesPayload(request)


@router.put("/api/devices/access")
def updatePhoneAccess(payload: PhoneAccessRequest, request: Request) -> dict[str, Any]:
    setPhoneAccess(payload.enabled)
    if not payload.enabled:
        clearPairingCode()
    return devicesPayload(request)


@router.post("/api/devices/pairing-code")
def startPairing(request: Request, response: Response) -> dict[str, Any]:
    if not phoneAccessRunning(request):
        raise HTTPException(status_code=409, detail=PHONE_ACCESS_OFF_DETAIL)

    response.headers["Cache-Control"] = "no-store"
    pairingCode = createPairingCode()
    return {
        **pairingCode,
        "link": f"{phoneOrigin(request)}/#pair={pairingCode['code']}",
    }


@router.delete("/api/devices/pairing-code")
def cancelPairing(request: Request) -> dict[str, Any]:
    clearPairingCode()
    return devicesPayload(request)


@router.post("/api/devices/pair")
def pairDevice(payload: PairRequest, request: Request, response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    if not phoneAccessRunning(request):
        raise HTTPException(status_code=403, detail=PHONE_ACCESS_OFF_DETAIL)

    if not redeemPairingCode(payload.code):
        raise HTTPException(status_code=401, detail=PAIRING_FAILED_DETAIL)

    if deviceLimitReached():
        raise HTTPException(status_code=409, detail=DEVICE_LIMIT_DETAIL)

    device, token = createDevice(payload.name)
    response.set_cookie(
        DEVICE_COOKIE_NAME,
        token,
        max_age=DEVICE_COOKIE_LIFETIME,
        httponly=True,
        secure=False,
        samesite="strict",
        path="/api",
    )
    return {"ok": True, "name": device["name"]}


@router.delete("/api/devices/{deviceId}")
def unpairDevice(deviceId: str, request: Request) -> dict[str, Any]:
    if not removeDevice(deviceId):
        raise HTTPException(status_code=404, detail="That device is not paired.")
    return devicesPayload(request)
