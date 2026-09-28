# Security Policy

RouterChat is a local, bring-your-own-key app maintained by one person. This policy covers the app plus the installers and updater in [get-routerchat](https://github.com/echo1097/get-routerchat).

## Reporting

Report issues ONLY through GitHub private vulnerability reporting: **[Report a vulnerability](https://github.com/echo1097/routerchat/security/advisories/new)**. Installer and updater issues can also go to [get-routerchat](https://github.com/echo1097/get-routerchat/security/advisories/new). Do not open a public issue or post details anywhere else.

Include the component, your version, your OS, and steps to reproduce. Only the [latest release](https://github.com/echo1097/routerchat/releases/latest) is supported, so update and confirm the problem first.

**Never share `user-data/.env` (your API key) or `user-data/routerchat.sqlite3` (your chats and stories).** Sanitize logs per [SUPPORT.md](SUPPORT.md). If your key may be exposed, revoke it at [openrouter.ai/keys](https://openrouter.ai/keys) first.

## What to expect

Reports are reviewed on a best effort basis, with no guaranteed response times, fixes, or release dates. Credit is given on request. Please allow a reasonable window before public disclosure.

## Scope

In scope:

- exposure of the API key or database
- anything off-machine reaching the local backend
- unintended code or command execution, or file access, through untrusted input
- third parties altering what the installers and updater run, including checksum bypass and rollback attacks

Releases are verified by SHA-256 checksum but not signed or notarized. A checksum proves a download is intact, not who published it, so checksum bypasses are in scope but the lack of signing is not.

Out of scope:

- OpenRouter or third-party model behavior and output
- issues that require arbitrary read or write access as the OS user running RouterChat
- the backend being reachable from your own machine
- scanner output with no proof of concept
- social engineering, physical access, and denial of service

## Safe harbor

I will not pursue action against good faith reporters who stay in scope, test only their own installation and API key, and do not access or destroy anyone else's data.
