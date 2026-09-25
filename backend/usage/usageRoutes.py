from contextlib import closing
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Query

from backend.core.appSettings import read_app_setting
from backend.core.database import get_db
from backend.usage.usageTotals import getUsage

router = APIRouter()


@router.get("/api/usage")
def usageOverview(offsetMinutes: int = Query(default=0, ge=-840, le=840), timeZone: str | None = Query(default=None, max_length=100)):
    if timeZone:
        try:
            ZoneInfo(timeZone)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise HTTPException(status_code=422, detail="Invalid timezone") from error
    with closing(get_db()) as conn:
        result = getUsage(conn, offsetMinutes, timeZone=timeZone)
    catalog = read_app_setting("transcription_models")
    modelNames = {model["id"]: model.get("name") for model in (catalog or [])}
    for model in result["models"] + result["lifetimeModels"]:
        if modelNames.get(model["id"]):
            model["name"] = modelNames[model["id"]]
    return result
