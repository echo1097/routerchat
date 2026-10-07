from contextlib import closing
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Query

from backend.core.appSettings import readAppSetting
from backend.usage.usageDatabase import getUsageDb
from backend.usage.usageTotals import getUsage

USAGE_PROVIDERS = {"openrouter", "anthropic", "openai", "local"}

router = APIRouter()


@router.get("/api/usage")
def usageOverview(
    offsetMinutes: int = Query(default=0, ge=-840, le=840),
    timeZone: str | None = Query(default=None, max_length=100),
    provider: str | None = Query(default=None, max_length=40),
):
    if provider == "all":
        provider = None
    if provider and provider not in USAGE_PROVIDERS:
        raise HTTPException(status_code=422, detail="Unknown provider")
    if timeZone:
        try:
            ZoneInfo(timeZone)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise HTTPException(status_code=422, detail="Invalid timezone") from error
    with closing(getUsageDb()) as conn:
        result = getUsage(conn, offsetMinutes, timeZone=timeZone, provider=provider)
    catalog = readAppSetting("transcription_models")
    modelNames = {model["id"]: model.get("name") for model in (catalog or [])}
    for model in result["models"] + result["lifetimeModels"]:
        if modelNames.get(model["id"]):
            model["name"] = modelNames[model["id"]]
    return result
