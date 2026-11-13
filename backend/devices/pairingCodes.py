from __future__ import annotations

import hmac
import secrets
import threading
import time
from dataclasses import dataclass

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
CODE_LIFETIME = 120
MAX_ATTEMPTS = 5


@dataclass
class PairingCode:
    code: str
    expiresAt: float
    attemptsLeft: int


codeLock = threading.Lock()
activeCode: PairingCode | None = None


def normalizeCode(supplied: str) -> str:
    return "".join(str(supplied or "").split()).replace("-", "").upper()


def createPairingCode() -> dict[str, object]:
    global activeCode

    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    with codeLock:
        activeCode = PairingCode(
            code=code,
            expiresAt=time.monotonic() + CODE_LIFETIME,
            attemptsLeft=MAX_ATTEMPTS,
        )

    return {"code": code, "expiresIn": CODE_LIFETIME}


def clearPairingCode() -> None:
    global activeCode

    with codeLock:
        activeCode = None


def pairingCodeActive() -> bool:
    global activeCode

    with codeLock:
        if activeCode and time.monotonic() >= activeCode.expiresAt:
            activeCode = None
        return activeCode is not None


def redeemPairingCode(supplied: str) -> bool:
    global activeCode

    suppliedCode = normalizeCode(supplied).encode("utf-8")
    with codeLock:
        if activeCode is None:
            return False

        if time.monotonic() >= activeCode.expiresAt:
            activeCode = None
            return False

        if hmac.compare_digest(suppliedCode, activeCode.code.encode("utf-8")):
            activeCode = None
            return True

        activeCode.attemptsLeft -= 1
        if activeCode.attemptsLeft <= 0:
            activeCode = None
        return False
