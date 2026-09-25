from __future__ import annotations

from backend.chats.chatModels import (
    ChatCreateRequest,
    ChatPatchRequest,
    StreamMessageRequest,
)


def chatSystemPrompt(payload: ChatCreateRequest | ChatPatchRequest | StreamMessageRequest) -> str:
    return (
        payload.chat_system_prompt
        if payload.chat_system_prompt is not None
        else payload.system_prompt or ""
    )


def writeSystemPrompt(payload: ChatCreateRequest | ChatPatchRequest | StreamMessageRequest) -> str:
    return (
        payload.write_system_prompt
        if payload.write_system_prompt is not None
        else payload.system_prompt or ""
    )
