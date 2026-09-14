# RouterChat Support

## Maintenance and support

RouterChat is in maintenance mode. New feature development is paused. Future updates are limited to critical bug fixes, security fixes, dependency compatibility, and release infrastructure issues.

Start with the [setup guide](setup.md). For guided troubleshooting, you can optionally use the [support assistant prompt](assistant.md) with an AI assistant.

Issue reports are still welcome, but responses and fixes are not guaranteed.

## Installation problems

Before reporting an installation problem, rerun the original installer command. It repairs the application and private runtime without replacing `user-data`.

## Find the logs

- **macOS:** `~/Library/Application Support/RouterChat/logs/`
- **Windows:** `%LOCALAPPDATA%\RouterChat\logs\`

Logs are designed not to contain the OpenRouter API key. Still, read a log before sharing it and remove anything personal from error messages.

Never share either of these files:

- `user-data/.env`
- `user-data/routerchat.sqlite3`

The first contains the API key. The second contains chats, stories, settings, and history.

## Find the installed version

Open `app/version.json` or `install.json` inside the RouterChat installation folder and report only the version number, platform, and the exact error message. Do not paste the full contents of private data files.

Installation folders:

- **macOS:** `~/Library/Application Support/RouterChat/`
- **Windows:** `%LOCALAPPDATA%\RouterChat\`

When opening a GitHub issue, include the operating system, processor type, installed version, what you were doing, sanitized log excerpt, and steps that reproduce the problem.
