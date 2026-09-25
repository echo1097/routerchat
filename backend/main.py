from __future__ import annotations

from dotenv import load_dotenv
from fastapi import FastAPI

from backend.attachments import attachmentRoutes
from backend.brainstorm import brainstormRoutes, generateBrainstorm
from backend.changelog import changelogRoutes
from backend.chats import (
    chatImportExport,
    chatRoutes,
    chatTitles,
    folderRoutes,
    messageRoutes,
    streamMessage,
)
from backend.core import paths
from backend.core.paths import APP_VERSION
from backend.core.schema import init_db
from backend.core.startupCleanup import delete_temporary_items
from backend.frontend.staticFiles import configure_static_files
from backend.lorebook import (
    generateEntry,
    lorebookRoutes,
    repairLorebook,
    timelineRepair,
    updateRoutes,
)
from backend.security import bootstrapRoutes
from backend.security.apiSecurity import enforce_local_api_security
from backend.security.localAccessConfig import local_access_config
from backend.settings import settingsRoutes
from backend.tos import tosRoutes
from backend.transcription import transcriptionRoutes
from backend.usage import usageRoutes
from backend.webSearch import faviconRoutes
from backend.writing import chapterRoutes, storyImportExport, storyRoutes

load_dotenv(paths.ENV_PATH)

app = FastAPI(title="RouterChat", version=APP_VERSION)
app.middleware("http")(enforce_local_api_security)

featureRouters = [
    bootstrapRoutes.router,
    tosRoutes.router,
    settingsRoutes.router,
    folderRoutes.router,
    chatRoutes.router,
    chatImportExport.router,
    chatTitles.router,
    messageRoutes.router,
    streamMessage.router,
    faviconRoutes.router,
    usageRoutes.router,
    attachmentRoutes.router,
    storyRoutes.router,
    storyImportExport.router,
    chapterRoutes.router,
    changelogRoutes.router,
    lorebookRoutes.router,
    timelineRepair.router,
    updateRoutes.router,
    repairLorebook.router,
    generateEntry.router,
    brainstormRoutes.router,
    generateBrainstorm.router,
    transcriptionRoutes.router,
]

for featureRouter in featureRouters:
    app.include_router(featureRouter)


def reset_local_access_config() -> None:
    if hasattr(app.state, "localAccessConfig"):
        delattr(app.state, "localAccessConfig")


@app.on_event("startup")
def on_startup() -> None:
    local_access_config(app)
    paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    delete_temporary_items()


configure_static_files(app, paths.STATIC_DIR)
