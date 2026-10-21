from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter

from backend.chats.chatTitles import chatTitleFromModelOutput
from backend.core.appSettings import readAppSetting
from backend.core.database import getDb
from backend.core.reasoningEffort import ReasoningEffort
from backend.providers.base import ChatOptions, ChatRequest, Provider
from backend.providers.registry import getActiveProvider, providerForRow
from backend.providers.streaming import sendChat
from backend.roleplay.roleplayQueries import (
    getFirstUserMessageForTitle,
    nameNewRoleplay,
    requireRoleplay,
)
from backend.roleplay.roleplayRoutes import getRoleplayRoute

router = APIRouter()

ROLEPLAY_TITLE_PROMPT = (
    "Give a short name for this roleplay scene based on the message below. "
    "Use 3 to 5 words in Title Case. "
    "Reply with the name only, with no quotes, no final punctuation, and no explanation."
)

#a title is a handful of tokens, so the long read budget a real generation needs would only ever
#leave the rename lock sitting there after something already went wrong
ROLEPLAY_TITLE_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=15.0, pool=10.0)


def roleplayTitleFromMessage(message: str) -> str:
    words = message.strip().split()
    title = " ".join(words[:6])
    if not title:
        return "New roleplay"
    return title[:48]


@router.post("/api/roleplays/{roleplay_id}/title")
async def nameRoleplay(roleplay_id: str) -> dict[str, Any]:
    with getDb() as conn:
        roleplay = requireRoleplay(conn, roleplay_id)
        #a rename or an earlier naming run already settled this, and neither should be overwritten
        if roleplay["title"] != "New roleplay":
            return getRoleplayRoute(roleplay_id)
        first = getFirstUserMessageForTitle(conn, roleplay_id)

    if not first or not (first["content"] or "").strip():
        return getRoleplayRoute(roleplay_id)

    message = first["content"]
    provider = providerForRow(roleplay)
    api_key = provider.readKey()
    title = None
    if api_key:
        title = await generateRoleplayTitle(
            api_key, roleplay["model"], roleplay["reasoning_effort"], message, provider
        )

    #a roleplay that cannot be named is still better off with the derived title than a placeholder
    if not title:
        title = roleplayTitleFromMessage(message)

    with getDb() as conn:
        nameNewRoleplay(conn, roleplay_id, title)

    return getRoleplayRoute(roleplay_id)


def roleplayTitleRequest(
    api_key: str,
    model_id: str,
    reasoning_effort: ReasoningEffort,
    message: str,
    provider: Provider | None = None,
) -> ChatRequest:
    #asking for thinking off means passing False here, which still lets a mandatory model keep it
    return (provider or getActiveProvider()).buildRequest(
        [{"role": "user", "content": f"{ROLEPLAY_TITLE_PROMPT}\n\n{message}"}],
        model_id,
        ChatOptions(
            apiKey=api_key,
            temperature=0.3,
            maxTokens=32,
            stream=False,
            nitro=bool(readAppSetting("nitro_mode")),
            thinkingEnabled=False,
            reasoningEffort=reasoning_effort,
            explicitReasoning=True,
        ),
    )


async def generateRoleplayTitle(
    api_key: str,
    model_id: str,
    reasoning_effort: ReasoningEffort,
    message: str,
    provider: Provider | None = None,
) -> str | None:
    provider = provider or getActiveProvider()
    request = roleplayTitleRequest(api_key, model_id, reasoning_effort, message, provider)

    payload = await sendChat(provider, request, ROLEPLAY_TITLE_TIMEOUT)
    if payload is None:
        return None

    return chatTitleFromModelOutput(provider.completionText(payload))
