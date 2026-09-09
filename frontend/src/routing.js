

export function chatRoute(chat) {
  if (!chat?.id) return { page: "home" };
  return {
    page: chat.temporary ? "temp" : "chat",
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
    const mode = route?.mode === "write" ? "write" : "chat";
    return `/?mode=${mode}`;
  }

  if (route.page === "story") {
    const storyPath = `/write/story/${encodeURIComponent(route.storyId)}`;
    if (route.workspaceView === "lorebook") return `${storyPath}/lorebook`;
    if (route.workspaceView === "brainstorm") return `${storyPath}/brainstorm`;
    if (route.chapterId) return `${storyPath}/chapter/${encodeURIComponent(route.chapterId)}`;
    return storyPath;
  }

  const prefix = route.page === "temp" ? "temp" : "chat";
  return `/${prefix}/${encodeURIComponent(route.chatId)}`;
}

export function parseRoute(pathname = window.location.pathname, search = window.location.search) {
  const parts = pathname.split("/").filter(Boolean);
  const params = new URLSearchParams(search);
  const mode = params.get("mode") === "write" ? "write" : "chat";

  if (parts.length === 0) return { page: "home", mode };
  if ((parts[0] === "chat" || parts[0] === "temp") && parts[1]) {
    return {
      page: parts[0],
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
