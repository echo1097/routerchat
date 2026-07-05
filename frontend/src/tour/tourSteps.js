

export const TOUR_STEPS = [
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
