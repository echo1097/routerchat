# RouterChat Terms of Service

**Last updated: October 4, 2026**

RouterChat is self-hosted software distributed under the Apache License 2.0.

* **"The Software"** means RouterChat and the tools distributed with it, including the installer, updater, and uninstaller scripts published at `echo1097.github.io/get-routerchat`.
* **"The author"** means the maintainer or maintainers of the RouterChat project.

The author does not operate a hosted RouterChat service, receive or process user data, or control third-party deployments. Anyone who deploys RouterChat is solely responsible for that deployment and for any terms, privacy notices, or policies that apply to its users.

This is not the copyright license. Nothing here restricts the rights the Apache License 2.0 grants you in the source code. This is a separate agreement covering your use of the application the author distributes. Section 7 covers trademarks, which the Apache License 2.0 does not grant.

RouterChat asks you to accept these terms before it will run. By accepting them, you agree to them. By installing, running, modifying, or distributing the Software, you acknowledge that you have read and understand them.

---

## 1. No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NONINFRINGEMENT. THE AUTHOR DOES NOT WARRANT THAT THE SOFTWARE WILL BE UNINTERRUPTED, SECURE, OR ERROR FREE, OR THAT ANY DEFECT WILL BE CORRECTED.

The installer and updater download third-party components, including a private Python runtime and the packages pinned in `requirements.lock`. These belong to their respective authors, are subject to their own licenses and warranty terms, and are not warranted by the author of RouterChat. The installer verifies what it downloads, but verification is not a guarantee of fitness, security, or availability. Third-party sources may change or go offline at any time, and the author has no obligation to keep publishing the Software or to keep any installation URL available.

## 2. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE AUTHOR SHALL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF DATA, LOSS OF PROFITS, SERVICE INTERRUPTION, FINANCIAL CHARGES INCURRED WITH ANY THIRD PARTY PROVIDER, OR ACCOUNT SUSPENSION OR TERMINATION BY ANY THIRD PARTY, ARISING OUT OF OR RELATED TO THE SOFTWARE, WHETHER IN CONTRACT, TORT, STRICT LIABILITY, OR OTHERWISE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

Nothing in this section limits liability for fraud, for willful injury to the person or property of another, or for violation of law, whether willful or negligent. California Civil Code section 1668 makes such exemptions void, and California law governs this document. Liability for gross negligence is likewise not limited.

Other jurisdictions may limit the exclusion of warranties or the limitation of liability, including for personal injury and consumer claims. Where such law applies to you, the exclusions above apply only to the fullest extent it permits.

## 3. What RouterChat Connects To

RouterChat runs on your computer and contains no analytics or usage tracking. It sends your prompts, chats, settings, and API keys only to the provider you select, OpenRouter or Anthropic, as described below. Its other network connections are listed here. Links you open are governed by those websites' own terms and privacy policies.

**OpenRouter and Anthropic**

* RouterChat uses the API of the provider you select to validate your key, list models, send model requests, and retrieve usage information.
* Chat, writing, brainstorming, and lorebook features send the relevant prompts, history, story text, and lorebook context to that provider and, with OpenRouter, the upstream provider serving the model, under their terms and privacy policies.
* Automatic chat naming and optional automatic lorebook updates make additional model requests that can incur charges.
* Attached images and PDFs are sent with the relevant requests. Text and code attachments are included as text and may be truncated.
* **Web search** is available with OpenRouter only and is off unless you turn it on. While on, every message in that chat has OpenRouter run a web search first, sending your search terms to its search provider. Each search is charged in addition to tokens.

**Voice input (OpenRouter)**

* When you submit a microphone recording, RouterChat sends the audio to OpenRouter and the selected transcription provider.
* Transcription can incur charges even if you never send the resulting text as a prompt.
* Voice input is unavailable while Privacy mode or Zero Data Retention is on, because the transcription endpoint does not guarantee those routing settings.

**Update checks (GitHub)**

* **On by default.** When RouterChat starts, it asks `api.github.com` for the latest RouterChat release. If it is newer, a dot appears next to the version number in the sidebar.
* This reveals your IP address and browser details to GitHub, like visiting any website. It carries no prompts, chats, settings, API keys, or information about how you use RouterChat.
* Nothing is downloaded or installed as a result.
* Turn it off any time in Settings > Updates.

**Flaticon's content delivery network**

* The interface loads icon fonts from `cdn-uicons.flaticon.com` when it opens, whether or not you have entered an API key.
* This reveals your IP address and browser details to Flaticon and its network provider, like visiting any website. It carries no prompts, chats, settings, or keys.

**Website icons**

* When showing source links or citations, RouterChat may fetch those websites' icons, even with web search off or when reopening older content. This can take several requests, may follow redirects, and may reach an icon hosted on another domain.
* These requests reveal your IP address. They carry no browser cookies, referrer, prompts, chats, settings, or API keys, though cookies received during an icon fetch may be sent later within that same fetch.
* Results are cached locally for about thirty days. No third-party icon lookup service is used, and requests to local or private network addresses are refused.

**GitHub downloads and the changelog**

* When you run them, the installer and updater download the RouterChat package, the `uv` tool, and the private Python runtime from GitHub releases, and fetch release information, scripts, and checksums from the RouterChat distribution site.
* The changelog opens automatically the first time you use a version whose changelog has not been marked as seen. Whenever it opens, it fetches the latest release notes from GitHub, which may describe a newer version than yours.

**Python package sources**

* Installation and updates download the packages pinned in `requirements.lock` from the public Python package index, verifying each against that file's hashes.

