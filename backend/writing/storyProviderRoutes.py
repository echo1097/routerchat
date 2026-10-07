from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend.core.database import getDb
from backend.providers.providerRoutes import requireProvider
from backend.writing.storyBundle import getStoryBundle
from backend.stories.storyQueries import moveStoryProvider, requireStory

router = APIRouter()


class StoryProviderRequest(BaseModel):
    id: str


@router.post("/api/stories/{story_id}/provider")
def moveStoryToProvider(story_id: str, payload: StoryProviderRequest) -> dict[str, Any]:
    provider = requireProvider(payload.id)

    with getDb() as conn:
        requireStory(conn, story_id)

        moveStoryProvider(conn, story_id, provider.id, provider.defaultModelId())

    return getStoryBundle(story_id)
