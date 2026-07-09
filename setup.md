# RouterChat Setup

These instructions set up RouterChat on macOS or Windows.

## Fast Path

If you just want to run RouterChat, follow the section for your computer:

- [macOS Setup](#macos-setup)
- [Windows Setup](#windows-setup)

The earlier sections explain what Python, Node.js, npm, and the project folders are. Read them if any command looks confusing.

**If you need extra support or have questions not answered here, download [this file](assistant.md) and upload it to your favorite AI. It will give the AI the context it needs to act as a RouterChat setup support bot.**

Beginner note: run commands one line at a time unless they are shown as a full copy-paste block. If a command fails, stop there and fix that error before running the next command.

## Requirements

- Python 3.10 or newer
- Node.js `20.19.0` or newer, or Node.js `22.12.0` or newer
- npm
- An OpenRouter API key

The Node version matters because the installed Vite version requires modern Node. Use Node `20.19.0` or later in the 20.x release line, or Node `22.12.0` or later. If `npm install` or `npm run dev` complains about engines, update Node first.

## What These Things Are

If you have never set up a coding project before, there are three tools you need before RouterChat can run:

- Python runs the backend server.
- Node.js runs the frontend tooling.
- npm comes with Node.js and downloads the frontend packages listed in `package.json`.

You install Python and Node once on your computer. After that, each project can have its own local dependencies.

For Python, RouterChat uses a virtual environment named `.venv`. That keeps the Python packages for this project sandboxed from the rest of your system.

For Node, RouterChat uses `node_modules/`. That folder is created by `npm install` and contains the frontend packages.

## Install Python, Node, and npm on macOS

### Install Python on macOS

First check whether Python is already installed:

```sh
python3 --version
```

If it prints something like `Python 3.12.5`, you are good.

If the command is missing, install Python from the official installer:

1. Go to `https://www.python.org/downloads/`.
2. Download the latest stable Python 3 installer for macOS.
3. Open the downloaded `.pkg` file.
4. Follow the installer steps.
5. Close Terminal and open it again.
6. Run this again:

```sh
python3 --version
```

### Install Node and npm on macOS

Node includes npm, so you usually install both at the same time.

Check whether Node and npm are already installed:

```sh
node --version
npm --version
```

RouterChat needs Node `20.19.0` or later in the 20.x release line, or Node `22.12.0` or later.

The beginner friendly option is the prebuilt Node.js installer from the official site:

1. Go to `https://nodejs.org/en/download`.
2. Find the part that says `Or get a prebuilt Node.js for`.
3. Choose `macOS`.
4. Choose your architecture: `ARM64` for Apple Silicon, or `x64` for Intel.
5. Click `macOS Installer (.pkg)`.
6. Open the downloaded `.pkg` file.
7. Follow the installer steps.
8. Close Terminal and open it again.
9. Check the versions:

```sh
node --version
npm --version
```

To check whether your Mac is `ARM64` or `x64`, run this in Terminal:

```sh
uname -m
```

Use this result:

- `arm64` means Apple Silicon, so pick `ARM64`.
- `x86_64` means Intel, so pick `x64`.

You can also check through the Mac UI:

1. Click the Apple menu in the top-left corner.
2. Click `About This Mac`.
3. Look at the chip or processor line.
4. If it says `Apple M1`, `Apple M2`, `Apple M3`, or newer, pick `ARM64`.
5. If it says `Intel`, pick `x64`.

If you already know what `nvm` is, that is also fine:

```sh
nvm install 22
nvm use 22
node --version
npm --version
```

You do not need `nvm` if the official installer worked.

## Install Python, Node, and npm on Windows

### Install Python on Windows

First check whether Python is already installed. Open PowerShell and run:

```powershell
python --version
```

If it prints something like `Python 3.12.5`, you are good.

If the command is missing, install Python:

1. Go to `https://www.python.org/downloads/`.
2. Download the latest stable Python 3 installer for Windows.
3. Run the installer.
4. On the first installer screen, check `Add python.exe to PATH`.
5. Click `Install Now`.
6. Close PowerShell and open it again.
7. Run this again:

```powershell
python --version
```

If `python --version` works, you are ready to create the virtual environment.

### Install Node and npm on Windows

Node includes npm, so installing Node should also install npm.

Check whether Node and npm are already installed:

```powershell
node --version
npm --version
```

RouterChat needs Node `20.19.0` or later in the 20.x release line, or Node `22.12.0` or later.

The beginner friendly option is the official installer:

1. Go to `https://nodejs.org/`.
2. Download the current LTS installer for Windows.
3. Run the installer.
4. Keep the default options unless you know you need something different.
5. Close PowerShell and open it again.
6. Check the versions:

```powershell
node --version
npm --version
```

If those commands work, npm is installed.

## Get the Project Folder

You need the RouterChat folder on your computer before running the setup commands.

The recommended way to get RouterChat is with Git. Git makes future updates much easier because you can update the project with `git pull` instead of downloading a fresh copy.

Clone the project and move into the folder:

```sh
git clone https://github.com/echo1097/routerchat.git
cd routerchat
```

If you do not want to use Git, you can still download the project as a .zip file. Click the green `Code` button on the Github page, then choose `Download ZIP`.

If you downloaded the project as a zip, unzip it somewhere easy to find, then open Terminal or PowerShell inside that folder. ZIP installs work, but updates are more manual.

## macOS Setup

Open Terminal in the project folder.

Easy option:

1. Open Finder.
2. Find the `routerchat` folder.
3. Right-click the folder.
4. Click `New Terminal at Folder`.

If you do not see `New Terminal at Folder`, open Terminal normally and type `cd ` with a space after it. Then drag the `routerchat` folder into the Terminal window and press Enter.

It should look something like this:

```sh
cd /path/to/routerchat
```

Create and activate a Python virtual environment:

```sh
python3 -m venv .venv
source .venv/bin/activate
```

Upgrade pip and install Python dependencies:

```sh
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
```

Install frontend dependencies:

```sh
npm install
```

Build the frontend:

```sh
npm run build
```

Start the app:

```sh
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`.

Keep the Terminal window open while using RouterChat. If you close it, the local server stops.

## Windows Setup

Open PowerShell in the project folder.

Easy option:

1. Open the `routerchat` folder in File Explorer.
2. Click the address bar at the top of the window.
3. Type `powershell`.
4. Press Enter.

That opens PowerShell already pointed at the project folder.

You can also open PowerShell normally and use `cd`:

```powershell
cd C:\path\to\routerchat
```

Create and activate a Python virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks activation, allow scripts for your current user and try again:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\.venv\Scripts\Activate.ps1
```

Upgrade pip and install Python dependencies:

```powershell
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Install frontend dependencies:

```powershell
npm install
```

Build the frontend:

```powershell
npm run build
```

Start the app:

```powershell
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`.

Keep the PowerShell window open while using RouterChat. If you close it, the local server stops.

## Add Your OpenRouter Key

The easiest path is through the app:

1. Open RouterChat.
2. Open settings by clicking the model name next to the send button in the prompt bar.
3. Go to the API page.
4. Paste your OpenRouter API key.
5. Save it.

RouterChat validates the key with OpenRouter before writing it to `.env` as `OPENROUTER_API_KEY`.

You can also create `.env` yourself:

```env
OPENROUTER_API_KEY=your_key_here
```

Keep `.env` private. It is ignored by git.

## Using the UI

Once RouterChat is open in your browser, the main things are:

- Type your message in the prompt box at the bottom.
- Press Enter to send.
- Press Shift + Enter to make a new line without sending.
- Click the round send button to send, or click it while a response is running to stop the response.
- Click `New chat` in the left sidebar to start a fresh conversation.
- Click an old chat in the left sidebar to reopen it.

The model name in the prompt bar is also a button. Click the model name to open settings.

Settings has these pages:

- `API`: paste and save your OpenRouter key, hide free models, and turn on Turbo.
- `Models`: search models, select a model, and set the selected model as the default.
- `System`: add a system prompt that gets sent before your messages.
- `UI`: turn smooth text on or off.
- `Chats`: export or import chats as JSON files.
- `Advanced`: change reasoning effort, temperature, and max output tokens.

If a chat already has messages, the model may show as `locked`. That means the chat is locked to the model it started with. Start a new chat if you want to use a different model.

Some buttons only show when you hover over a chat or message:

- Hover over a chat in the sidebar to rename or delete it.
- Hover over your prompt to edit or delete it.
- Hover over an assistant response to copy it, regenerate it, or view response details.

## Normal Local Run

After dependencies are installed, macOS users can run:

```sh
npm run build
source .venv/bin/activate
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

For future runs on macOS, you do not need to reinstall everything. Open Terminal in the `routerchat` folder, activate the virtual environment, and run the server again:

```sh
source .venv/bin/activate
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

On Windows, run:

```powershell
npm run build
.\.venv\Scripts\Activate.ps1
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

For future runs on Windows, you also do not need to reinstall everything. Open PowerShell in the `routerchat` folder, activate the virtual environment, and run the server again:

```powershell
.\.venv\Scripts\Activate.ps1
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Then open `http://127.0.0.1:8000`.

Keep the Terminal or PowerShell window open while using RouterChat. If you close it, the local server stops.

## Stop the App

To stop RouterChat, go back to the Terminal or PowerShell window where the server is running and press:

```txt
Ctrl + C
```

For normal local run, this stops the FastAPI/Uvicorn server. After it stops, `http://127.0.0.1:8000` will stop loading, which is expected.

For development mode, you may have two running terminals:

- Press `Ctrl + C` in the backend terminal running `python3 -m uvicorn ...` on macOS or `python -m uvicorn ...` on Windows.
- Press `Ctrl + C` in the frontend terminal running `npm run dev`.

If you closed the terminal window without stopping the app and the port is still busy, restarting your computer is the beginner friendly fix. If you are comfortable with terminal commands, you can also find and stop the process using the port.

## Project Data

RouterChat writes local runtime files:

- `.env` for the OpenRouter API key
- `data/routerchat.sqlite3` for chats, messages, model cache, usage metadata, and app settings
- `dist/` for the built frontend
- `.venv/` for Python packages
- `node_modules/` for Node packages

These are ignored by git.

## Best Practices

- Use the `.venv` virtual environment instead of installing Python packages globally.
- Keep `.env` out of git and dont paste API keys into issues, commits, or screenshots.
- Use `npm install` with the checked-in `package-lock.json` so dependency versions stay consistent.
- Run `npm run build` before using the single-server FastAPI app.
- Back up `data/routerchat.sqlite3` if you care about keeping local chat history.

## Troubleshooting

### `Directory 'dist' does not exist`

Run:

```sh
npm run build
```

Then start Uvicorn again.

### `npm` complains about Node engines

Update Node to `20.19.0` or later in the 20.x release line, or use Node `22.12.0` or later.

On macOS, `nvm` is a clean way to manage Node versions:

```sh
nvm install 22
nvm use 22
```

On Windows, use the official Node installer or `nvm-windows`, then reopen PowerShell.

### Python command is not found

On macOS, try:

```sh
python3 --version
```

On Windows, try:

```powershell
python --version
```

Install Python from `https://www.python.org/downloads/` if the command for your operating system does not work.

### Port 8000 is already in use

Stop the other process, or run the backend on another port:

```sh
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8001
```

On Windows:

```powershell
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8001
```

For development with Vite, keep the backend on `8000` unless you also update `vite.config.js`.

### Models do not load

Check that your OpenRouter key is saved and valid. You can save it again from the API settings page. If OpenRouter is temporarily unavailable, RouterChat can still show cached model metadata if it has been fetched before.

### Chats disappeared

Check whether `data/routerchat.sqlite3` still exists. The chat history is local to that file.


## (OPTIONAL) Development Mode

Development uses two servers:

- FastAPI backend: `http://127.0.0.1:8000`
- Vite frontend: `http://127.0.0.1:5173`

On macOS, open Terminal 1 and run:

```sh
source .venv/bin/activate
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

On Windows, open PowerShell 1 and run:

```powershell
.\.venv\Scripts\Activate.ps1
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

In Terminal 2 on macOS or PowerShell 2 on Windows, run:

```sh
npm run dev
```

Open `http://127.0.0.1:5173`.

The Vite dev server proxies `/api` to the backend. The backend still mounts `dist/`, so run `npm run build` at least once before starting it.
