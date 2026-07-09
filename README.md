# RouterChat v0.2.5
A 100% free local OpenRouter chat interface. Strictly BYOK. 

## Disclaimer

RouterChat is provided as-is. You are responsible for how you use it, including your use of third-party models, API keys, generated content, and any costs or consequences from that use. By using RouterChat you agree to abide by [the terms of service](TOS.md).

RouterChat is licensed under the [MIT License](LICENSE).

## AI usage disclaimer

AI was used to support development and documentation for this project. All code and documentation were reviewed by myself before being published. The primary use of AI durring development was debugging and refining the UI. 

## How to set up

Read [setup.md](setup.md)

For extra support, upload [assistant.md](assistant.md) to your favorite AI to turn it into a support bot to help you set up and troubleshoot!

## Features

- **Chat Mode** — A local chat interface model selection, context, temporary chats, and chat history.
- **Writing Mode** — A dedicated longform writing workspace. Create stories, organize them into chapters and make a lorebook for characters and world details.

## Roadmap
- UI improvements
    - Nav bar (DONE)
    - Folders/Projects
    - Warn when context getting full (DONE)
    - Show model context (DONE)
    - Temporary chats (DONE)
    - Generate chat names instead of just being first message 
    - Pin chats
- Writing Mode improvements
    - Brainstorming
    - Import/export 
    - Better chapter history
- Support for more providers (will take time and might not happen because of how deeply integrated OpenRouter is)
    - Gemini API
    - OpenAI API
    - Claude API
- Memory
    - Chat mode
    - Write mode (DONE)
- RAG 

## Bug reporting and contributing
- To report a bug open an issue and provide as much context and information as you can so I can reproduce and fix it. 
- AI slop pull requests will not be merged. If you are using AI to assist your development, clean up and review the code manually and be transparent in your usage of AI.

## Notes
- Chats and cached model metadata are stored in `data/routerchat.sqlite3`.

## Media
UI
<img width="1503" height="821" alt="Screenshot 2026-07-01 at 12 49 19 AM" src="https://github.com/user-attachments/assets/83fe456d-097b-4ab6-ac44-b54ebf68f142" />

Settings
<img width="597" height="434" alt="Screenshot 2026-07-01 at 12 49 30 AM" src="https://github.com/user-attachments/assets/557e1ba9-607b-4de6-8594-7a3940c94d30" />

Model picker
<img width="624" height="454" alt="Screenshot 2026-07-01 at 12 49 45 AM" src="https://github.com/user-attachments/assets/6d829113-3bbf-4ec9-b631-9a8c0c2eca46" />

Sample response
<img width="1512" height="828" alt="Screenshot 2026-07-01 at 12 50 45 AM" src="https://github.com/user-attachments/assets/028ce3c2-2c92-4a0a-801d-e395cce84870" />

