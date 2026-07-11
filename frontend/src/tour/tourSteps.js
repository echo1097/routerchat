

export const CHAT_TOUR_STEPS = [
  {
    id: "model",
    selector: '[data-tour="model-button"]',
    body: "This displays the currently selected model and when clicked opens the settings.",
  },
  {
    id: "thinking",
    selector: '[data-tour="thinking-button"]',
    body: "If the selected model supports thinking use this to toggle it on or off.",
    forceThinkingVisible: true,
  },
  {
    id: "tempChat",
    selector: '[data-tour="temp-chat-button"]',
    body: "Click this to start a temporary chat that will disappear after you close it out.",
  },
  {
    id: "collapseSidebar",
    selector: '[data-tour="collapse-sidebar-button"]',
    body: "Use this to collapse the sidebar.",
    desktopOnly: true,
  },
  {
    id: "chatActions",
    selector: '[data-tour="chat-actions-button"]',
    body: "Opens chat actions menu such as delete or export.",
    needsSampleChat: true,
  },
  {
    id: "send",
    selector: '[data-tour="send-button"]',
    body: "Click this button to send your prompt to the model.",
  },
];

export const WRITE_TOUR_STEPS = [
  {
    id: "storyRail",
    selector: '[data-tour="write-story-rail"]',
    body: "Your stories live here.",
  },
  {
    id: "storyHome",
    selector: '[data-tour="write-home-button"]',
    body: "Home returns you to the landing page, where you can start or continue a story.",
  },
  {
    id: "newChapter",
    selector: '[data-tour="write-new-chapter-button"]',
    body: "Add a chapter to the current story.",
  },
  {
    id: "chapterCanvas",
    selector: '[data-tour="write-chapter-canvas"]',
    body: "This is the chapter canvas. You can write here. You can ask the model to write/make changes.",
    workspaceView: "chapter",
  },
  {
    id: "writingTools",
    selector: '[data-tour="write-tools-button"]',
    body: "Writing tools opens controls for things like switching to brainstorming and viewing history.",
    workspaceView: "chapter",
    composerUi: "tools",
  },
  {
    id: "lorebook",
    selector: '[data-tour="write-lorebook"]',
    body: "The Lorebook keeps characters, locations, items, events, notes, summaries, and the timeline updated to help with story continuity.",
    workspaceView: "lorebook",
  },
  {
    id: "brainstorm",
    selector: '[data-tour="write-brainstorm"]',
    body: "Brainstorm new ideas for the story here.",
    workspaceView: "brainstorm",
  },
  {
    id: "systemPrompt",
    selector: '[data-tour="write-system-prompt"]',
    body: "The story system prompt has writing instructions used for every interaction in each stories workspace.",
    workspaceView: "chapter",
    composerUi: "systemPrompt",
  },
  {
    id: "history",
    selector: '[data-tour="write-history"]',
    body: "History records prompts and actions taken by the model.",
    workspaceView: "chapter",
    composerUi: "history",
  },
  {
    id: "generationMode",
    selector: '[data-tour="write-generation-mode"]',
    body: "Switch between editing the current chapter and creating a new chapter with the next prompt.",
    workspaceView: "chapter",
    composerUi: "generationMode",
  },
  {
    id: "contextMeter",
    selector: '[data-tour="write-context-meter"]',
    body: "Shows how full context is.",
    workspaceView: "chapter",
  },
  {
    id: "model",
    selector: '[data-tour="model-button"]',
    body: "Displays selected model. Click on it to open Settings and toggle thinking.",
    workspaceView: "chapter",
  },
  {
    id: "thinking",
    selector: '[data-tour="thinking-button"]',
    body: "Toggle reasoning.",
    workspaceView: "chapter",
    composerUi: "model",
    forceThinkingVisible: true,
  },
  {
    id: "send",
    selector: '[data-tour="send-button"]',
    body: "Send your prompt to the model.",
    workspaceView: "chapter",
  },
];

export const TOUR_STEPS = CHAT_TOUR_STEPS;
