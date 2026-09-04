# Security Policy

RouterChat is a local, bring-your-own-key app maintained by one person. This policy covers the app, the installers, and the updater in [get-routerchat](https://github.com/echo1097/get-routerchat).

## Reporting

Report security issues ONLY through GitHub private vulnerability reporting:

**[Report a vulnerability](https://github.com/echo1097/routerchat/security/advisories/new)**

Installer and updater issues can be reported here or in [get-routerchat](https://github.com/echo1097/get-routerchat/security/advisories/new). Private reporting is the only accepted channel, so do not open a public issue or post details anywhere else.

Include the affected component, your version, your OS, and steps to reproduce. Only the [latest release](https://github.com/echo1097/routerchat/releases/latest) is supported, so update first and confirm the problem is still there.

**Never paste `user-data/.env` (your API key) or `user-data/routerchat.sqlite3` (your chats and stories).** Sanitize logs before sharing; see [SUPPORT.md](SUPPORT.md). If your key may be exposed, revoke it at [openrouter.ai/keys](https://openrouter.ai/keys) first.

## What to expect

One maintainer, so best effort: acknowledgement within 7 days, triage within 14, a fix in the next release, and credit if you want it. Please allow a reasonable window before disclosing publicly.

## Scope

In scope: anything that exposes the API key or database, lets something off-machine reach the local backend, causes unintended code execution, command execution, or file access through untrusted input, or lets a third party alter what the installers and updater run, including checksum bypass and rollback attacks.

Releases are verified by SHA-256 checksum but are not signed or notarized. A checksum proves a download arrived intact, not who published it. Checksum bypasses are in scope; the absence of signing is not.

Out of scope: OpenRouter and third-party model behavior or output; issues that require an attacker to already have arbitrary read or write access as the OS user running RouterChat; the backend being reachable from your own machine; scanner output with no proof of concept; social engineering, physical access, and denial of service.

## Safe harbor

I will not pursue action against anyone reporting in good faith who stays in scope, tests only their own installation and their own API key, and does not access or destroy anyone else's data.
