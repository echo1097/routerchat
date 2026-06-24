# AI Chat Interface Plan

## Goal

Build a compact web chat interface backed by Python that can use user-provided OpenRouter API keys. The first milestone is a static UI mock-up with no API calls, persistence, auth, or backend behavior.

## Product Shape

- Main chat workspace for composing and reading model conversations.
- Left conversation rail for switching chats, creating drafts, and seeing lightweight status.
- Right configuration inspector for OpenRouter key state, model choice, generation settings, and system profile.
- Composer-level thinking toggle for models that support reasoning or extended thought controls.
- Clear separation between mock UI state and future backend state.

## Phase 1: Static Mock-Up

- Create a responsive HTML/CSS/JS prototype.
- Use realistic sample conversations and settings.
- Include non-networked interactions for UI feel: selecting conversations, toggling the right inspector, changing model/settings, composing local-only messages.
- Mark mock-only states in the interface without building backend behavior.

## Phase 2: Python Backend

- Use FastAPI for a small HTTP API.
- Serve the static frontend or a later bundled frontend build.
- Add endpoints:
  - `GET /api/models` to fetch/cache available OpenRouter models.
  - `POST /api/chat` to proxy chat completions to OpenRouter.
  - `POST /api/keys/validate` to validate an OpenRouter key without storing it by default.
  - `GET /api/health` for local status.
- Keep API keys in memory for local sessions at first; add optional encrypted local storage later only if needed.

## Phase 3: Streaming Chat

- Add Server-Sent Events or WebSocket streaming for assistant responses.
- Render partial model output incrementally.
- Add cancel/retry controls.
- Map the thinking toggle to model-specific OpenRouter reasoning parameters only when the selected model supports them.
- Track request timing, token estimates, and provider/model errors.

## Phase 4: Conversation State

- Add local SQLite persistence for conversations, messages, selected model, and per-chat settings.
- Keep API keys out of conversation records.
- Add import/export for JSON transcripts.

## Phase 5: Hardening

- Add structured error handling for OpenRouter responses.
- Add model capability metadata such as context length, image support, and pricing.
- Add tests for API request construction, key handling, streaming parsing, and frontend state.
- Add deployment notes for local-only and private network usage.

## Initial Design Decisions

- The first screen is the actual app, not a landing page.
- The visual style is quiet and work-focused: dense enough for repeated use, but still polished.
- OpenRouter is presented as the routing layer, while model selection remains front and center.
- The API key is treated as session-sensitive state and should never be shown back in full.
- The frontend should be easy to replace later with React/Vite if the static mock-up outgrows plain HTML/CSS/JS.
