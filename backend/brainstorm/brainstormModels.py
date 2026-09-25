from pydantic import BaseModel, Field


class BrainstormNodePatchRequest(BaseModel):
    title: str | None = None
    content: str | None = None
    position_x: float | None = None
    position_y: float | None = None


class BrainstormViewportRequest(BaseModel):
    position_x: float
    position_y: float
    zoom: float = Field(ge=0.1, le=4.0)

class StoryArchiveBrainstormNode(BaseModel):
    id: str = Field(min_length=1)
    story_id: str = Field(min_length=1)
    node_type: str = Field(min_length=1)
    title: str = ""
    content: str = ""
    position_x: float = 0
    position_y: float = 0
    status: str = "complete"
    created_at: str = ""
    updated_at: str = ""


class StoryArchiveBrainstormEdge(BaseModel):
    id: str = Field(min_length=1)
    story_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    created_at: str = ""


class StoryArchiveViewport(BaseModel):
    x: float = 0
    y: float = 0
    zoom: float = Field(default=1, ge=0.1, le=4.0)


class StoryArchiveBrainstorm(BaseModel):
    nodes: list[StoryArchiveBrainstormNode] = Field(default_factory=list)
    edges: list[StoryArchiveBrainstormEdge] = Field(default_factory=list)
    viewport: StoryArchiveViewport = Field(default_factory=StoryArchiveViewport)
