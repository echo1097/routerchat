# RouterChat Support

## Getting help

- **Guides:** the [setup guide](docs/setup.md) for the one-click install, or the [developer guide](docs/developer.md) if you run from source.
- **AI help:** paste the [support assistant prompt](docs/assistant.md) into any AI assistant for step by step troubleshooting.
- **Feedback:** use the **Feedback** button at the bottom of the sidebar, or [this form](https://forms.gle/gTth2TcXLYAArvGm6).
- **Bugs:** [open a GitHub issue](https://github.com/echo1097/routerchat/issues).
- **Security issues:** never report them publicly. Follow [SECURITY.md](SECURITY.md).

## Before reporting

1. Update to the [latest release](https://github.com/echo1097/routerchat/releases/latest). Only the latest release is supported.
2. For install or startup problems, rerun the install command. It repairs the app and its private runtime without touching `user-data`.

## Your RouterChat folder

- **macOS:** `~/Library/Application Support/RouterChat/`
- **Windows:** `%LOCALAPPDATA%\RouterChat\`

[docs/setup.md](docs/setup.md#3-where-your-files-live) explains how to open it.

**Logs** are in the `logs` folder. They are designed not to contain your API key, but read them before sharing and remove anything personal. Developer installs have no log files, so copy the error from the terminal instead.

**Your version** is in `app/version.json` (`version`) or `install.json` (`installedVersion`). Developer installs use `version.json` in the project folder. Share only the version number.

## Never share

| File | Contains |
| --- | --- |
| `user-data/.env` (or `.env` in a developer install) | Your OpenRouter and Anthropic API keys |
| `user-data/routerchat.sqlite3` (or `data/routerchat.sqlite3`) | Your chats, stories, settings, and history |
| `user-data/usage.sqlite3` (or `data/usage.sqlite3`) | Your usage history: models, token counts, and costs |

If a key may have leaked, revoke it at [openrouter.ai/keys](https://openrouter.ai/keys) for OpenRouter or [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys) for Anthropic.

## What to include in an issue

- Operating system and processor (for example, macOS Apple Silicon or Windows 11 x64)
- One-click install or developer install
- RouterChat version
- Which provider you were using (OpenRouter or Anthropic) and the model
- What you were doing and the steps to reproduce it
- The exact error message and a sanitized log excerpt
