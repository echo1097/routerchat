# RouterChat Setup

RouterChat runs locally on your computer and requires an [OpenRouter API key](https://openrouter.ai/keys). RouterChat itself is free; model usage may cost money.

## Install RouterChat

The one-click installer downloads the open-source RouterChat package, verifies it, and creates a private Python runtime. It does not require administrator access or a global Python, Node.js, npm, or Git installation.

**macOS (Apple Silicon or Intel):**

```sh
curl -fsSL https://echo1097.github.io/get-routerchat/install.sh | sh
```

[Inspect the macOS installer before running it.](https://github.com/echo1097/get-routerchat/blob/main/install.sh)

**Windows x64:**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://echo1097.github.io/get-routerchat/install.ps1 | iex"
```

[Inspect the Windows installer before running it.](https://github.com/echo1097/get-routerchat/blob/main/install.ps1)

When installation finishes, RouterChat opens at `http://127.0.0.1:8000`. Open settings, choose **API**, paste your key, and save it.

## Start, stop, update, repair, and uninstall

- **Start on macOS:** double-click `Start RouterChat.command` in the RouterChat installation folder.
- **Start on Windows:** open **RouterChat** from the Start Menu or double-click `Start RouterChat.cmd`.
- **Stop:** close the launcher window. RouterChat stops with it.
- **Update on macOS:** double-click `Update RouterChat.command`.
- **Update on Windows:** open **Update RouterChat** from the Start Menu or double-click `Update RouterChat.cmd`.
- **Repair:** rerun the original one-click installer command. Repair preserves `user-data`.
- **Uninstall on macOS:** double-click `Uninstall RouterChat.command` in `~/Applications/RouterChat`.
- **Uninstall on Windows:** open **Uninstall RouterChat** from the Start Menu.

The uninstaller asks whether to save your database first. If you choose yes, it places `routerchat.sqlite3` and `README-userdata.txt` in a timestamped folder under Downloads before removing RouterChat.

The launcher opens the browser only after RouterChat is healthy. If port 8000 belongs to another program, it reports the conflict and does not stop that program.

## Installed files and private data

On macOS, RouterChat lives at:

```text
~/Library/Application Support/RouterChat/
```

On Windows, RouterChat lives at:

```text
%LOCALAPPDATA%\RouterChat\
```

The important child folders are:

- `app`: replaceable RouterChat application files.
- `runtime`: RouterChat's private Python and virtual environment.
- `user-data/.env`: your OpenRouter API key. Never share this file.
- `user-data/routerchat.sqlite3`: chats, stories, settings, and history.
- `logs`: sanitized launcher, installer, and updater logs.
- `backups`: recent update backups used for rollback.

Updates and repairs replace `app` but preserve `user-data`. See [SUPPORT.md](SUPPORT.md) before sharing logs or version information.

## Manual installation for developers

The manual path is for contributors and advanced users who want a Git clone. It keeps the existing repo-local `.env` and `data/routerchat.sqlite3` behavior.

Install Python 3.13, Node.js 22, npm, and Git, then run:

```sh
git clone https://github.com/echo1097/routerchat.git
cd routerchat
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.lock
npm ci
npm run build
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

On Windows, activate the environment with `.\.venv\Scripts\Activate.ps1` and use `python` in place of `python3`.

For later manual starts, activate `.venv`, run the Uvicorn command again, and open `http://127.0.0.1:8000`. Stop it with `Ctrl + C`. After `git pull`, synchronize dependencies and rebuild:

```sh
python3 -m pip install -r requirements.lock
npm ci
npm run build
```

---

## Using it

RouterChat has two modes. The toggle sits at the top of the left sidebar.

| | **Chat** | **Write** |
| --- | --- | --- |
| For | Asking questions, back-and-forth | Writing long fiction |
| You get | A conversation | A story split into chapters |
| The AI | Replies to your message | Writes or edits the chapter you're on |

**Chat** is what you'd expect. You type, it answers, the whole conversation stays on screen.

**Write** is a book editor. You make a story, and inside it, chapters. Instead of chatting, you tell the AI what should happen and it writes the chapter directly onto the page, or edits the chapter you already have. Two buttons control which: **New Chapter** writes fresh, **Edit Chapter** rewrites what's there.

Write mode also keeps a **Lorebook**, a running file of your characters, places, and events. It fills itself in as you write so the AI remembers who everyone is fifty chapters later. There's also **Brainstorm** for spinning off ideas without touching the story. Both are in the menu next to the prompt box.

### Chat basics

- Type in the box at the bottom, press **Enter** to send, **Shift + Enter** for a new line.
- The round button sends your message, and stops the AI mid-response if you click it while it's typing.
- **New chat** is in the left sidebar. Click any old chat to reopen it.
- Hover over things to reveal buttons: chats can be renamed or deleted, your messages edited, and AI responses copied or regenerated.
- Once a chat has messages the model shows as **locked**. Start a new chat to switch models.

### Settings

Clicking the model name opens settings, which has six pages:

| Page | What it does |
| --- | --- |
| **API** | Your OpenRouter key, hiding free models, Turbo mode |
| **Models** | Search models, pick one, set your default |
| **System** | A standing instruction sent before every message |
| **UI** | Smooth text streaming on/off |
| **Chats** | Export or import your chats as files |
| **Advanced** | Reasoning effort, temperature, max response length |

---

## If something goes wrong

**"frontend build missing"**: a manual installation skipped the build step. Run `npm run build`, then start the server again.

**npm complains about "engines" or your Node version**: this only applies to manual installations. Install Node.js 22 LTS, then close and reopen your terminal.

**"python is not recognized" / "command not found: python"**: Python either isn't installed or wasn't added to PATH. On Windows, reinstall it and check the **Add python.exe to PATH** box. On macOS, use `python3` instead of `python`.

**"Port 8000 is already in use"**: close the other program or RouterChat instance using port 8000, then start RouterChat again. The packaged launcher will not kill an unidentified process.

**Models won't load**: your key is missing or invalid. Re-save it on the API settings page.

**Your chats vanished**: packaged data is in `user-data/routerchat.sqlite3`; manual Git clone data is in `data/routerchat.sqlite3`. Do not delete or share the database.

**Everything is broken and you don't know why**: rerun the installer to repair packaged files. If that fails, follow [SUPPORT.md](SUPPORT.md) and share only sanitized logs.

---

## Manual Git clone data

Inside a manually cloned `routerchat` folder, `.env` contains the key and `data/routerchat.sqlite3` contains local app data. `dist`, `.venv`, and `node_modules` are generated. None of these private files are committed to GitHub.

---

## Optional: Development mode

Only useful if you're editing the code and want changes to appear instantly.

This runs two servers at once, so you need two terminal windows, both opened in the `routerchat` folder.

**Terminal 1** (the backend):

```sh
source .venv/bin/activate                                              # Windows: .\.venv\Scripts\Activate.ps1
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000       # Windows: python -m uvicorn ...
```

**Terminal 2** (the frontend):

```sh
npm run dev
```

Then open `http://127.0.0.1:5173`, and note the different number.

Run `npm run build` at least once before this, and keep the backend on port 8000 unless you also edit `vite.config.js`. To stop, press `Ctrl + C` in both windows.
