# RouterChat Terms and Disclaimer

**Last updated: August 12, 2026**

RouterChat is self-hosted software distributed under the Apache License 2.0. In this document, "the Software" means RouterChat and the tools distributed with it, including the installer, updater, and uninstaller scripts published at `echo1097.github.io/get-routerchat`. "The author" means the maintainer or maintainers of the RouterChat project. The author does not operate a hosted RouterChat service, receive or process user data, or control deployments operated by third parties. Each person or organization deploying RouterChat is solely responsible for operating that deployment and establishing any terms, privacy notices, or policies applicable to its users.

This document is not the copyright license. The copyright license for RouterChat is the Apache License 2.0, and nothing here adds restrictions to the rights that license grants you in the source code. What follows is a separate agreement covering your use of the application the author distributes. Section 7 concerns trademarks, which the Apache License 2.0 expressly does not grant.

RouterChat asks you to accept these terms before the application will run. By accepting them there, you agree to them. By installing, running, modifying, or distributing the Software, you acknowledge that you have read and understand the following.

---

## 1. No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NONINFRINGEMENT. THE AUTHOR DOES NOT WARRANT THAT THE SOFTWARE WILL BE UNINTERRUPTED, SECURE, OR ERROR FREE, OR THAT ANY DEFECT WILL BE CORRECTED.

The installer and updater download and install third-party components, including a private Python runtime and the packages pinned in `requirements.lock`. Those components are the work of their respective authors, remain subject to their own licenses and warranty terms, and are not warranted by the author of RouterChat. The installer verifies what it downloads, but verification is not a guarantee of fitness, security, or availability. Third-party sources may change, move, or go offline at any time, and the author has no obligation to continue publishing the Software or to keep any installation URL available.

## 2. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE AUTHOR SHALL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF DATA, LOSS OF PROFITS, SERVICE INTERRUPTION, FINANCIAL CHARGES INCURRED WITH ANY THIRD PARTY PROVIDER, OR ACCOUNT SUSPENSION OR TERMINATION BY ANY THIRD PARTY, ARISING OUT OF OR RELATED TO THE SOFTWARE, WHETHER IN CONTRACT, TORT, STRICT LIABILITY, OR OTHERWISE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

Nothing in this section limits liability for fraud, for willful injury to the person or property of another, or for violation of law, whether willful or negligent. California Civil Code section 1668 makes such exemptions void, and California law governs this document. Liability for gross negligence is likewise not limited.

Other jurisdictions impose their own limits on the exclusion of warranties and on the limitation of liability, including for personal injury and for consumer claims. Where such law applies to you, the exclusions above take effect only to the fullest extent it permits.

## 3. What RouterChat Connects To

RouterChat runs on your computer. It contains no telemetry, no analytics, and no automatic update check. It does not send your prompts, chats, settings, or API key anywhere except to OpenRouter, as described below. The connections it makes are these and no others.

* **OpenRouter.** While you use RouterChat, the only connection carrying your prompts is to the OpenRouter API, to list models and to send the requests you initiate. Your prompts and their responses travel to OpenRouter and to whichever upstream provider serves the model you selected, and are handled under those parties' terms and privacy policies.
* **Flaticon's content delivery network.** The RouterChat interface loads its icon fonts from `cdn-uicons.flaticon.com` when the page opens. That request tells Flaticon and its network provider your IP address and browser details, the same as visiting any website would. It carries none of your prompts, chats, settings, or keys, and it happens whether or not you have entered an API key.
* **GitHub.** The installer and updater download the RouterChat package, the `uv` tool used to build the private environment, and the private Python runtime itself, all from GitHub releases. They also fetch the update script and its checksums from the RouterChat distribution site. This happens only when you run them. Separately, the first time you open RouterChat after it has been updated to a new version, the app automatically fetches that version's release notes from GitHub to show you the changelog.
* **Python package sources.** The installer downloads the third-party packages pinned in `requirements.lock` from the public Python package index, verifying each against the hashes in that file.

Updates are never automatic. RouterChat does not check for new versions on its own and does not contact the author or the project in the background, aside from the one-time changelog fetch described above. Nothing else is transmitted unless you start an action that requires it.

## 4. Your Responsibilities

You are solely responsible for:

