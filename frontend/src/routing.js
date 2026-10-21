const CONVERSATION_PAGES = {
  chat: { saved: "chat", temporary: "temp" },
  roleplay: { saved: "roleplay", temporary: "roleplayTemp" },
};

const PAGE_PREFIXES = {
  chat: "chat",
  temp: "temp",
  roleplay: "roleplay",
  roleplayTemp: "roleplay-temp",
};

const PREFIX_PAGES = {
  chat: "chat",
  temp: "temp",
  roleplay: "roleplay",
  "roleplay-temp": "roleplayTemp",
};

const HOME_MODES = ["chat", "roleplay", "write"];

export function isConversationPage(page) {
  return Object.keys(PAGE_PREFIXES).includes(page);
}

export function modeForPage(page) {
  if (page === "story") return "write";
  if (page === "roleplay" || page === "roleplayTemp") return "roleplay";
  return "chat";
}

export function chatRoute(chat, mode = "chat") {
  const pages = CONVERSATION_PAGES[mode] || CONVERSATION_PAGES.chat;
  if (!chat?.id) return { page: "home", mode };
  return {
    page: chat.temporary ? pages.temporary : pages.saved,
    chatId: chat.id,
  };
}

export function storyRoute(storyId, chapterId = null, workspaceView = "chapter") {
  if (!storyId) return { page: "home", mode: "write" };
  const nextWorkspaceView = ["lorebook", "brainstorm"].includes(workspaceView)
    ? workspaceView
    : "chapter";
  return {
    page: "story",
    storyId,
    chapterId: nextWorkspaceView === "chapter" ? chapterId : null,
    workspaceView: nextWorkspaceView,
  };
}

export function routePath(route) {
  if (!route || route.page === "home") {
    const mode = HOME_MODES.includes(route?.mode) ? route.mode : "chat";
    return `/?mode=${mode}`;
  }

  if (route.page === "story") {
    const storyPath = `/write/story/${encodeURIComponent(route.storyId)}`;
    if (route.workspaceView === "lorebook") return `${storyPath}/lorebook`;
    if (route.workspaceView === "brainstorm") return `${storyPath}/brainstorm`;
    if (route.chapterId) return `${storyPath}/chapter/${encodeURIComponent(route.chapterId)}`;
    return storyPath;
  }

  const prefix = PAGE_PREFIXES[route.page] || "chat";
  return `/${prefix}/${encodeURIComponent(route.chatId)}`;
}

export function parseRoute(pathname = window.location.pathname, search = window.location.search) {
  const parts = pathname.split("/").filter(Boolean);
  const params = new URLSearchParams(search);
  const mode = HOME_MODES.includes(params.get("mode")) ? params.get("mode") : "chat";

  if (parts.length === 0) return { page: "home", mode };

  const conversationPage = PREFIX_PAGES[parts[0]];
  if (conversationPage && parts[1]) {
    return {
      page: conversationPage,
      chatId: decodeURIComponent(parts[1]),
    };
  }

  if (parts[0] === "write" && parts[1] === "story" && parts[2]) {
    const storyId = decodeURIComponent(parts[2]);
    if (parts[3] === "chapter" && parts[4]) {
      return {
        page: "story",
        storyId,
        chapterId: decodeURIComponent(parts[4]),
        workspaceView: "chapter",
      };
    }
    if (parts[3] === "lorebook") {
      return {
        page: "story",
        storyId,
        chapterId: null,
        workspaceView: "lorebook",
      };
    }
    if (parts[3] === "brainstorm") {
      return {
        page: "story",
        storyId,
        chapterId: null,
        workspaceView: "brainstorm",
      };
    }
    return {
      page: "story",
      storyId,
      chapterId: null,
      workspaceView: "chapter",
    };
  }

  return { page: "home", mode: "chat" };
}
