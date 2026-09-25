from typing import Any

from pydantic import BaseModel, Field


class LorebookEntryRequest(BaseModel):
    name: str = Field(min_length=1)
    category: str = "note"
    description: str = ""
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    disabled: bool = False
    revision: int | None = Field(default=None, ge=0)


class LorebookUpdateRequest(BaseModel):
    chapter_id: str = Field(min_length=1)


class TimelineRepairRequest(BaseModel):
    current_timeline: str = ""

class StoryArchiveLorebookEntry(BaseModel):
    id: str = Field(min_length=1)
    story_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    category: str = "note"
    description: str = ""
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    revision: int = Field(default=0, ge=0)
    disabled: bool = False
    created_at: str = ""
    updated_at: str = ""
