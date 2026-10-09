# RouterChat Terms of Service

**Last updated: October 8, 2026**

RouterChat is self-hosted software under the Apache License 2.0. "The Software" means RouterChat and its installer, updater, and uninstaller. "The author" means the project maintainer.

The author operates no hosted service, receives no user data, and controls no third-party deployment. These terms cover your use of the Software. They are separate from the Apache License 2.0 and do not restrict the rights it grants you.

RouterChat asks you to accept these terms before you use it. By accepting them, or by installing, running, modifying, or distributing the Software, you agree to them. If you do not agree, do not install RouterChat, or stop using it and uninstall it.

What RouterChat stores and sends over the network is described in the [privacy page](https://github.com/echo1097/routerchat/blob/main/docs/privacy.md). That page is for your information and is not part of these terms.

## 1. No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NONINFRINGEMENT. THE AUTHOR DOES NOT WARRANT THAT THE SOFTWARE WILL BE UNINTERRUPTED, SECURE, OR ERROR FREE.

Third-party components the installer downloads are covered by their own licenses and are not warranted by the author. The author has no obligation to keep publishing the Software or any installation URL, and no obligation to provide support, updates, or security fixes. Any support is volunteer and best effort.

## 2. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE AUTHOR IS NOT LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL DAMAGES ARISING FROM THE SOFTWARE, INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR PROFITS, SERVICE INTERRUPTION, CHARGES FROM ANY THIRD-PARTY PROVIDER, OR ACCOUNT SUSPENSION OR TERMINATION BY ANY THIRD PARTY, WHETHER IN CONTRACT, TORT, STRICT LIABILITY, OR OTHERWISE, EVEN IF ADVISED OF THE POSSIBILITY.

This does not limit liability for fraud, willful injury, violation of law, or gross negligence. Where your local law restricts these exclusions, they apply only as far as it allows.

## 3. What RouterChat Connects To

RouterChat runs on your computer with no analytics or tracking. Your prompts, chats, settings, and API keys go only to the provider you select, OpenRouter or Anthropic. With OpenRouter, your requests also reach the upstream provider serving the model you pick. Voice input and web search work with OpenRouter only, and they send your recording or search terms to OpenRouter and the provider it uses for that feature.

A few other connections carry none of your content:

* **GitHub**, to check for new releases.
* **Flaticon**, to load icons.
* **PyPI (the Python Package Index)**, when the installer or updater installs dependencies.
* **Websites linked as sources in responses**, to fetch their icons.

Some features send requests to your provider without you pressing send, such as automatic chat naming, automatic lorebook updates, web search, and voice input. These requests can cost money.

The privacy page describes every connection in this section in more detail, including which ones you can turn off.

## 4. Your Responsibilities

You are solely responsible for:

* **Eligibility.** Being old enough to agree to these terms and to use the providers you choose.
* **Credentials.** Your API keys and account security. Keys are stored locally and the author never has access to them.
* **Network exposure.** If you change RouterChat's bind address, forward its port, put it behind a proxy, or run it on a machine others can reach, you are exposing your chats and API keys, and you are solely responsible for securing that deployment.
* **Costs.** All charges, limits, and account actions from any provider.
* **Provider compliance.** Following the terms and policies of every provider you use.
* **Content.** Everything you submit and everything you do with the output.
* **Your data.** Your chats, stories, lorebooks, settings, and attachments. Backups made during updates and uninstalls are best effort, so keep your own copy.
* **Temporary chats.** They are stored on disk while in use and deleted on a best-effort basis. They do not change what is sent to providers or how long providers keep it.
* **Legal compliance.** Following the laws that apply to you, including export and sanctions laws.

## 5. Model Output

RouterChat does not create model output. Output may be inaccurate, offensive, or resemble existing works, and is not professional advice. Rights in output are governed by your provider's terms and applicable law. The author claims no rights in output and grants none.

## 6. Acceptable Use

The author does not endorse or support using RouterChat to:

* Circumvent, disable, or evade safety systems, content filters, or usage restrictions of any model provider.
* Violate the terms of service or acceptable use policy of OpenRouter, Anthropic, or any upstream provider.
* Generate illegal content.
* Impersonate others, misrepresent affiliation, or evade an account suspension or ban.

This section does not restrict the rights granted under the Apache License 2.0. RouterChat has no feature designed to bypass provider safeguards. Any such use is undertaken solely by the person doing it and is not attributable to the author or the project.

## 7. Name and Branding

The Apache License 2.0 grants no trademark rights. If you modify RouterChat or distribute a modified version, including as a hosted service or installer, you may not present it under the RouterChat name:

* Give it its own name and branding, and do not suggest it is official or endorsed by the author.
* Do not identify it to providers as RouterChat. Change the application name and referrer headers it sends.

You must still keep the attribution notices the Apache License 2.0 requires.

## 8. Affiliation

RouterChat is independent and is not affiliated with or endorsed by OpenRouter, Anthropic, or any model provider. All trademarks belong to their owners.

## 9. Indemnification

To the extent permitted by law, you agree to indemnify and hold harmless the author from any claim or expense, including reasonable attorneys' fees, arising from your violation of law or of any third party's terms, your use of RouterChat for anything listed in Section 6, or your modification, deployment, or redistribution of RouterChat.

## 10. Severability

If any provision is unenforceable, it is narrowed as little as needed or removed, and the rest stays in effect.

## 11. Governing Law

California law governs these terms, without regard to its conflict of law rules. To the extent permitted by law, disputes must be brought exclusively in the state or federal courts located in California, and you consent to the jurisdiction of those courts. If you are a consumer outside the United States, you keep the mandatory consumer protections of your country.

## 12. Changes

The terms that apply to you are the ones included with the copy of RouterChat you are running. These terms may change. A new version reaches you only when you install or update, and RouterChat asks you to accept again before it applies to you.
