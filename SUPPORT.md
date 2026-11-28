# RouterChat Support

> [!NOTE]
> RouterChat is no longer actively maintained or supported. Bug reports, feature requests, and feedback are not monitored. Existing releases and installers remain available as-is.

## Self-help

- **Guides:** the [setup guide](docs/setup.md) for the one-click install, or the [developer guide](docs/developer.md) if you run from source.
- **Repair:** for install or startup problems, rerun the install command. It repairs the app and its private runtime without touching `user-data`.
- **Releases:** the final release is available on the [releases page](https://github.com/echo1097/routerchat/releases/latest).

## Your RouterChat folder

- **macOS:** `~/Library/Application Support/RouterChat/`
- **Windows:** `%LOCALAPPDATA%\RouterChat\`

[docs/setup.md](docs/setup.md#3-where-your-files-live) explains how to open it.

**Logs** are in the `logs` folder. They are designed not to contain your API key, but read them before sharing anywhere and remove anything personal. Developer installs have no log files, so check the terminal output instead.

**Your version** is in `app/version.json` (`version`) or `install.json` (`installedVersion`). Developer installs use `version.json` in the project folder.

## Never share

| File | Contains |
| --- | --- |
| `user-data/.env` (or `.env` in a developer install) | Your OpenRouter and Anthropic API keys |
| `user-data/routerchat.sqlite3` (or `data/routerchat.sqlite3`) | Your chats, stories, settings, and history |
| `user-data/usage.sqlite3` (or `data/usage.sqlite3`) | Your usage history: models, token counts, and costs |

If a key may have leaked, revoke it at [openrouter.ai/keys](https://openrouter.ai/keys) for OpenRouter or [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys) for Anthropic.
