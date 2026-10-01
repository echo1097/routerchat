from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.core.database import get_db
from backend.providers.registry import getProvider
from backend.writing.storyBundle import get_story_bundle

router = APIRouter()


class StoryProviderRequest(BaseModel):
    id: str


@router.post("/api/stories/{story_id}/provider")
def moveStoryToProvider(story_id: str, payload: StoryProviderRequest) -> dict[str, Any]:
    provider = getProvider(payload.id)
    if provider is None:
        raise HTTPException(status_code=404, detail="Unknown provider.")

    with get_db() as conn:
        story = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found.")

        conn.execute(
            "UPDATE stories SET provider = ?, model = ?, lorebook_model = '' WHERE id = ?",
            (provider.id, provider.defaultModelId(), story_id),
        )

    return get_story_bundle(story_id)
