# RouterChat Setup

RouterChat runs on your own computer and uses an [OpenRouter API key](https://openrouter.ai/keys) for model features. RouterChat is free, but models and searches may cost money. Installing, updates, release notes, and some optional UI features also use the internet.

**Contents**

1. [Install RouterChat](#1-install-routerchat)
2. [Start, stop, update, and uninstall](#2-start-stop-update-and-uninstall)
3. [Where your files live](#3-where-your-files-live)
4. [Using RouterChat](#4-using-routerchat)
5. [If something goes wrong](#5-if-something-goes-wrong)

Want to run from source or change the code? See [developer.md](developer.md).

---

## 1. Install RouterChat

The one-click installer downloads and verifies the open-source RouterChat package and sets up a private Python runtime for it. You don't need administrator access, Python, Node.js, npm, or Git.

**macOS (Apple Silicon or Intel)** ([inspect installer](https://github.com/echo1097/get-routerchat/blob/main/install.sh))

```sh
curl -fsSL https://echo1097.github.io/get-routerchat/install.sh | sh
```

**Windows x64** ([inspect installer](https://github.com/echo1097/get-routerchat/blob/main/install.ps1))

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://echo1097.github.io/get-routerchat/install.ps1 | iex"
```

RouterChat then opens at `http://127.0.0.1:8000`. Open settings, go to **API**, paste your OpenRouter key, and save.

---

## 2. Start, stop, update, and uninstall

| Action | macOS (RouterChat folder) | Windows |
| --- | --- | --- |
| **Start** | `Start RouterChat.command` | **RouterChat** in the Start Menu, or `Start RouterChat.cmd` |
| **Stop** | Close the launcher window | Close the launcher window |
| **Update** | `Update RouterChat.command` | **Update RouterChat** in the Start Menu, or `Update RouterChat.cmd` |
| **Repair** | Rerun the install command | Rerun the install command |
| **Uninstall** | `Uninstall RouterChat.command` | **Uninstall RouterChat** in the Start Menu |

On macOS, the RouterChat folder is on your Desktop and in `~/Applications/RouterChat` (the Applications folder inside your home folder, not the main one). Both are shortcuts to the real files in `~/Library/Application Support/RouterChat`. The Desktop shortcut is only created on a fresh install.

Good to know:

- Closing the launcher window fully stops RouterChat. Nothing keeps running in the background.
- Repair replaces the app files but keeps your chats and API key.
- The uninstaller asks if you want to keep your database. If yes, it saves `routerchat.sqlite3` and `README-userdata.txt` to a timestamped folder in Downloads first.
- The launcher only opens your browser once RouterChat is healthy. If another program is using port 8000, it tells you and stops. It never kills a program it doesn't recognize.

---

## 3. Where your files live

| | Path |
| --- | --- |
| macOS | `~/Library/Application Support/RouterChat` |
| Windows | `%LOCALAPPDATA%\RouterChat` |

These folders are hidden, so paste the path instead of clicking through:

- **macOS:** in Finder, press **Shift + Command + G** (or **Go > Go to Folder**), paste, press Enter.
- **Windows:** press **Windows + R** (or click the File Explorer address bar), paste, press Enter.

| Inside | What's in it |
| --- | --- |
| `app` | Application files. Replaced on every update. |
| `runtime` | Private Python and virtual environment. |
| `run` | Current process ID and a short-lived browser credential. Deleted when RouterChat stops. **Never share.** |
| `user-data/.env` | Your OpenRouter API key. **Never share.** |
| `user-data/routerchat.sqlite3` | Your chats, stories, settings, and history. |
| `logs` | Sanitized launcher, installer, and updater logs. |
| `backups` | Recent update backups, used to roll back a bad update. |

Updates and repairs only replace `app`, so `user-data` is always kept. Read [SUPPORT.md](SUPPORT.md) before sharing logs or version info.

---

## 4. Using RouterChat

RouterChat has two modes, switched with the toggle at the top of the left sidebar.

| | **Chat** | **Write** |
| --- | --- | --- |
| For | Questions and back-and-forth | Long fiction |
| You get | A conversation | A story split into chapters |
| The AI | Replies to your message | Writes or edits the current chapter |

**Chat** works like any chat app. The whole conversation stays on screen.

**Write** is a book editor. You create a story with chapters, describe what should happen, and the AI writes it onto the page. **New Chapter** writes a fresh one, **Edit Chapter** rewrites the current one.

Write mode also has a **Lorebook**, which automatically tracks your characters, places, and events so the AI remembers them fifty chapters later, and **Brainstorm**, for exploring ideas without changing the story. Both are in the menu next to the prompt box.

**Voice input** is the microphone button next to the prompt box in Chat, Write, and Brainstorm. It records up to two minutes, then either fills in the prompt or transcribes and sends. Recordings go to OpenRouter for transcription, so voice input is off while Privacy mode or Zero data retention is on.

### Chat basics

- **Enter** sends, **Shift + Enter** adds a new line.
- The round button sends. Click it while the AI is replying to stop it.
- The plus icon attaches up to five files per message: images and PDFs up to 10 MB each, text or code files up to 256 KB. Images only work with models that support image input.
- **Web search** searches before answering and shows sources and citations. OpenRouter bills each search.
- **New chat** and your old chats are in the left sidebar.
- Hover to reveal buttons: rename or delete chats, edit your messages, copy or regenerate AI replies.
- Once a chat has messages, its model is **locked**. Start a new chat to switch models.

### Settings

Click the model name to open settings. Each mode shows eight pages:

- **Chat:** API, Models, Transcription, System, UI, Chats, Advanced, Usage
- **Write:** API, Models, Transcription, UI, Chats, Advanced, Lorebook, Usage

| Page | What it does |
| --- | --- |
| **API** | OpenRouter key, chat naming, free-model filtering, Turbo, Cheapest first, Privacy mode, Zero data retention |
| **Models** | Search, pick, and set a default model |
| **Transcription** | OpenRouter model used for voice input |
| **System** | Instruction sent before every Chat message (Write uses a per-story system prompt instead) |
| **UI** | Navigation bar and smooth text streaming |
| **Chats** | Export or import chats as files |
| **Advanced** | Reasoning effort, temperature, max response length |
| **Lorebook** | Model used for a story's lorebook work (Write only) |
| **Usage** | Last 7 days of spending, requests, and tokens, plus lifetime totals per model |

---

## 5. If something goes wrong

| Problem | Fix |
| --- | --- |
| **"Port 8000 is already in use"** | Another program, often another RouterChat, is using it. Close it and start again. |
| **Models won't load** | Your key is missing or invalid. Re-save it on the API page. |
| **Your chats vanished** | Packaged installs store them in `user-data/routerchat.sqlite3`, developer installs in `data/routerchat.sqlite3`. Don't delete or share that file. |
| **Everything is broken** | Rerun the installer to repair. If that fails, follow [SUPPORT.md](SUPPORT.md) and share only sanitized logs. |

Developer install problems (build, Node, Python) are covered in [developer.md](developer.md#troubleshooting).

