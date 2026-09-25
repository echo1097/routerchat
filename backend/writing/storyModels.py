from pydantic import BaseModel, Field

from backend.brainstorm.brainstormModels import StoryArchiveBrainstorm
from backend.core.reasoningEffort import LenientReasoningEffort, ReasoningEffort
from backend.lorebook.lorebookModels import StoryArchiveLorebookEntry
from backend.writing.storyGeneration import DEFAULT_MAX_TOKENS


class StoryCreateRequest(BaseModel):
    title: str = Field(default="New story", min_length=1)
    author: str = ""
    language: str = "English"
    synopsis: str = ""
    model: str | None = None
    system_prompt: str = ""
    temperature: float = 0.7
    max_tokens: int = DEFAULT_MAX_TOKENS
    thinking_enabled: bool = False
    reasoning_effort: ReasoningEffort = "medium"
    temporary: bool = False
    lorebook_auto: bool = False
    lorebook_model: str = ""


class StoryPatchRequest(BaseModel):
    title: str | None = None
    author: str | None = None
    language: str | None = None
    synopsis: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    thinking_enabled: bool | None = None
    reasoning_effort: ReasoningEffort | None = None
    lorebook_auto: bool | None = None
    lorebook_model: str | None = None


class ChapterCreateRequest(BaseModel):
    title: str = Field(default="New chapter", min_length=1)
    content: str = ""


class StoryWithInitialChapterRequest(StoryCreateRequest):
    initial_chapter: ChapterCreateRequest


class ChapterPatchRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    order_index: int | None = None
    disabled: bool | None = None
    revision: int | None = Field(default=None, ge=0)


class ChapterContentRequest(BaseModel):
    content: str = ""
    revision: int = Field(ge=0)


class StoryArchiveStory(BaseModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    author: str = ""
    language: str = "English"
    synopsis: str = ""
    model: str | None = None
    system_prompt: str = ""
    temperature: float = 0.7
    max_tokens: int = Field(default=DEFAULT_MAX_TOKENS, gt=0)
    thinking_enabled: bool = False
    reasoning_effort: LenientReasoningEffort = "medium"
    lorebook_auto: bool = False
    lorebook_model: str = ""
    created_at: str = ""
    updated_at: str = ""


class StoryArchiveChapter(BaseModel):
    id: str = Field(min_length=1)
    story_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    content: str = ""
    revision: int = Field(default=0, ge=0)
    order_index: int = Field(default=0, ge=0)
    disabled: bool = False
    created_at: str = ""
    updated_at: str = ""


class StoryArchiveHistoryEntry(BaseModel):
    id: str = Field(min_length=1)
    story_id: str = Field(min_length=1)
    chapter_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    detail: str = ""
    entry_order: int = Field(default=0, ge=0)
    kind: str | None = None
    words_added: int | None = Field(default=None, ge=0)
    words_removed: int | None = Field(default=None, ge=0)
    created_at: str = ""


class StoryImportRequest(BaseModel):
    format_schema: str = Field(alias="schema")
    story: StoryArchiveStory
    chapters: list[StoryArchiveChapter] = Field(default_factory=list)
    chapter_history: list[StoryArchiveHistoryEntry] = Field(default_factory=list)
    lorebook: list[StoryArchiveLorebookEntry] = Field(default_factory=list)
    brainstorm: StoryArchiveBrainstorm = Field(default_factory=StoryArchiveBrainstorm)
