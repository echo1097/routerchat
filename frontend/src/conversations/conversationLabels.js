const LABELS = {
  chat: {
    title: "Chat",
    one: "chat",
    many: "chats",
    newConversation: "New chat",
    openRail: "Open chats",
    searchRail: "Search chats",
    closeRail: "Close chats",
    emptyRail: "Your conversations will appear here.",
    emptyFolder: "Drag a chat here, or use New chat in this folder.",
    deleteTitle: "Delete chat?",
    deleted: "Chat deleted",
    pinned: "Chat pinned",
    unpinned: "Chat unpinned",
    deleteFolderSecondary: "Delete folder and chats",
    folderAndItemsDeleted: "Folder and chats deleted",
    exportFallback: "chat",
  },
  roleplay: {
    title: "Roleplay",
    one: "roleplay",
    many: "roleplays",
    newConversation: "New roleplay",
    openRail: "Open roleplays",
    searchRail: "Search roleplays",
    closeRail: "Close roleplays",
    emptyRail: "Your roleplays will appear here.",
    emptyFolder: "Drag a roleplay here, or use New roleplay in this folder.",
    deleteTitle: "Delete roleplay?",
    deleted: "Roleplay deleted",
    pinned: "Roleplay pinned",
    unpinned: "Roleplay unpinned",
    deleteFolderSecondary: "Delete folder and roleplays",
    folderAndItemsDeleted: "Folder and roleplays deleted",
    exportFallback: "roleplay",
  },
};

export function conversationLabels(mode) {
  return LABELS[mode] || LABELS.chat;
}
