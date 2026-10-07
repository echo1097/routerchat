from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend.core.database import get_db
from backend.providers.providerRoutes import requireProvider
from backend.writing.storyBundle import get_story_bundle
from backend.stories.storyQueries import requireStory

router = APIRouter()


class StoryProviderRequest(BaseModel):
    id: str


@router.post("/api/stories/{story_id}/provider")
def moveStoryToProvider(story_id: str, payload: StoryProviderRequest) -> dict[str, Any]:
    provider = requireProvider(payload.id)

    with get_db() as conn:
        story = requireStory(conn, story_id)

        conn.execute(
            "UPDATE stories SET provider = ?, model = ?, lorebook_model = '' WHERE id = ?",
            (provider.id, provider.defaultModelId(), story_id),
        )

    return get_story_bundle(story_id)
