# RouterChat Developer Guide

For people who want to read or change the code. You get a Git clone you start from a terminal. Your key goes in `.env` and your chats in `data/routerchat.sqlite3`, both inside the project folder. If you just want to use RouterChat, use the [one-click installer](setup.md#1-install-routerchat).

**Contents**

1. [Requirements](#requirements)
2. [Setup](#setup)
3. [Starting again later](#starting-again-later)
4. [After pulling new code](#after-pulling-new-code)
5. [Live reload (development mode)](#live-reload-development-mode)
6. [Running tests](#running-tests)
7. [Developer install files](#developer-install-files)
8. [Troubleshooting](#troubleshooting)

---

## Requirements

| Tool | Version | Used for |
| --- | --- | --- |
| Python | 3.13 | Backend server |
| Node.js and npm | 22 LTS | Building the frontend |
| Git | any recent | Downloading the code |

---

## Setup

Run everything in a terminal (Terminal on macOS, PowerShell on Windows). Windows differences are listed [below](#on-windows).

**1. Download the code.**

```sh
git clone https://github.com/echo1097/routerchat.git
cd routerchat
```

**2. Create a virtual environment**, a private Python folder so RouterChat's packages don't mix with the rest of your system.

```sh
python3 -m venv .venv
```

**3. Activate it.** Do this in every new terminal. `(.venv)` appears at the start of your prompt when it works.

```sh
source .venv/bin/activate
```

**4. Install backend packages.** `requirements.lock` pins exact versions and hashes, so you get the tested files.

```sh
python3 -m pip install --require-hashes -r requirements.lock
```

**5. Install frontend packages.** `npm ci` installs exactly what the lock file lists.

```sh
npm ci
```

**6. Build the frontend** into the page the backend serves. Skipping this causes the "frontend build missing" error.

```sh
npm run build
```

**7. Clear the old access credential.** On start, the server writes a random one-time secret to `.routerchat-run/api-secret` and deletes it on stop. It only accepts requests that have this secret. If a leftover secret from a crash exists, it refuses to start.

```sh
mkdir -p .routerchat-run
rm -f .routerchat-run/api-secret
```

**8. Start the server.** It keeps running in this terminal, so leave it open.

```sh
python3 -m backend.local_access serve \
  --secret-file .routerchat-run/api-secret \
  --base-url http://127.0.0.1:8000 \
  --trusted-origin http://127.0.0.1:8000
```

**9. Open the browser from a second terminal.** Typing `127.0.0.1:8000` yourself won't work, because the browser needs the secret first. This command opens a small page that passes it along and sends you into RouterChat.

```sh
source .venv/bin/activate
python3 -m backend.local_access open-browser \
  --secret-file .routerchat-run/api-secret \
  --base-url http://127.0.0.1:8000
```

**10. Add your API key.** In settings, go to **API**, pick **OpenRouter** or **Anthropic** under **Provider**, paste that provider's key, and save. Keys are saved to `.env` in the project folder as `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY`. A key saved in `.env` wins over one exported in your terminal.

### On Windows

| Instead of | Use |
| --- | --- |
| `source .venv/bin/activate` | `.\.venv\Scripts\Activate.ps1` |
| `python3` | `python` |
| `mkdir -p .routerchat-run` | `New-Item -ItemType Directory -Force .routerchat-run` |
| `rm -f .routerchat-run/api-secret` | `Remove-Item .routerchat-run\api-secret -Force -ErrorAction SilentlyContinue` |

Also remove the trailing `\` and put each command on one line.

---

## Starting again later

Repeat steps 3, 7, 8, and 9. Bookmarks won't work because each restart makes a new secret, so always use `open-browser`. Press **Ctrl + C** in the server terminal to stop.

---

## After pulling new code

Refresh dependencies and rebuild:

```sh
python3 -m pip install --require-hashes -r requirements.lock
npm ci
npm run build
```

---

## Live reload (development mode)

Useful when editing the frontend, so changes show instantly without rebuilding. It runs the backend on port 8000 and Vite's dev frontend on port 5173, which is the one you use. Run `npm run build` at least once first.

### One command (macOS and Linux)

```sh
./dev.sh
```

This starts both servers, waits until they're ready, and opens an authorized browser. It stops if port 5173 or 8000 is already in use, and clears any leftover secret first. The secret lives at `~/.routerchat/dev-secret` (set `ROUTERCHAT_DEV_SECRET_FILE` to change it). Press **Ctrl + C** once to stop everything. The script uses `.venv` directly, so you don't need to activate it.

### Manually (any system)

Use three terminals, all in the `routerchat` folder.

**Terminal 1, backend.** `--trusted-origin` is now 5173, since that's where the page loads from.

```sh
source .venv/bin/activate
mkdir -p .routerchat-run
rm -f .routerchat-run/api-secret
python3 -m backend.local_access serve \
  --secret-file .routerchat-run/api-secret \
  --base-url http://127.0.0.1:8000 \
  --trusted-origin http://127.0.0.1:5173
```

**Terminal 2, frontend.**

```sh
npm run dev
```

**Terminal 3, browser.** `--base-url` is 5173 so you land on the live-reloading page.

```sh
source .venv/bin/activate
python3 -m backend.local_access open-browser \
  --secret-file .routerchat-run/api-secret \
  --base-url http://127.0.0.1:5173
```

Keep the backend on port 8000 unless you also change `vite.config.js`, which forwards API calls from 5173 to it. Press **Ctrl + C** in terminals 1 and 2 to stop.

---

## Running tests

| Tests | Command |
| --- | --- |
| Backend | `python3 -m unittest discover -s tests -p "test_*.py"` |
| Frontend | `npm run test:frontend` |
| End-to-end (Playwright) | `npm run test:e2e` |

The end-to-end tests start the Vite dev server themselves. The first time, install Playwright's browsers with `npx playwright install`.

---

## Developer install files

None of these are committed to GitHub.

| File or folder | What it is |
| --- | --- |
| `.env` | Your OpenRouter and Anthropic keys. Never share or commit it. |
| `data/routerchat.sqlite3` | Your chats, stories, and settings. |
| `data/usage.sqlite3` | Your usage history: models, token counts, and costs. |
| `.routerchat-run/api-secret` | Temporary access credential, deleted when the server stops. |
| `dist` | Built frontend from `npm run build`. |
| `.venv` | Python virtual environment. |
| `node_modules` | Installed frontend packages. |

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| **"frontend build missing"** | The build step was skipped. Run `npm run build` and restart the server. |
| **npm complains about "engines" or Node version** | Install Node.js 22 LTS, then reopen your terminal. |
| **"python is not recognized" / "command not found: python"** | Python isn't installed or isn't on your PATH. Windows: reinstall and tick **Add python.exe to PATH**. macOS: use `python3`. |
| **"RouterChat API credential file is missing"** | The server isn't running, or `--secret-file` points somewhere different. Start the server first and use the same path in both commands. |

For anything else, see [setup.md](setup.md#5-if-something-goes-wrong).
