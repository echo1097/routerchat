import math
from contextlib import closing
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Query


def emptyTotals():
    return {
        "cost": 0.0,
        "requests": 0,
        "promptTokens": 0,
        "outputTokens": 0,
        "reasoningTokens": 0,
        "totalTokens": 0,
        "missingCost": 0,
        "missingTokens": 0,
        "pricedTokens": 0,
        "tokenCost": 0.0,
        "knownTokens": 0,
    }


def cleanNumber(value):
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) and result >= 0 else None


def addUsage(totals, row):
    cost = cleanNumber(row["cost"])
    prompt = cleanNumber(row["prompt_tokens"])
    completion = cleanNumber(row["completion_tokens"])
    reasoning = cleanNumber(row["reasoning_tokens"])
    total = cleanNumber(row["total_tokens"])
    if total is None and prompt is not None and completion is not None:
        total = prompt + completion

    totals["requests"] += 1
    totals["cost"] += cost or 0
    totals["missingCost"] += cost is None
    totals["missingTokens"] += prompt is None or completion is None
    totals["knownTokens"] += total is not None
    totals["promptTokens"] += int(prompt or 0)
    totals["reasoningTokens"] += int(min(reasoning or 0, completion) if completion is not None else reasoning or 0)
    totals["outputTokens"] += int(max(0, (completion or 0) - (reasoning or 0)))
    totals["totalTokens"] += int(total or 0)
    if cost is not None and total is not None and total > 0:
        totals["tokenCost"] += cost
        totals["pricedTokens"] += int(total)


def finishTotals(totals):
    result = {key: value for key, value in totals.items() if key not in {"pricedTokens", "tokenCost", "knownTokens"}}
    result["blendedCost"] = totals["tokenCost"] / totals["pricedTokens"] * 1_000_000 if totals["pricedTokens"] else None
    if totals["requests"] and totals["missingCost"] == totals["requests"]:
        result["cost"] = None
    if totals["requests"] and not totals["knownTokens"]:
        result["totalTokens"] = None
    return result


def getUsage(conn, offsetMinutes=0, now=None):
    localZone = timezone(timedelta(minutes=-offsetMinutes))
    currentTime = now or datetime.now(timezone.utc)
    today = currentTime.astimezone(localZone).date()
    startDate = today - timedelta(days=6)
    previousDate = startDate - timedelta(days=7)
    lowerBound = datetime.combine(previousDate, datetime.min.time(), localZone).astimezone(timezone.utc)
    upperBound = currentTime.astimezone(timezone.utc)
    currentTotals = emptyTotals()
    previousTotals = emptyTotals()
    days = {}
    modelTotals = {}
    seenGenerations = set()

    for dayIndex in range(7):
        date = (startDate + timedelta(days=dayIndex)).isoformat()
        days[date] = {**emptyTotals(), "date": date, "models": {}}

    usageColumns = "model, generation_id, prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, cost, created_at"
    queries = [
        f"SELECT {usageColumns} FROM messages WHERE role = 'assistant'",
        f"SELECT {usageColumns} FROM story_generations WHERE 1 = 1",
        f"SELECT {usageColumns} FROM brainstorm_generations WHERE 1 = 1",
        """SELECT NULL AS model, openrouter_generation_id AS generation_id,
                  NULL AS prompt_tokens, NULL AS completion_tokens,
                  NULL AS reasoning_tokens, NULL AS total_tokens, cost, created_at
           FROM lorebook_update_runs WHERE 1 = 1""",
    ]
    for query in queries:
        rows = conn.execute(
            query + " AND julianday(created_at) >= julianday(?) AND julianday(created_at) <= julianday(?) ORDER BY created_at",
            (lowerBound.isoformat(), upperBound.isoformat()),
        )
        for row in rows:
            generationId = row["generation_id"]
            if generationId and generationId in seenGenerations:
                continue
            if generationId:
                seenGenerations.add(generationId)
            rowTime = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
            if rowTime.tzinfo is None:
                rowTime = rowTime.replace(tzinfo=timezone.utc)
            rowDate = rowTime.astimezone(localZone).date()
            if rowDate < startDate:
                addUsage(previousTotals, row)
                continue
            addUsage(currentTotals, row)
            day = days[rowDate.isoformat()]
            addUsage(day, row)
            modelId = row["model"] or "unknown"
            if modelId not in modelTotals:
                modelTotals[modelId] = emptyTotals()
            addUsage(modelTotals[modelId], row)
            day["models"][modelId] = day["models"].get(modelId, 0) + (cleanNumber(row["cost"]) or 0)

    models = [{"id": modelId, **finishTotals(totals)} for modelId, totals in modelTotals.items()]
    models.sort(key=lambda model: (-(model["cost"] or 0), -model["requests"], model["id"]))
    return {
        "startDate": startDate.isoformat(),
        "endDate": today.isoformat(),
        "current": finishTotals(currentTotals),
        "previous": finishTotals(previousTotals),
        "days": [finishTotals(day) for day in days.values()],
        "models": models,
    }


def createUsageRouter(getDb):
    router = APIRouter()

    @router.get("/api/usage")
    def usageOverview(offsetMinutes: int = Query(default=0, ge=-840, le=840)):
        with closing(getDb()) as conn:
            return getUsage(conn, offsetMinutes)

    return router
