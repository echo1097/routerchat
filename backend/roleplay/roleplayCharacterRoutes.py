from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.core.database import getDb
from backend.core.utils import utcNow
from backend.roleplay.roleplayCharacterQueries import (
    deleteCharacter,
    demoteOtherUserCharacters,
    getCharacter,
    getRoleplayCharacter,
    insertCharacter,
    listCharacters,
    nextCharacterOrder,
    updateCharacter,
)
from backend.roleplay.roleplayCharacterRows import (
    normalizeCharacterKind,
    rowToCharacter,
)
from backend.roleplay.roleplayModels import RoleplayCharacterRequest
from backend.roleplay.roleplayQueries import requireRoleplay

router = APIRouter()


@router.get("/api/roleplays/{roleplay_id}/characters")
def listRoleplayCharacters(roleplay_id: str) -> dict[str, Any]:
    with getDb() as conn:
        requireRoleplay(conn, roleplay_id)
        rows = listCharacters(conn, roleplay_id)
    return {"characters": [rowToCharacter(row) for row in rows]}


@router.post("/api/roleplays/{roleplay_id}/characters")
def createRoleplayCharacter(
    roleplay_id: str, payload: RoleplayCharacterRequest
) -> dict[str, Any]:
    now = utcNow()
    character_id = str(uuid.uuid4())
    kind = normalizeCharacterKind(payload.kind)

    with getDb() as conn:
        requireRoleplay(conn, roleplay_id)
        insertCharacter(
            conn,
            (
                character_id,
                roleplay_id,
                payload.name.strip(),
                kind,
                payload.description,
                payload.appearance,
                payload.personality,
                payload.speech_style,
                payload.color,
                int(payload.disabled),
                nextCharacterOrder(conn, roleplay_id),
                now,
                now,
            ),
        )
        if kind == "user":
            demoteOtherUserCharacters(conn, roleplay_id, character_id, now)
        row = getCharacter(conn, character_id)

    return {"character": rowToCharacter(row)}


@router.patch("/api/roleplays/{roleplay_id}/characters/{character_id}")
def updateRoleplayCharacter(
    roleplay_id: str, character_id: str, payload: RoleplayCharacterRequest
) -> dict[str, Any]:
    now = utcNow()
    kind = normalizeCharacterKind(payload.kind)

    with getDb() as conn:
        if not getRoleplayCharacter(conn, roleplay_id, character_id):
            raise HTTPException(status_code=404, detail="Character not found.")
        updateCharacter(
            conn,
            (
                payload.name.strip(),
                kind,
                payload.description,
                payload.appearance,
                payload.personality,
                payload.speech_style,
                payload.color,
                int(payload.disabled),
                now,
                roleplay_id,
                character_id,
            ),
        )
        if kind == "user":
            demoteOtherUserCharacters(conn, roleplay_id, character_id, now)
        row = getCharacter(conn, character_id)

    return {"character": rowToCharacter(row)}


@router.delete("/api/roleplays/{roleplay_id}/characters/{character_id}")
def removeRoleplayCharacter(roleplay_id: str, character_id: str) -> dict[str, Any]:
    with getDb() as conn:
        result = deleteCharacter(conn, roleplay_id, character_id)
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Character not found.")
    return {"ok": True}
