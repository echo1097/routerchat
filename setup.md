# RouterChat Setup

RouterChat runs on your own computer. Nothing is hosted for you, so you have to install two free programs, download the project, and start it. It takes about 15 minutes the first time.

You do not need to know how to code. You will copy commands into a black text window and press Enter.

**Stuck?** Download [assistant.md](assistant.md) and upload it to ChatGPT or Claude. It turns the AI into a RouterChat setup helper.

---

## Before you start

Three things:

1. **Python**: free, runs the part of RouterChat that talks to the AI models.
2. **Node.js**: free, builds the part you look at in your browser. It comes with a helper called **npm**.
3. **An OpenRouter API key**: this is the part that actually costs money. Get one at [openrouter.ai/keys](https://openrouter.ai/keys). RouterChat is free; the AI models are not.

### The terminal

The "terminal" is a window where you type commands instead of clicking buttons.

- **macOS:** it's called **Terminal**. Press `Cmd + Space`, type `Terminal`, press Enter.
- **Windows:** it's called **PowerShell**. Press the Start button, type `PowerShell`, press Enter.

Rules for the whole guide:

- Run one line at a time. Type or paste it, press Enter, wait for it to finish.
- If a command fails, **stop**. Fix that error before moving on. Skipping ahead makes things worse.
- Some commands print a wall of text. That is normal. Only errors matter.

---

## Step 1: Install Python

First check if you already have it.

**macOS:**

```sh
python3 --version
```

**Windows:**

```powershell
python --version
```

If it prints `Python 3.10` or higher (like `Python 3.13.1`), skip to Step 2.

If it says "command not found" or shows an older version:

1. Go to [python.org/downloads](https://www.python.org/downloads/).
2. Download the big yellow "Download Python" button.
3. Open the downloaded file.
4. **Windows only:** on the first screen, check the box that says **Add python.exe to PATH**. This is easy to miss and everything breaks without it.
5. Click through the installer.
6. **Close your terminal window and open a new one.** New programs only show up in fresh windows.
7. Run the version command again to confirm.

---

## Step 2: Install Node.js

Check if you already have it:

```sh
node --version
npm --version
```

RouterChat needs Node **20.19.0 or newer**, or **22.12.0 or newer**. If you have that, skip to Step 3.

Otherwise:

1. Go to [nodejs.org/en/download](https://nodejs.org/en/download).
2. Download the **LTS** installer for your system.
   - **Windows:** grab the `.msi` installer.
   - **macOS:** grab the `.pkg` installer. If it asks for your chip type, pick **ARM64** for Apple Silicon (M1/M2/M3/M4) or **x64** for Intel. Not sure? Apple menu → About This Mac → look at the chip line.
3. Run the installer and keep all the default options.
4. **Close your terminal and open a new one.**
5. Run `node --version` and `npm --version` again to confirm.

---

## Step 3: Download RouterChat

**Best option (makes updating easy):** paste this into your terminal.

```sh
git clone https://github.com/echo1097/routerchat.git
cd routerchat
```

If `git` is not installed, macOS will offer to install it, so say yes and run the command again. Windows users can get it from [git-scm.com](https://git-scm.com/downloads).

Later, updating is one command: `git pull`.

**Simpler option (harder to update):** go to the [GitHub page](https://github.com/echo1097/routerchat), click the green **Code** button, click **Download ZIP**, and unzip it somewhere you can find again, like your Desktop.

### Point your terminal at the folder

Your terminal needs to be "inside" the routerchat folder before the next step. If you used `git clone` above, you already are, so skip ahead.

**macOS:** right-click the `routerchat` folder in Finder and choose **New Terminal at Folder**. If you don't see that option, open Terminal, type `cd ` (with a space), then drag the folder into the window and press Enter.

**Windows:** open the `routerchat` folder in File Explorer, click the address bar at the top, type `powershell`, and press Enter.

To confirm it worked, run `ls` (macOS) or `dir` (Windows). You should see files like `requirements.txt` and `package.json`.

---

## Step 4: Set it up and start it

Copy these one line at a time. The first two commands make a private sandbox for RouterChat's Python parts so it doesn't mess with the rest of your computer.

**macOS:**

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
npm install
npm run build
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

**Windows:**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm install
npm run build
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

> **Windows: if `Activate.ps1` gets blocked** with a message about execution policies, run this once, then run the activate line again:
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```

After the last command, the terminal will look frozen and print something about "Uvicorn running". That means it worked. It is supposed to sit there.

Open your browser and go to:

```txt
http://127.0.0.1:8000
```

**Leave the terminal window open.** Closing it shuts RouterChat off.

---

## Step 5: Add your OpenRouter key

1. In RouterChat, click the **model name** next to the send button. That opens settings.
2. Go to the **API** page.
3. Paste your OpenRouter key and save.

RouterChat checks the key with OpenRouter before saving it to a file called `.env`. Keep that file private and never paste your key into screenshots, GitHub issues, or chats.

You're done. Type a message and press Enter.

---

## Starting it again tomorrow

You never have to redo the install. Open your terminal in the `routerchat` folder and run two lines.

**macOS:**

```sh
source .venv/bin/activate
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

**Windows:**

```powershell
.\.venv\Scripts\Activate.ps1
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Then open `http://127.0.0.1:8000` again.

If you updated the project with `git pull`, also run `npm install` and `npm run build` once before starting.

## Stopping it

Click the terminal window and press `Ctrl + C`. The page will stop loading, which is expected.

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

**"Directory 'dist' does not exist"**: you skipped the build step. Run `npm run build`, then start the server again.

**npm complains about "engines" or your Node version**: your Node is too old. Redo Step 2 with a newer installer, then close and reopen your terminal.

**"python is not recognized" / "command not found: python"**: Python either isn't installed or wasn't added to PATH. On Windows, reinstall it and check the **Add python.exe to PATH** box. On macOS, use `python3` instead of `python`.

**"Port 8000 is already in use"**: something else is using that door. Either restart your computer, or start RouterChat on a different port by changing `--port 8000` to `--port 8001` and opening `http://127.0.0.1:8001` instead.

**Models won't load**: your key is missing or invalid. Re-save it on the API settings page.

**Your chats vanished**: they live in `data/routerchat.sqlite3`. If that file is gone, they're gone. Copy it somewhere safe if your history matters to you.

**Everything is broken and you don't know why**: download [assistant.md](assistant.md), upload it to an AI, and paste in the exact error text.

---

## Where your stuff lives

Inside the `routerchat` folder:

- `.env`: your API key. Private.
- `data/routerchat.sqlite3`: every chat, message, and setting. **This is the one worth backing up.**
- `dist/`, `.venv/`, `node_modules/`: generated files. Safe to ignore; they rebuild themselves.

None of this is uploaded anywhere or committed to GitHub.

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
