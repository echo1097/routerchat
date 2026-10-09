from __future__ import annotations

from typing import Any

from backend.providers.anthropic.schemaCleaner import cleanSchema

ANTHROPIC_PREFIX = "anthropic/"


def isAnthropicModel(modelId: str) -> bool:
    return modelId.startswith(ANTHROPIC_PREFIX)


def responseFormatForModel(modelId: str, responseFormat: dict[str, Any]) -> dict[str, Any]:
    if not isAnthropicModel(modelId):
        return responseFormat
    if responseFormat.get("type") != "json_schema":
        return responseFormat

    jsonSchema = dict(responseFormat.get("json_schema") or {})
    if "schema" in jsonSchema:
        jsonSchema["schema"] = cleanSchema(jsonSchema["schema"])

    return {**responseFormat, "json_schema": jsonSchema}
