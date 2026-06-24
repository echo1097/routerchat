# RouterChat

Local single-user OpenRouter chat UI with a FastAPI backend, streaming responses, SQLite conversation history, model loading, and `.env` API key storage.

## Run

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm install
npm run build
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000.

## Frontend Development

```sh
npm run dev
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8000`. Run the FastAPI
server in another terminal while developing the React UI.

## Notes

- Enter an OpenRouter API key in the Connection panel and click `Save key`.
- The key is validated with OpenRouter before `OPENROUTER_API_KEY` is written to `.env`.
- Chats and cached model metadata are stored in `data/routerchat.sqlite3`.
- `.env`, `data/`, and `.venv/` are intentionally ignored by git.
