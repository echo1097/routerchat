import base64
import binascii
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


class TranscriptionRequest(BaseModel):
    audio: str = Field(min_length=1, max_length=16_000_000)
    format: Literal["webm", "m4a", "ogg", "wav"]


def createTranscriptionRouter(readKey, readSetting, writeSetting, headersForKey, baseUrl):
    router = APIRouter()

    async def providerRequest(method, path, **options):
        apiKey = readKey()
        if not apiKey:
            raise HTTPException(401, "Add an OpenRouter API key first.")
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.request(
                    method, f"{baseUrl}/{path}", headers=headersForKey(apiKey), **options
                )
            if response.status_code >= 400:
                raise HTTPException(response.status_code, "OpenRouter could not complete the transcription request. Check your model, credits, and audio format.")
            return response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise HTTPException(502, "Could not read a response from OpenRouter. Please try again.") from error

    @router.get("/api/transcription/models")
    async def getModels():
        payload = await providerRequest("GET", "models", params={"output_modalities": "transcription"})
        models = [model for model in payload.get("data", []) if model.get("id")]
        writeSetting("transcription_models", models)
        return {"models": models}

    @router.post("/api/transcription")
    async def transcribeAudio(payload: TranscriptionRequest):
        try:
            audioBytes = base64.b64decode(payload.audio, validate=True)
        except (ValueError, binascii.Error) as error:
            raise HTTPException(400, "Invalid recording data.") from error
        if not audioBytes:
            raise HTTPException(400, "The recording is empty.")
        if readSetting("privacy_mode") or readSetting("zdr_mode"):
            raise HTTPException(400, "Transcription is unavailable with Privacy or ZDR enabled because this endpoint does not guarantee those routing settings.")
        modelId = readSetting("transcription_model") or "openai/whisper-1"
        result = await providerRequest("POST", "audio/transcriptions", json={
            "model": modelId,
            "input_audio": {"data": payload.audio, "format": payload.format},
        })
        transcript = result.get("text")
        if not isinstance(transcript, str) or not transcript.strip():
            raise HTTPException(422, "No speech was detected. Try recording again.")
        return {"text": transcript.strip()}

    return router
