from __future__ import annotations

import json
import re
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from backend.chats.chatRoutes import get_chat
from backend.core.appSettings import read_app_setting
from backend.core.database import get_db, message_order_clause
from backend.core.reasoningEffort import ReasoningEffort
from backend.providers.openrouter.apiKey import read_openrouter_key
from backend.providers.openrouter.client import OPENROUTER_BASE_URL, headers_for_key
from backend.providers.openrouter.models import model_supports_reasoning
from backend.providers.openrouter.requestOptions import (
    enabled_reasoning_config,
    openrouter_provider_options,
    openrouter_request_model,
)

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
        chat = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found.")
        #a rename or an earlier naming run already settled this, and neither should be overwritten
        if chat["title"] != "New chat":
            return get_chat(chat_id)
        first = conn.execute(
            f"""
            SELECT content FROM messages
            WHERE chat_id = ? AND role = 'user'
            ORDER BY {message_order_clause()}
            LIMIT 1
            """,
            (chat_id,),
        ).fetchone()

    if not first or not (first["content"] or "").strip():
        return get_chat(chat_id)

    message = first["content"]
    api_key = read_openrouter_key()
    title = None
    if api_key:
        title = await generate_chat_title(
            api_key, chat["model"], chat["reasoning_effort"], message
        )

    #a chat that cannot be named is still better off with the old derived title than a placeholder
    if not title:
        title = chat_title_from_message(message)

    with get_db() as conn:
        conn.execute(
            "UPDATE chats SET title = ? WHERE id = ? AND title = 'New chat'",
            (title, chat_id),
        )

    return get_chat(chat_id)


#a title is a handful of tokens, so the long read budget a real generation needs would only ever
#leave the rename lock sitting there after something already went wrong
CHAT_TITLE_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=15.0, pool=10.0)


def chat_title_request_body(model_id: str, reasoning_effort: ReasoningEffort, message: str) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": openrouter_request_model(model_id, bool(read_app_setting("nitro_mode"))),
        "messages": [{"role": "user", "content": f"{CHAT_TITLE_PROMPT}\n\n{message}"}],
        "temperature": 0.3,
        "max_tokens": 32,
        "stream": False,
    }

    providerOptions = openrouter_provider_options()
    if providerOptions:
        body["provider"] = providerOptions

    #asking for thinking off means passing False here, which still lets a mandatory model keep it
    reasoningConfig = enabled_reasoning_config(model_id, False, reasoning_effort)
    if reasoningConfig:
        body["reasoning"] = reasoningConfig
        body["reasoning_effort"] = reasoningConfig["effort"]
    elif model_supports_reasoning(model_id):
        body["reasoning"] = {"enabled": False, "exclude": True}
        body["reasoning_effort"] = "none"
        body["include_reasoning"] = False

    return body


async def generate_chat_title(
    api_key: str,
    model_id: str,
    reasoning_effort: ReasoningEffort,
    message: str,
) -> str | None:
    body = chat_title_request_body(model_id, reasoning_effort, message)

    try:
        async with httpx.AsyncClient(timeout=CHAT_TITLE_TIMEOUT) as client:
            response = await client.post(
                f"{OPENROUTER_BASE_URL}/chat/completions",
                headers={**headers_for_key(api_key), "Content-Type": "application/json"},
                json=body,
            )
        if response.status_code >= 400:
            return None
        payload = response.json()
    except (httpx.HTTPError, json.JSONDecodeError, ValueError):
        return None

    choices = payload.get("choices") or []
    if not choices:
        return None
    content = (choices[0].get("message") or {}).get("content")

    return chat_title_from_model_output(content)
