from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend.core.database import get_db
from backend.providers.providerRoutes import requireProvider
from backend.writing.storyBundle import get_story_bundle
from backend.stories.storyQueries import moveStoryProvider, requireStory

router = APIRouter()


class StoryProviderRequest(BaseModel):
    id: str


@router.post("/api/stories/{story_id}/provider")
def moveStoryToProvider(story_id: str, payload: StoryProviderRequest) -> dict[str, Any]:
    provider = requireProvider(payload.id)

    with get_db() as conn:
        story = requireStory(conn, story_id)

        moveStoryProvider(conn, story_id, provider.id, provider.defaultModelId())

    return get_story_bundle(story_id)