* **Eligibility.** Being old enough where you live to enter into this agreement, and meeting any minimum age required by OpenRouter and by the providers you access through it.
* **Credentials.** Your API keys, tokens, and account security. RouterChat stores credentials locally on your device. The author never receives, transmits, or has access to them.
* **Local access.** RouterChat listens only on `127.0.0.1` and requires a one-time credential that the launcher supplies to your browser. If you change the bind address, forward the port, place it behind a proxy, or run it on a machine other people can reach, you are exposing your chats and your API key, and you are solely responsible for securing that deployment.
* **Costs and usage.** All charges, rate limits, quotas, outages, suspensions, and account actions imposed by OpenRouter or any other provider.
* **Provider compliance.** Reading and complying with the terms of service, acceptable use policies, and content policies of OpenRouter and every upstream model provider you access.
* **Content.** All prompts you submit and all output you receive, store, publish, or distribute, including any obligation to review output before relying on it.
* **Your data.** Local chat history, settings, and backups. The updater keeps recent backups so a failed update can be rolled back, and the uninstaller offers to save your database before removing anything. Both are conveniences offered on a best effort basis, not a backup or recovery service, and neither is guaranteed to succeed. Keep your own copy of `routerchat.sqlite3` before updating or uninstalling.
* **Your deployment.** Any modification, fork, redistribution, or deployment you make, and all consequences of it.

## 5. Model Output

RouterChat does not create model output. It sends your requests to providers you choose and displays what comes back. Output may be inaccurate, incomplete, offensive, or may resemble existing works, and it should not be relied on as professional advice of any kind. Verify anything that matters before acting on it.

Whatever rights exist in the output you generate are governed by your agreement with OpenRouter and the upstream provider, and by applicable law. The author grants no rights in model output, makes no claim to it, and cannot tell you whether any particular output is yours to use.

## 6. Acceptable Use

RouterChat is a self-hosted interface for accessing third-party model APIs. The following describes uses the author does not endorse or support. It does not modify or restrict the rights granted under the Apache License 2.0.

* Circumvent, disable, or evade safety systems, content filters, or usage restrictions of any model provider.
* Violate the terms of service or acceptable use policy of OpenRouter or any upstream provider.
* Generate content that is illegal in your jurisdiction or in the jurisdiction of the provider you are accessing.
* Impersonate, misrepresent affiliation, or evade an account suspension or ban.

RouterChat contains no feature designed or intended to bypass provider safeguards. Any such use is not endorsed or supported by the author or the project. It is undertaken solely by the person performing it and is not attributable to the author or the project.

## 7. Name, Branding, and Provider Attribution

The Apache License 2.0 grants no trademark rights. This section rests on trademark law, not on the copyright license, and it does not restrict your right to use, modify, or redistribute the code.

If you modify RouterChat, or distribute a modification or fork, you must remove or replace any identifier the software sends to a provider that uses the RouterChat name or branding, or that would represent your build as the official RouterChat, including application name and referrer headers. Do not present a modified build to any provider as RouterChat.

This applies equally to installers, launchers, shortcuts, and update tooling that you redistribute. Do not distribute a modified installer under the RouterChat name or from a location that suggests it is the official one.

## 8. Affiliation

RouterChat is an independent project. It is not affiliated with, endorsed by, sponsored by, or in any way officially connected to OpenRouter or any model provider accessible through it. All product names, trademarks, and registered trademarks are the property of their respective owners and are used for identification purposes only.

## 9. Indemnification

To the extent permitted by applicable law, you agree to indemnify and hold harmless the author from any claim, demand, loss, liability, or expense, including reasonable attorneys' fees, arising from your violation of applicable law, your violation of Section 6 or of any third party's terms of service, or your modification, deployment, or redistribution of RouterChat.

## 10. Severability

If any provision of this document is held unenforceable, that provision shall be modified to the minimum extent necessary to make it enforceable, or severed if it cannot be. The remaining provisions remain in full force and effect.

## 11. Governing Law

This document is governed by the laws of the State of California, United States, without regard to its conflict of law rules. Any dispute arising out of or relating to the Software or this document shall be brought exclusively in the state or federal courts located in California, United States, and you consent to the jurisdiction of those courts.

If you are a consumer residing outside the United States, this section does not deprive you of the protection of mandatory consumer laws of your country of residence, and nothing in this document waives rights that cannot be waived under the law that applies to you.

## 12. Changes

This document may be updated. Changes apply to the version of the software distributed with them, and the current version is the one in the RouterChat source repository and in the `app` folder of your installation. Because updates are user-initiated, a revised version reaches you only when you run the updater or reinstall.

RouterChat records your acceptance of each version and asks you to accept again whenever these terms change, so a revised version never takes effect for you without your agreement. If you do not accept the revised terms, stop using RouterChat and uninstall it.
