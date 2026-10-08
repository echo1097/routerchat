<div align="center">

<img width="120" alt="RouterChat logo" src="media/icon.png" />

# RouterChat

**A free, local interface for chatting and longform writing.**

Bring your own key. Available for macOS and Windows.

<p>
  <a href="#install-routerchat">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#media">Screenshots</a> ·
  <a href="docs/setup.md">Setup guide</a> ·
  <a href="docs/privacy.md">Privacy</a> ·
  <a href="https://github.com/echo1097/routerchat/releases">Releases</a> ·
  <a href="SUPPORT.md">Support</a>
</p>

<img width="1000" alt="RouterChat landing page" src="media/landing%20page.png" />

</div>

## Disclaimer

By using RouterChat you agree to the [terms of service](TOS.md).

RouterChat is licensed under the [Apache License 2.0](LICENSE) as of August 3, 2026.<br>
<small>Releases up to and including 0.3.5 remain available under the MIT License.</small>


## Install RouterChat

You will need an [OpenRouter API key](https://openrouter.ai/keys) or an [Anthropic API key](https://platform.claude.com/settings/keys). 

---

**macOS (Apple Silicon or Intel)** ([inspect installer](https://github.com/echo1097/get-routerchat/blob/main/install.sh))

```sh
curl -fsSL https://echo1097.github.io/get-routerchat/install.sh | sh
```

**Windows x64** ([inspect installer](https://github.com/echo1097/get-routerchat/blob/main/install.ps1))

```powershell
irm https://echo1097.github.io/get-routerchat/install.ps1 | iex
```

---

- **Setup:** The [setup guide](docs/setup.md) covers starting, updating, repairing, and data locations. The [developer guide](docs/developer.md) covers building from source.
- **Help:** See [SUPPORT.md](SUPPORT.md) 
- **Uninstall:** On macOS, double-click `Uninstall RouterChat.command` in the **RouterChat** folder on your Desktop. On Windows, open **Uninstall RouterChat** from the Start Menu. It can save your database to Downloads before removing the app.

> [!WARNING]
> Tested on macOS Apple Silicon and on Windows 11. macOS Intel has not been tested yet.

## Features

- **Chat Mode:** Chat with any OpenRouter or Anthropic model, with file attachments, temporary chats, and chat history. Web search is available with OpenRouter.
- **Writing Mode:** A longform writing workspace. Write stories in chapters, brainstorm ideas, and keep a lorebook of characters and world details.

## Roadmap

The top priority right now is support for more API providers. Anthropic is added, and these are next:

- **OpenAI:** Use OAI models with your OpenAI key.
- **Local models:** Use models on your own computer through apps like Ollama and LM Studio.

## Features added

See [features.md](docs/features.md) for the full list of what has been added so far.

## AI usage disclaimer

AI helped with development and documentation for this project. I reviewed all code and documentation before publishing it.

## Bug reporting, feedback, and contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report bugs, send feedback, and open pull requests.

## Local data

Your chats, settings, and API keys stay on your computer, and the project author never receives them. Packaged installs keep your keys and database outside the app folder, so updates don't replace them. Git clone installs keep using `.env` and `data/routerchat.sqlite3` inside the repository.

When you send a prompt or attachment, that data goes to the provider you picked, OpenRouter or Anthropic, so it can handle the request. Voice recordings always go to OpenRouter. See [TOS.md](TOS.md) for the full list of connections.

## Media

> All screenshots below use mocked data.

Chat Mode

<img width="1000" alt="RouterChat Chat Mode" src="media/chatmode.png" />

Usage

<img width="1000" alt="RouterChat usage panel" src="media/usage.png" />

Lorebook entry

<img width="1000" alt="RouterChat lorebook entry" src="media/lorebook%20entry.png" />

Write Mode

<img width="1000" alt="RouterChat Write Mode" src="media/write%20mode.png" />
