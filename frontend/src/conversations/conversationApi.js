import { api } from "../api.js";
import { conversationMode } from "./conversationModes.js";

//chats and roleplays live in separate tables behind separate routes, so every call the chat UI makes
//goes through here and comes back in one shape no matter which mode is open
export function createConversationApi(mode) {
  const config = conversationMode(mode);

  function itemPath(conversationId) {
    return `${config.basePath}/${encodeURIComponent(conversationId)}`;
  }

  function readConversation(payload) {
    return {
      conversation: payload?.[config.itemKey] || null,
      messages: payload?.messages || [],
    };
  }

  return {
    mode,
    systemPromptKey: config.systemPromptKey,

    async listConversations() {
      const payload = await api(config.basePath);
      return payload[config.listKey] || [];
    },

    async getConversation(conversationId) {
      return readConversation(await api(itemPath(conversationId)));
    },

    async createConversation(body) {
      const payload = await api(config.basePath, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return payload[config.itemKey];
    },

    async patchConversation(conversationId, body) {
      return readConversation(await api(itemPath(conversationId), {
        method: "PATCH",
        body: JSON.stringify(body),
      }));
    },

    async deleteConversation(conversationId) {
      await api(itemPath(conversationId), { method: "DELETE" });
    },

    async closeConversation(conversationId) {
      await api(`${itemPath(conversationId)}/close`, { method: "POST" });
    },

    closePath(conversationId) {
      return `${itemPath(conversationId)}/close`;
    },

    exportPath(conversationId) {
      return `${itemPath(conversationId)}/export`;
    },

    streamPath(conversationId) {
      return `${itemPath(conversationId)}/messages/stream`;
    },

    async importConversations(payload) {
      const result = await api(`${config.basePath}/import`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return {
        importedConversations: result[config.importedCountKey] || 0,
        importedMessages: result.imported_messages || 0,
      };
    },

    async nameConversation(conversationId) {
      return readConversation(await api(`${itemPath(conversationId)}/title`, {
        method: "POST",
      }));
    },

    async deleteMessage(conversationId, messageId) {
      const path = `${itemPath(conversationId)}/messages/${encodeURIComponent(messageId)}`;
      return readConversation(await api(path, { method: "DELETE" }));
    },

    async listFolders() {
      const payload = await api(config.folderPath);
      return payload.folders || [];
    },

    async createFolder(name) {
      const payload = await api(config.folderPath, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      return payload.folder;
    },

    async renameFolder(folderId, name) {
      const payload = await api(`${config.folderPath}/${encodeURIComponent(folderId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      return payload.folder;
    },

    async deleteFolder(folderId, deleteConversations) {
      const query = `${config.folderItemsParam}=${deleteConversations ? "true" : "false"}`;
      await api(`${config.folderPath}/${encodeURIComponent(folderId)}?${query}`, {
        method: "DELETE",
      });
    },
  };
}
