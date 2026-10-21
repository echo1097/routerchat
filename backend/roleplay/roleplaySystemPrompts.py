from __future__ import annotations

from backend.roleplay.roleplayModels import (
    RoleplayCreateRequest,
    RoleplayPatchRequest,
    StreamRoleplayMessageRequest,
)

RoleplayPayload = (
    RoleplayCreateRequest | RoleplayPatchRequest | StreamRoleplayMessageRequest
)


def roleplaySystemPrompt(payload: RoleplayPayload) -> str:
    return (
        payload.roleplay_system_prompt
        if payload.roleplay_system_prompt is not None
        else payload.system_prompt or ""
    )
