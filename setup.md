# RouterChat Setup

RouterChat runs entirely on your own computer. The only thing it needs from the outside world is an [OpenRouter API key](https://openrouter.ai/keys). RouterChat itself is free. The models you talk to may cost money.

**Contents**

1. [Install RouterChat](#1-install-routerchat)
2. [Start, stop, update, and uninstall](#2-start-stop-update-and-uninstall)
3. [Where your files live](#3-where-your-files-live)
4. [Using RouterChat](#4-using-routerchat)
5. [If something goes wrong](#5-if-something-goes-wrong)
6. [Developer installation](#6-developer-installation)

---

## 1. Install RouterChat

The one-click installer downloads the open-source RouterChat package, verifies it, and sets up a private Python runtime just for RouterChat. It does not need administrator access, and it does not need Python, Node.js, npm, or Git to already be on your computer.

**macOS (Apple Silicon or Intel)**

```sh
curl -fsSL https://echo1097.github.io/get-routerchat/install.sh | sh
```

[Inspect the macOS installer before running it.](https://github.com/echo1097/get-routerchat/blob/main/install.sh)

**Windows x64**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://echo1097.github.io/get-routerchat/install.ps1 | iex"
```

[Inspect the Windows installer before running it.](https://github.com/echo1097/get-routerchat/blob/main/install.ps1)

When the install finishes, RouterChat opens automatically at `http://127.0.0.1:8000`. Open settings, go to the **API** page, paste your OpenRouter key, and save.

---

## 2. Start, stop, update, and uninstall

| Action | macOS | Windows |
| --- | --- | --- |
| **Start** | Double-click `Start RouterChat.command` in the RouterChat folder | Open **RouterChat** from the Start Menu, or double-click `Start RouterChat.cmd` |
| **Stop** | Close the launcher window | Close the launcher window |
| **Update** | Double-click `Update RouterChat.command` | Open **Update RouterChat** from the Start Menu, or double-click `Update RouterChat.cmd` |
| **Repair** | Rerun the install command above | Rerun the install command above |
| **Uninstall** | Double-click `Uninstall RouterChat.command` in `~/Applications/RouterChat` | Open **Uninstall RouterChat** from the Start Menu |

A few things worth knowing:

- Closing the launcher window stops RouterChat. There is no background process left behind.
- Repairing replaces the application files but leaves your chats and API key alone.
- The uninstaller asks whether you want to keep your database first. If you say yes, it saves `routerchat.sqlite3` and a `README-userdata.txt` into a timestamped folder in Downloads before removing everything else.
- The launcher waits until RouterChat is actually healthy before opening your browser. If another program is already using port 8000, it tells you and stops. It will never kill a program it does not recognize.

---

## 3. Where your files live

On macOS:

```text
~/Library/Application Support/RouterChat/
```

On Windows:

```text
%LOCALAPPDATA%\RouterChat\
```

Inside that folder:

| Folder | What's in it |
| --- | --- |
| `app` | RouterChat's application files. Replaced on every update. |
| `runtime` | RouterChat's private Python and virtual environment. |
| `run` | The current process ID and a short-lived browser credential. Deleted when RouterChat stops. **Never share this.** |
| `user-data/.env` | Your OpenRouter API key. **Never share this.** |
| `user-data/routerchat.sqlite3` | Your chats, stories, settings, and history. |
| `logs` | Sanitized launcher, installer, and updater logs. |
| `backups` | Recent update backups, used to roll back a bad update. |

Updates and repairs only replace `app`. Your `user-data` is always preserved. Read [SUPPORT.md](SUPPORT.md) before sharing any logs or version information.

---

## 4. Using RouterChat

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

- Type in the box at the bottom. **Enter** sends, **Shift + Enter** starts a new line.
- The round button sends your message. Click it while the AI is typing and it stops the response.
- **New chat** is in the left sidebar. Click any old chat to reopen it.
- Hover over things to reveal buttons. Chats can be renamed or deleted, your messages edited, and AI responses copied or regenerated.
- Once a chat has messages, the model shows as **locked**. Start a new chat to switch models.

### Settings

Clicking the model name opens settings, which has six pages:

| Page | What it does |
| --- | --- |
| **API** | Your OpenRouter key, hiding free models, Turbo mode |
| **Models** | Search models, pick one, set your default |
| **System** | A standing instruction sent before every message |
| **UI** | Smooth text streaming on or off |
| **Chats** | Export or import your chats as files |
| **Advanced** | Reasoning effort, temperature, max response length |

---

## 5. If something goes wrong

**"frontend build missing"**
A developer installation skipped the build step. Run `npm run build`, then start the server again.

**npm complains about "engines" or your Node version**
This only affects developer installations. Install Node.js 22 LTS, then close and reopen your terminal.

**"python is not recognized" or "command not found: python"**
Python either isn't installed or isn't on your PATH. On Windows, reinstall it and tick the **Add python.exe to PATH** box. On macOS, type `python3` instead of `python`.

**"Port 8000 is already in use"**
Something else is using that port, often another copy of RouterChat. Close it, then start RouterChat again.

**Models won't load**
Your key is missing or invalid. Re-save it on the API settings page.

**Your chats vanished**
Packaged installs keep data in `user-data/routerchat.sqlite3`. Developer installs keep it in `data/routerchat.sqlite3`. Don't delete or share that file.

**Everything is broken and you don't know why**
Rerun the installer to repair the packaged files. If that doesn't help, follow [SUPPORT.md](SUPPORT.md) and share only sanitized logs.

---

## 6. Developer installation

This path is for people who want to read or change the code. Instead of a packaged app, you get a Git clone that you start yourself from a terminal. Your key lives in a `.env` file inside the folder, and your chats live in `data/routerchat.sqlite3` inside the folder.

If you just want to use RouterChat, use the one-click installer in [section 1](#1-install-routerchat) instead.

### What you need first

| Tool | Version | Why |
| --- | --- | --- |
| Python | 3.13 | Runs the backend server |
| Node.js and npm | 22 LTS | Builds the frontend |
| Git | any recent | Downloads the code |

### Step by step

Every command below is run from a terminal. On macOS that's Terminal, on Windows that's PowerShell. Windows differences are listed after the steps.

**1. Download the code and go into the folder.**

```sh
git clone https://github.com/echo1097/routerchat.git
cd routerchat
```

**2. Create a virtual environment.**

This is a private Python folder just for RouterChat, so its packages never mix with anything else on your system.

```sh
python3 -m venv .venv
```

**3. Turn the virtual environment on.**

You have to do this every time you open a new terminal window. You'll know it worked when `(.venv)` appears at the start of your prompt.

```sh
source .venv/bin/activate
```

**4. Install the backend packages.**

`requirements.lock` pins exact versions, so you get the same set that was tested.

```sh
python3 -m pip install -r requirements.lock
```

**5. Install the frontend packages.**

`npm ci` installs exactly what the lock file says, which is what you want here.

```sh
npm ci
```

**6. Build the frontend.**

This turns the source files into the finished page the backend serves. Without it the server starts but has nothing to show, which is the "frontend build missing" error.

```sh
npm run build
```

**7. Prepare the folder for the access credential.**

RouterChat's backend won't accept requests from just anything. When the server starts it writes a random one-time secret into `.routerchat-run/api-secret`, and deletes it again when it stops. If a stale secret is left over from a crash, the server refuses to start, so clear it first.

```sh
mkdir -p .routerchat-run
rm -f .routerchat-run/api-secret
```

**8. Start the server.**

This takes over the terminal window and keeps running. Leave it open.

```sh
python3 -m backend.local_access serve \
  --secret-file .routerchat-run/api-secret \
  --base-url http://127.0.0.1:8000 \
  --trusted-origin http://127.0.0.1:8000
```

**9. Open an authorized browser session, in a second terminal.**

Typing `127.0.0.1:8000` into your browser by hand will not work. The browser needs to be handed that one-time secret first, which is what this command does. It opens a tiny page that passes the secret along and then sends you into RouterChat.

```sh
source .venv/bin/activate
python3 -m backend.local_access open-browser \
  --secret-file .routerchat-run/api-secret \
  --base-url http://127.0.0.1:8000
```

**10. Add your API key.**

Open settings, go to **API**, paste your OpenRouter key, and save. It gets written to `.env` in the project folder.

### On Windows

Same steps, four differences:

| Instead of | Use |
| --- | --- |
| `source .venv/bin/activate` | `.\.venv\Scripts\Activate.ps1` |
| `python3` | `python` |
| `mkdir -p .routerchat-run` | `New-Item -ItemType Directory -Force .routerchat-run` |
| `rm -f .routerchat-run/api-secret` | `Remove-Item .routerchat-run\api-secret -Force -ErrorAction SilentlyContinue` |

Also drop the trailing `\` line continuations and put each command on one line.

### Starting it again later

Once it's set up, you only need steps 3, 7, 8, and 9: activate the environment, clear the old secret, run `serve`, then run `open-browser` from a second terminal.

Bookmarking the RouterChat page does not work. Every time the server restarts it makes a new secret, so you have to run `open-browser` again.

To stop the server, press **Ctrl + C** in the terminal running it.

### After pulling new code

Dependencies and the built frontend can go stale, so refresh them:

```sh
python3 -m pip install -r requirements.lock
npm ci
npm run build
```

### Development mode with live reload

Only worth setting up if you're editing the frontend and want your changes to show up instantly instead of rebuilding each time.

This runs two servers at once: the backend on port 8000, and Vite's development frontend on port 5173. You'll be looking at 5173. Run `npm run build` at least once before doing this.

You need three terminals, all in the `routerchat` folder.

**Terminal 1, the backend.** Note that `--trusted-origin` points at 5173 now, because that's where the page will actually be loaded from.

```sh
source .venv/bin/activate
mkdir -p .routerchat-run
rm -f .routerchat-run/api-secret
python3 -m backend.local_access serve \
  --secret-file .routerchat-run/api-secret \
  --base-url http://127.0.0.1:8000 \
  --trusted-origin http://127.0.0.1:5173
```

**Terminal 2, the frontend.**

```sh
npm run dev
```

**Terminal 3, to authorize the browser.** The `--base-url` here is 5173, so you land on the live-reloading page instead of the built one.

```sh
source .venv/bin/activate
python3 -m backend.local_access open-browser \
  --secret-file .routerchat-run/api-secret \
  --base-url http://127.0.0.1:5173
```

Keep the backend on port 8000 unless you also update `vite.config.js`, which is what forwards API calls from 5173 over to it. To stop, press **Ctrl + C** in terminals 1 and 2.

### Files in a developer install

| File or folder | What it is |
| --- | --- |
| `.env` | Your OpenRouter key. Never share or commit it. |
| `data/routerchat.sqlite3` | Your chats, stories, and settings. |
| `.routerchat-run/api-secret` | The temporary access credential. Deleted when the server stops. |
| `dist` | The built frontend, generated by `npm run build`. |
| `.venv` | Your Python virtual environment. |
| `node_modules` | Installed frontend packages. |

None of these are committed to GitHub.
