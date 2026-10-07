from __future__ import annotations

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
from backend.startup.initDatabase import initDb
from backend.core.startupCleanup import deleteTemporaryItems, resetStaleBrainstormGenerations
from backend.frontend.staticFiles import configureStaticFiles
from backend.lorebook import (
    generateEntry,
    lorebookRoutes,
    repairLorebook,
    timelineRepair,
    updateRoutes,
)
from backend.providers import providerRoutes
from backend.providers.envKeys import loadSavedKeys
from backend.security import bootstrapRoutes
from backend.security.apiSecurity import enforceLocalApiSecurity
from backend.security.localAccessConfig import localAccessConfig
from backend.settings import settingsRoutes
from backend.tos import tosRoutes
from backend.transcription import transcriptionRoutes
from backend.usage import usageRoutes
from backend.webSearch import faviconRoutes
from backend.writing import chapterRoutes, storyImportExport, storyProviderRoutes, storyRoutes

loadSavedKeys()

app = FastAPI(title="RouterChat", version=APP_VERSION)
app.middleware("http")(enforceLocalApiSecurity)

featureRouters = [
    bootstrapRoutes.router,
    tosRoutes.router,
    settingsRoutes.router,
    providerRoutes.router,
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
    storyProviderRoutes.router,
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


def resetLocalAccessConfig() -> None:
    if hasattr(app.state, "localAccessConfig"):
        delattr(app.state, "localAccessConfig")


@app.on_event("startup")
def onStartup() -> None:
    localAccessConfig(app)
    paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
    initDb()
    deleteTemporaryItems()
    resetStaleBrainstormGenerations()


configureStaticFiles(app, paths.STATIC_DIR)
