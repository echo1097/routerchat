export const CONVERSATION_MODES = {
  chat: {
    basePath: "/api/chats",
    folderPath: "/api/folders",
    itemKey: "chat",
    listKey: "chats",
    importedCountKey: "imported_chats",
    folderItemsParam: "delete_chats",
    systemPromptKey: "chat_system_prompt",
    folderCountKey: "chat_count",
  },
  roleplay: {
    basePath: "/api/roleplays",
    folderPath: "/api/roleplay-folders",
    itemKey: "roleplay",
    listKey: "roleplays",
    importedCountKey: "imported_roleplays",
    folderItemsParam: "delete_roleplays",
    systemPromptKey: "roleplay_system_prompt",
    folderCountKey: "roleplay_count",
  },
};

export function conversationMode(mode) {
  return CONVERSATION_MODES[mode] || CONVERSATION_MODES.chat;
}
