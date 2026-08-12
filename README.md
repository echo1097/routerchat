# RouterChat 1.0.1
A 100% free local OpenRouter chat interface. Strictly BYOK. 

> [!IMPORTANT]
> As of August 3, 2026, RouterChat is distributed under the [Apache License 2.0](LICENSE). Releases up to and including 0.3.5 remain available under the MIT License.

## Disclaimer

RouterChat is provided as-is. You are responsible for how you use it, including your use of third-party models, API keys, generated content, and any costs or consequences from that use. By using RouterChat you agree to abide by [the terms of service](TOS.md).

RouterChat is licensed under the [Apache License 2.0](LICENSE).

## Install RouterChat

RouterChat runs locally and only needs an [OpenRouter API key](https://openrouter.ai/keys). The installer keeps its Python runtime private, so you do not need to install Python, Node.js, npm, or Git.

You can inspect the open-source [macOS installer](https://github.com/echo1097/get-routerchat/blob/main/install.sh) or [Windows installer](https://github.com/echo1097/get-routerchat/blob/main/install.ps1) before running it.

**macOS (Apple Silicon or Intel):**

```sh
curl -fsSL https://echo1097.github.io/get-routerchat/install.sh | sh
```

**Windows x64:**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://echo1097.github.io/get-routerchat/install.ps1 | iex"
```

See the [setup guide](setup.md) for starting, updating, repairing, data locations, and manual developer installation. For support, see [SUPPORT.md](SUPPORT.md).

> [!WARNING]
> Tested locally on macOS Apple Silicon and on Windows 11 x64 using a sandbox VM. macOS Intel has not yet been tested.

## Features

- **Chat Mode** — A local chat interface model selection, context, temporary chats, and chat history.
- **Writing Mode** — A dedicated longform writing workspace. Create stories, organize them into chapters and make a lorebook for characters and world details.

## Roadmap
- UI improvements
    - Nav bar (DONE)
    - Folders/Projects
    - Warn when context getting full (DONE)
    - Show model context (DONE)
    - Temporary chats (DONE)
    - Generate chat names instead of just being first message 
    - Pin chats (DONE)
- Writing Mode improvements
    - Brainstorming (DONE)
    - Import/export 
    - Better chapter history (DONE)
- Memory
    - Chat mode
    - Write mode (DONE)

## AI usage disclaimer

AI was used to support development and documentation for this project. All code and documentation were reviewed by myself before being published.

## Bug reporting and contributing
- To report a bug open an issue and provide as much context and information as you can so I can reproduce and fix it. 
- AI slop pull requests will not be merged. If you are using AI to assist your development, clean up and review the code manually and be transparent in your usage of AI.

## Local data

Packaged installations keep the OpenRouter key and database outside the replaceable application directory. Git clone installations continue to use `.env` and `data/routerchat.sqlite3` inside the repository. RouterChat does not upload your chats or key anywhere.

## Media
UI
<img width="1501" height="805" alt="Screenshot 2026-07-09 at 7 09 51 PM" src="https://github.com/user-attachments/assets/2efc0365-3a73-49ae-beaa-d7255348eb91" />

Settings

<img width="597" height="434" alt="Screenshot 2026-07-01 at 12 49 30 AM" src="https://github.com/user-attachments/assets/557e1ba9-607b-4de6-8594-7a3940c94d30" />

Model picker

<img width="624" height="454" alt="Screenshot 2026-07-01 at 12 49 45 AM" src="https://github.com/user-attachments/assets/6d829113-3bbf-4ec9-b631-9a8c0c2eca46" />

Sample response
<img width="1472" height="804" alt="Screenshot 2026-07-09 at 7 19 10 PM" src="https://github.com/user-attachments/assets/5627cc93-9054-4dfc-8397-c30c52ff12c0" />
