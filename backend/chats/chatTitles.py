from __future__ import annotations

import re
from typing import Any

import httpx
from fastapi import APIRouter

from backend.chats.chatQueries import getFirstUserMessageForTitle, nameNewChat, requireChat
from backend.chats.chatRoutes import get_chat
from backend.core.appSettings import read_app_setting
from backend.core.database import get_db
from backend.core.reasoningEffort import ReasoningEffort
from backend.providers.base import ChatOptions, ChatRequest, Provider
from backend.providers.registry import getActiveProvider, providerForRow
from backend.providers.streaming import sendChat

router = APIRouter()


def chat_title_from_message(message: str) -> str:
    words = message.strip().split()
    title = " ".join(words[:6])
    if not title:
        return "New chat"
    return title[:48]


CHAT_TITLE_PROMPT = (
    "Give a short name for this chat based on the message below. "
    "Use 3 to 5 words in Title Case. "
    "Reply with the name only, with no quotes, no final punctuation, and no explanation."
)

CHAT_TITLE_MAX_LENGTH = 48


def title_case_word(word: str) -> str:
    #an acronym the model chose on purpose reads worse after capitalize() lowercases the rest of it
    if word.isupper() and len(word) > 1:
        return word
    if any(letter.isupper() for letter in word[1:]):
        return word
    return word[:1].upper() + word[1:]


def chat_title_from_model_output(raw: str | None) -> str | None:
    if not raw:
        return None

    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if not lines:
        return None

    #a chatty model puts its preamble first and the actual name on the last line
    title = lines[-1]
    title = re.sub(r"^(?:chat\s+)?(?:name|title)\s*[:\-]\s*", "", title, flags=re.IGNORECASE)
    title = title.strip().strip("\"'`“”‘’*")
    title = title.rstrip(".!?:;,")
    title = " ".join(title.split())

    if not title:
        return None

    #the word count lives in the prompt, so only trim here when the sidebar could not show it anyway
    if len(title) > CHAT_TITLE_MAX_LENGTH:
        trimmed = title[:CHAT_TITLE_MAX_LENGTH].rsplit(" ", 1)[0]
        title = trimmed or title[:CHAT_TITLE_MAX_LENGTH]

    title = " ".join(title_case_word(word) for word in title.split(" "))

    return title or None


@router.post("/api/chats/{chat_id}/title")
async def name_chat(chat_id: str) -> dict[str, Any]:
    with get_db() as conn:
        chat = requireChat(conn, chat_id)
        #a rename or an earlier naming run already settled this, and neither should be overwritten
        if chat["title"] != "New chat":
            return get_chat(chat_id)
        first = getFirstUserMessageForTitle(conn, chat_id)

    if not first or not (first["content"] or "").strip():
        return get_chat(chat_id)

    message = first["content"]
    provider = providerForRow(chat)
    api_key = provider.readKey()
    title = None
    if api_key:
        title = await generate_chat_title(
            api_key, chat["model"], chat["reasoning_effort"], message, provider
        )

    #a chat that cannot be named is still better off with the old derived title than a placeholder
    if not title:
        title = chat_title_from_message(message)

    with get_db() as conn:
        nameNewChat(conn, chat_id, title)

    return get_chat(chat_id)


#a title is a handful of tokens, so the long read budget a real generation needs would only ever
#leave the rename lock sitting there after something already went wrong
CHAT_TITLE_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=15.0, pool=10.0)


def chat_title_request(
    api_key: str,
    model_id: str,
    reasoning_effort: ReasoningEffort,
    message: str,
    provider: Provider | None = None,
) -> ChatRequest:
    #asking for thinking off means passing False here, which still lets a mandatory model keep it
    return (provider or getActiveProvider()).buildRequest(
        [{"role": "user", "content": f"{CHAT_TITLE_PROMPT}\n\n{message}"}],
        model_id,
        ChatOptions(
            apiKey=api_key,
            temperature=0.3,
            maxTokens=32,
            stream=False,
            nitro=bool(read_app_setting("nitro_mode")),
            thinkingEnabled=False,
            reasoningEffort=reasoning_effort,
            explicitReasoning=True,
        ),
    )


async def generate_chat_title(
    api_key: str,
    model_id: str,
    reasoning_effort: ReasoningEffort,
    message: str,
    provider: Provider | None = None,
) -> str | None:
    provider = provider or getActiveProvider()
    request = chat_title_request(api_key, model_id, reasoning_effort, message, provider)

    payload = await sendChat(provider, request, CHAT_TITLE_TIMEOUT)
    if payload is None:
        return None

    return chat_title_from_model_output(provider.completionText(payload))