**Updates are never installed automatically.** Some of the requests above happen automatically as part of using a feature, such as starting the app, displaying citations, naming a chat, or updating a lorebook.

## 4. Your Responsibilities

You are solely responsible for:

* **Eligibility.** Being old enough where you live to enter into this agreement, and meeting any minimum age required by OpenRouter, Anthropic, and the providers you access through them.
* **Credentials.** Your API keys, tokens, and account security. RouterChat stores credentials locally on your device. The author never receives, transmits, or has access to them.
* **Local access.** RouterChat listens only on `127.0.0.1` and requires a one-time credential that the launcher gives your browser. If you change the bind address, forward the port, put it behind a proxy, or run it on a machine others can reach, you are exposing your chats and API key, and you are solely responsible for securing that deployment.
* **Costs and usage.** All charges, rate limits, quotas, outages, suspensions, and account actions imposed by OpenRouter or any other provider, including for transcription, automatic chat naming, lorebook operations, and web search.
* **Provider compliance.** Reading and following the terms of service, acceptable use policies, and content policies of OpenRouter, Anthropic, and every upstream provider you use.
* **Content.** All prompts you submit and all output you receive, store, publish, or distribute, including reviewing output before relying on it.
* **Your data.** Your local chats, stories, lorebooks, settings, attachments, and backups.
  * Update backups include the database and local credentials. The uninstaller offers to save the database before removal. Neither includes the separate attachment files.
  * Both are best effort conveniences, not a backup or recovery service, and neither is guaranteed to succeed.
  * With RouterChat stopped, keep your own copy of `routerchat.sqlite3` and the `attachments` directory before updating or uninstalling. Keep any credential backup private.
* **Temporary chats.** Temporary chats and their attachments are stored locally while in use. RouterChat tries to delete them when you leave and cleans up leftovers when the backend starts. Temporary mode does not mean content never touches disk, and it does not change what is sent to OpenRouter or providers' retention policies.
* **Your deployment.** Any modification, fork, redistribution, or deployment you make, and all of its consequences.

## 5. Model Output

RouterChat does not create model output. It sends your requests to the providers you choose and displays the response. Output may be inaccurate, incomplete, offensive, or resemble existing works, and it is not professional advice. Verify anything that matters before acting on it.

Any rights in the output you generate are governed by your agreement with the provider you use and any upstream provider, and by applicable law. The author grants no rights in model output, makes no claim to it, and cannot tell you whether any particular output is yours to use.

## 6. Acceptable Use

RouterChat is a self-hosted interface for third-party model APIs. The author does not endorse or support using it to:

* Circumvent, disable, or evade safety systems, content filters, or usage restrictions of any model provider.
* Violate the terms of service or acceptable use policy of OpenRouter, Anthropic, or any upstream provider.
* Generate content that is illegal in your jurisdiction or in the jurisdiction of the provider you are accessing.
* Impersonate others, misrepresent affiliation, or evade an account suspension or ban.

This section does not restrict the rights granted under the Apache License 2.0. RouterChat has no feature designed to bypass provider safeguards. Any such use is undertaken solely by the person doing it and is not attributable to the author or the project.

## 7. Name, Branding, and Provider Attribution

The Apache License 2.0 grants no trademark rights. This section rests on trademark law, not the copyright license, and does not restrict your right to use, modify, or redistribute the code.

If you modify RouterChat, or distribute a modification or fork:

* Remove or replace any identifier the software sends to a provider that uses the RouterChat name or branding or that would represent your build as the official RouterChat, including application name and referrer headers.
* Do not present a modified build to any provider as RouterChat.
* If you distribute a modified build or make it available to others, including as a hosted service, give it its own name and branding. Do not offer it as RouterChat or in a way that suggests it is the official RouterChat or is endorsed by the author. Stating truthfully that it is based on RouterChat, and keeping the attribution notices the Apache License 2.0 requires, is fine.
* The same applies to installers, launchers, shortcuts, and update tooling you redistribute. Do not distribute a modified installer under the RouterChat name or from a location that suggests it is the official one.

## 8. Affiliation

RouterChat is an independent project. It is not affiliated with, endorsed by, sponsored by, or in any way officially connected to OpenRouter, Anthropic, or any model provider accessible through them. All product names, trademarks, and registered trademarks belong to their respective owners and are used for identification only.

## 9. Indemnification

To the extent permitted by applicable law, you agree to indemnify and hold harmless the author from any claim, demand, loss, liability, or expense, including reasonable attorneys' fees, arising from your violation of applicable law, your violation of Section 6 or of any third party's terms of service, or your modification, deployment, or redistribution of RouterChat.

## 10. Severability

If any provision of this document is held unenforceable, it will be modified to the minimum extent necessary to make it enforceable, or severed if it cannot be. The remaining provisions stay in full force and effect.

## 11. Governing Law

This document is governed by the laws of the State of California, United States, without regard to its conflict of law rules. Any dispute arising out of or relating to the Software or this document shall be brought exclusively in the state or federal courts located in California, United States, and you consent to the jurisdiction of those courts.

If you are a consumer living outside the United States, this section does not take away the protection of mandatory consumer laws of your country of residence, and nothing in this document waives rights that cannot be waived under the law that applies to you.

## 12. Changes

This document may be updated. Changes apply to the version of the software distributed with them. The current version is in the RouterChat source repository and in the `app` folder of your installation. A revised version reaches you only when you run the updater or reinstall. An update check may tell you a new version exists, but does not install it or its terms.

RouterChat records your acceptance of each version and asks you to accept again whenever these terms change, so a revised version never takes effect for you without your agreement.

If you do not accept these terms, stop using RouterChat and uninstall it.
