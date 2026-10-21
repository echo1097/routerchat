from __future__ import annotations

from typing import Any

from backend.attachments.attachmentContent import (
    groupAttachmentsByMessage,
    userContentWithAttachments,
)
from backend.attachments.attachmentScope import ROLEPLAY_SCOPE
from backend.core.database import getDb
from backend.roleplay.roleplayCharacterRows import (
    roleplayCastPrompt,
    roleplayUserCharacterName,
)
from backend.roleplay.roleplayMacros import expandMacros
from backend.roleplay.roleplayQueries import getRoleplay, listContextMessages

AUTHOR_NOTE_DEPTH = 2


def authorNoteMessage(note: str, userName: str) -> dict[str, Any]:
    return {
        "role": "system",
        "content": f"Keep this in mind for what happens next: {expandMacros(note, '', userName)}",
    }


def withAuthorNote(
    messages: list[dict[str, Any]], note: str, userName: str
) -> list[dict[str, Any]]:
    if not note.strip():
        return messages

    insertAt = max(0, len(messages) - AUTHOR_NOTE_DEPTH)
    return messages[:insertAt] + [authorNoteMessage(note.strip(), userName)] + messages[insertAt:]


def buildRoleplayMessages(
    roleplay_id: str,
    system_prompt: str,
    regenerate_message_id: str | None = None,
    replacement_content: str | None = None,
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []

    with getDb() as conn:
        roleplay = getRoleplay(conn, roleplay_id)
        scenario = str(roleplay["scenario"] or "") if roleplay else ""
        authorNote = str(roleplay["author_note"] or "") if roleplay else ""

        castPrompt = roleplayCastPrompt(conn, roleplay_id, scenario)
        userName = roleplayUserCharacterName(conn, roleplay_id)
        fullPrompt = "\n\n".join(
            part for part in (system_prompt.strip(), castPrompt) if part
        )
        if fullPrompt:
            messages.append({"role": "system", "content": fullPrompt})

        rows = listContextMessages(conn, roleplay_id)
        attachmentsByMessage = groupAttachmentsByMessage(
            conn, roleplay_id, ROLEPLAY_SCOPE
        )

        turns: list[dict[str, Any]] = []

        for row in rows:
            isRegenerated = bool(regenerate_message_id) and row["id"] == regenerate_message_id
            if not isRegenerated and row["role"] not in {"user", "assistant"}:
                continue

            content = replacement_content or row["content"] if isRegenerated else row["content"]
            role = "user" if isRegenerated else row["role"]
            attachmentIds = [
                attachment["id"] for attachment in attachmentsByMessage.get(row["id"], [])
            ]

            if role == "user" and userName and str(content or "").strip():
                content = f"{userName}: {content}"

            if role == "user" and attachmentIds:
                content = userContentWithAttachments(conn, attachmentIds, content)

            turns.append({"role": role, "content": content})

            if isRegenerated:
                break

    return messages + withAuthorNote(turns, authorNote, userName)
