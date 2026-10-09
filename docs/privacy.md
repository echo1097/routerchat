# Privacy and Network Connections

This page describes what RouterChat stores on your computer and what it sends over the network. It is here to inform you and is not part of the [terms of service](../TOS.md). If it ever disagrees with what the app actually does, that is a documentation bug, so please report it.

## TLDR

* RouterChat runs on your computer. The author runs no server, has no account system, and never receives your chats, settings, or API keys.
* RouterChat contains no analytics and no usage tracking.
* Your prompts, chats, and API key are sent only to the provider you select, OpenRouter or Anthropic.
* A few other connections happen so the app can load icons and check for updates. They carry none of your content.

## What stays on your computer

* Your chats, stories, lorebooks, settings, and attachments.
* Your API keys. They are stored locally and are sent only to the provider they belong to.
* A local cache of website icons.

Temporary chats and their attachments are also stored on disk while you use them. RouterChat tries to delete them when you leave and cleans up leftovers the next time it starts. Temporary mode does not change what is sent to your provider or how long the provider keeps it.

## What is sent to your provider

RouterChat uses the API of the provider you select to check your key, list models, send your requests, and look up usage.

* **Chat, writing, brainstorming, and lorebook features** send the relevant prompts, history, story text, and lorebook context. With OpenRouter, this also reaches the upstream provider serving the model you picked.
* **Attachments.** Images and PDFs are sent with the request. Text and code attachments are included as text and may be shortened.
* **Automatic chat naming and automatic lorebook updates** make extra requests on their own. These can cost money.
* **Web search** works with OpenRouter only and is off until you turn it on. While it is on, every message in that chat runs a web search first, which sends your search terms to OpenRouter's search provider. Each search is charged on top of tokens.
* **Voice input** works with OpenRouter only. Your recording is sent to OpenRouter and the transcription provider, and it can be charged even if you never send the resulting text. Voice input is unavailable while Privacy mode or Zero Data Retention is on.

What your provider does with this data is covered by its own terms and privacy policy.

## Other connections

These connections reveal your IP address and basic browser details, the same way visiting any website does. They do not carry your prompts, chats, settings, or API keys.

### Update checks (GitHub)

* On by default. When RouterChat starts, it asks `api.github.com` for the latest release. If a newer one exists, a dot appears next to the version number in the sidebar.
* Nothing is downloaded or installed as a result.
* You can turn this off in Settings > Updates.

### Changelog (GitHub)

* The changelog opens on its own the first time you use a new version. Whenever it opens, it fetches the latest release notes from GitHub.

### Icon fonts (Flaticon)

* The interface loads its icon fonts from `cdn-uicons.flaticon.com` every time it opens, even before you enter an API key.

### Website icons

* When RouterChat shows source links or citations, it may fetch the small icon for each website. This can happen with web search off, for example when you reopen an older chat.
* A fetch can take a few requests, may follow redirects, and may end up at an icon hosted on a different domain.
* These requests do not include your browser cookies or a referrer.
* Icons are cached on your computer for about thirty days. RouterChat fetches them directly and uses no third-party icon lookup service. It refuses requests to local or private network addresses.

### Installing and updating

* When you run the installer or updater, it downloads RouterChat, its checksum, release information, the `uv` tool, and a private Python runtime from GitHub. The installer and updater scripts and their checksums come from the RouterChat distribution site.
* It downloads the Python packages RouterChat needs from the public Python package index and checks each one against a known hash.
* Updates are never installed automatically. They only happen when you run the updater.

## Local access

RouterChat listens only on `127.0.0.1`, which means only your own computer can reach it, and it requires a credential that the launcher hands to your browser.

If you change the address it listens on, forward the port, put it behind a proxy, or run it on a machine other people can reach, your chats and API key become reachable by them. Securing that kind of setup is up to you.

## Links you open

Links you click inside RouterChat open the website they point to. Those websites have their own terms and privacy policies.
