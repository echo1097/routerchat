import React, {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Square,
  Trash2,
  Users,
  X,
} from "lucide-react";
import packageInfo from "../../package.json";
import openingMessages from "./openingMessages.json";
import { cx, CONTROL_MOTION, PROMPT_BAR_CONTROL_MOTION, SOFT_SURFACE, FADE_MOTION } from "./uiShared.js";
import HelpTourButton from "./HelpTourButton.jsx";
import StoryBrainstorm from "./brainstorm/StoryBrainstorm.jsx";
import StoryLorebook from "./lorebook/StoryLorebook.jsx";
import NotificationStack from "./notifications/NotificationStack.jsx";
import { useNotifications } from "./notifications/useNotifications.js";
import { createSaveCoordinator } from "./writing/saveCoordinator.js";
import { createNavigationCoordinator } from "./writing/navigationCoordinator.js";

const ChapterCanvasEditor = lazy(() => import("./writing/ChapterCanvasEditor.jsx"));
import {
  chapterFromUpdateEvent,
  chapterGenerationErrorMessage,
  chapterGenerationEventMatchesRun,
  chapterUpdateMatchesRun,
} from "./writing/chapterGenerationEvents.js";
import TourOverlay from "./tour/TourOverlay.jsx";
import { useTour } from "./tour/useTour.js";
import { WRITE_TOUR_STEPS } from "./tour/tourSteps.js";
import "./styles.css";

const DEFAULT_MODEL = "anthropic/claude-3.5-sonnet";
const APP_VERSION = packageInfo.version;
const APP_SETTINGS_STORAGE_KEY = "routerchat.appSettings";
const OPENING_MESSAGE_STORAGE_KEY = "routerchat.lastOpeningMessage";
const PENDING_CHAPTER_DRAFTS_STORAGE_KEY = "routerchat.pendingChapterDrafts";

const newSettings = {
  model: DEFAULT_MODEL,
  temperature: 0.7,
  max_tokens: 30000,
  system_prompt: "",
  thinking_enabled: false,
  reasoning_effort: "medium",
  nitro_mode: false,
};

const REASONING_EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high", shortLabel: "Extra" },
];

const SETTINGS_PAGES = [
  { id: "general", label: "API", iconClass: "fi fi-rr-key" },
  { id: "models", label: "Models", iconClass: "fi fi-rr-bulb" },
  { id: "system", label: "System", iconClass: "fi fi-rr-settings" },
  { id: "ui", label: "UI", iconClass: "fi fi-rr-apps-add" },
  { id: "cloud", label: "Chats", icon: MessageSquarePlus },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
];

const CHAT_MODES = [
  { value: "chat", label: "Chat" },
  { value: "write", label: "Write" },
];

const WRITE_GENERATION_MODES = {
  edit: "Edit Chapter",
  new: "New Chapter",
};

function rangeProgress(value, min, max) {
  return `${((Number(value) - min) / (max - min)) * 100}%`;
}

function pickOpeningMessage(mode = "chat") {
  const runTime = new Date().getHours();
  const timeKey =
    runTime >= 22 || runTime < 5
      ? "lateNight"
      : runTime < 12
        ? "morning"
        : runTime < 17
          ? "afternoon"
          : "evening";

  const messageSet = openingMessages[mode] || openingMessages.chat || openingMessages;
  const timeMessages = Array.isArray(messageSet[timeKey]) ? messageSet[timeKey] : [];
  const messages = timeMessages.filter((message) => typeof message === "string" && message.trim());
  if (messages.length === 0) return "Where should we begin?";

  const lastMessage =
    typeof window !== "undefined"
      ? window.localStorage.getItem(`${OPENING_MESSAGE_STORAGE_KEY}.${mode}`)
      : null;
  const choices = messages.length > 1 ? messages.filter((message) => message !== lastMessage) : messages;
  const nextMessage = choices[Math.floor(Math.random() * choices.length)];

  if (typeof window !== "undefined") {
    window.localStorage.setItem(`${OPENING_MESSAGE_STORAGE_KEY}.${mode}`, nextMessage);
  }

  return nextMessage;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return response.json();
}

async function responseError(response) {
  const fallback = response.statusText || "Request failed";
  const body = await response.text();
  let payload = null;

  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
  }

  const detail = payload?.detail;
  const message = typeof detail === "string"
    ? detail
    : detail?.message || payload?.error?.message || body || fallback;
  const error = new Error(message);
  error.name = "ApiError";
  error.status = response.status;
  error.payload = payload;
  error.code = detail?.code || payload?.error?.code || payload?.code || null;
  error.chapter = detail?.chapter || payload?.chapter || null;
  return error;
}

async function responseErrorDetail(response) {
  const error = await responseError(response);
  return error.message;
}

const storyApi = {
  async listStories() {
    const payload = await api("/api/stories");
    return payload.stories || [];
  },

  async getStory(storyId) {
    return api(`/api/stories/${encodeURIComponent(storyId)}`);
  },

  async createStory(data) {
    const payload = await api("/api/stories", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return payload.story;
  },

  async createStoryWithInitialChapter(data, initialChapter) {
    return api("/api/stories/with-initial-chapter", {
      method: "POST",
      body: JSON.stringify({ ...data, initial_chapter: initialChapter }),
    });
  },

  async updateStory(storyId, data) {
    const payload = await api(`/api/stories/${encodeURIComponent(storyId)}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    return payload.story;
  },

  async deleteStory(storyId) {
    return api(`/api/stories/${encodeURIComponent(storyId)}`, { method: "DELETE" });
  },

  async closeStory(storyId) {
    return api(`/api/stories/${encodeURIComponent(storyId)}/close`, { method: "POST" });
  },

  async listChapters(storyId) {
    const payload = await api(`/api/stories/${encodeURIComponent(storyId)}/chapters`);
    return payload.chapters || [];
  },

  async createChapter(storyId, data) {
    const payload = await api(`/api/stories/${encodeURIComponent(storyId)}/chapters`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    return payload.chapter;
  },

  async updateChapter(storyId, chapterId, data) {
    const payload = await api(
      `/api/stories/${encodeURIComponent(storyId)}/chapters/${encodeURIComponent(chapterId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
    );
    return payload.chapter;
  },

  async deleteChapter(storyId, chapterId) {
    return api(
      `/api/stories/${encodeURIComponent(storyId)}/chapters/${encodeURIComponent(chapterId)}`,
      { method: "DELETE" },
    );
  },

  async saveChapterContent(storyId, chapterId, content, revision) {
    const payload = await api(
      `/api/stories/${encodeURIComponent(storyId)}/chapters/${encodeURIComponent(chapterId)}/content`,
      {
        method: "PATCH",
        body: JSON.stringify({ content, revision }),
      },
    );
    return payload.chapter;
  },

  async listLorebook(storyId) {
    const payload = await api(`/api/stories/${encodeURIComponent(storyId)}/lorebook`);
    return payload.entries || [];
  },

  async createLorebookEntry(storyId, data) {
    const payload = await api(`/api/stories/${encodeURIComponent(storyId)}/lorebook`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    return payload.entry;
  },

  async updateLorebookEntry(storyId, entryId, data) {
    const payload = await api(
      `/api/stories/${encodeURIComponent(storyId)}/lorebook/${encodeURIComponent(entryId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
    );
    return payload.entry;
  },

  async deleteLorebookEntry(storyId, entryId) {
    return api(
      `/api/stories/${encodeURIComponent(storyId)}/lorebook/${encodeURIComponent(entryId)}`,
      { method: "DELETE" },
    );
  },

  async getBrainstorm(storyId) {
    return api(`/api/stories/${encodeURIComponent(storyId)}/brainstorm`);
  },

  async updateBrainstormNode(storyId, nodeId, data) {
    const payload = await api(
      `/api/stories/${encodeURIComponent(storyId)}/brainstorm/nodes/${encodeURIComponent(nodeId)}`,
      { method: "PATCH", body: JSON.stringify(data) },
    );
    return payload.node;
  },

  async deleteBrainstormNode(storyId, nodeId, cascade = false) {
    return api(
      `/api/stories/${encodeURIComponent(storyId)}/brainstorm/nodes/${encodeURIComponent(nodeId)}?cascade=${cascade}`,
      { method: "DELETE" },
    );
  },

  async updateBrainstormViewport(storyId, viewport) {
    return api(`/api/stories/${encodeURIComponent(storyId)}/brainstorm/viewport`, {
      method: "PATCH",
      body: JSON.stringify({
        position_x: viewport.x,
        position_y: viewport.y,
        zoom: viewport.zoom,
      }),
    });
  },

  async generateBrainstorm({ storyId, prompt, selectedIdeaIds, ideaCount, settings, onEvent, signal }) {
    const response = await fetch(
      `/api/stories/${encodeURIComponent(storyId)}/brainstorm/generate/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          ...settings,
          write_system_prompt: settings.system_prompt,
          selected_idea_ids: selectedIdeaIds,
          brainstorm_idea_count: ideaCount,
          message: prompt,
        }),
      },
    );
    if (!response.ok || !response.body) {
      throw await responseError(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) onEvent(JSON.parse(line));
      }
    }
    if (buffered.trim()) onEvent(JSON.parse(buffered));
  },

  async generateChapter({
    storyId,
    chapterId,
    prompt,
    settings,
    generationMode,
    chapterRevision,
    generationRunId,
    onEvent,
    signal,
  }) {
    const response = await fetch(
      `/api/stories/${encodeURIComponent(storyId)}/chapters/${encodeURIComponent(chapterId)}/generate/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          ...settings,
          write_system_prompt: settings.system_prompt,
          write_generation_mode: generationMode,
          chapter_revision: chapterRevision,
          generation_run_id: generationRunId,
          message: prompt,
        }),
      },
    );

    if (!response.ok || !response.body) {
      throw await responseError(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        onEvent(JSON.parse(line));
      }
    }
    if (buffered.trim()) {
      onEvent(JSON.parse(buffered));
    }
  },
};

function formatThinkingMarkdown(value) {
  return (value || "")
    .replace(/([^\n])\s+(\d+\.\s+)/g, "$1\n$2")
    .replace(/:\n(\d+\.\s+)/g, ":\n\n$1");
}

function modelName(models, id) {
  return models.find((model) => model.id === id)?.name || id || "No model";
}

function promptModelName(models, id) {
  return modelName(models, id)
    .replace(/^[^:]+:\s*/, "")
    .replace(/^[^/]+\//, "");
}

function supportsThinking(models, id) {
  return Boolean(
    models
      .find((model) => model.id === id)
      ?.supported_parameters?.includes("reasoning"),
  );
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatTokens(tokens) {
  if (!Number.isFinite(tokens)) return "Unavailable";
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return `${tokens}`;
}

function truncatePromptText(value, maxLength = 96) {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact || "Empty prompt";
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function getModelContextLimit(model) {
  const providerLimit = toFiniteNumber(model?.top_provider?.context_length);
  const modelLimit = toFiniteNumber(model?.context_length);
  return providerLimit > 0 ? providerLimit : modelLimit > 0 ? modelLimit : null;
}

function getContextWindowInfo(contextTokens, contextLimit) {
  if (!Number.isFinite(contextTokens) || !Number.isFinite(contextLimit) || contextLimit <= 0) {
    return null;
  }
  const percentFull = (contextTokens / contextLimit) * 100;
  const remainingTokens = Math.max(contextLimit - contextTokens, 0);

  return {
    contextTokens,
    contextLimit,
    remainingTokens,
    percentFull,
    displayPercent: `${Math.round(percentFull)}% full`,
    displayUsage: `${formatTokens(contextTokens)} / ${formatTokens(contextLimit)} tokens used`,
  };
}

function priceLabel(model) {
  const prompt = Number(model.pricing?.prompt || 0) * 1000000;
  const completion = Number(model.pricing?.completion || 0) * 1000000;
  if ((!prompt && !completion) || prompt < 0 || completion < 0) return "";
  return `$${prompt.toFixed(prompt >= 1 ? 0 : 2)} / $${completion.toFixed(
    completion >= 1 ? 0 : 2,
  )}`;
}

function isFreeModel(model) {
  if (String(model.id || "").endsWith(":free")) return true;
  const prompt = Number(model.pricing?.prompt || 0);
  const completion = Number(model.pricing?.completion || 0);
  return prompt === 0 && completion === 0;
}

function exportFileName(chat) {
  const title = (chat?.title || "chat")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "chat";
  return `routerchat-${title}-${new Date().toISOString().slice(0, 10)}.json`;
}

function chatRoute(chat) {
  if (!chat?.id) return { page: "home" };
  return {
    page: chat.temporary ? "temp" : "chat",
    chatId: chat.id,
  };
}

function storyRoute(storyId, chapterId = null, workspaceView = "chapter") {
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

function routePath(route) {
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

function parseRoute(pathname = window.location.pathname, search = window.location.search) {
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

function readLocalAppSettings() {
  try {
    return JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeLocalAppSettings(next) {
  const merged = { ...readLocalAppSettings(), ...next };
  window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(merged));
}

function useRafScroller(streamRef, followThreshold = 120) {
  const followRef = useRef(true);
  const rafRef = useRef(null);
  const touchYRef = useRef(null);
  const lastScrollTopRef = useRef(null);

  const isNearBottom = useCallback(() => {
    const node = streamRef.current;
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight < followThreshold;
  }, [followThreshold, streamRef]);

  const cancelScrollFrame = useCallback(() => {
    if (!rafRef.current) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const pauseAutoFollow = useCallback(() => {
    followRef.current = false;
    cancelScrollFrame();
  }, [cancelScrollFrame]);

  const markUserScroll = useCallback(() => {
    const node = streamRef.current;
    if (!node) return;

    const lastScrollTop = lastScrollTopRef.current;
    const movedUp = typeof lastScrollTop === "number" && node.scrollTop < lastScrollTop - 1;
    if (movedUp) {
      followRef.current = false;
    } else if (isNearBottom()) {
      followRef.current = true;
    }
    lastScrollTopRef.current = node.scrollTop;
  }, [isNearBottom, streamRef]);

  const markWheelIntent = useCallback(
    (event) => {
      if (event.deltaY < 0) pauseAutoFollow();
    },
    [pauseAutoFollow],
  );

  const markTouchStart = useCallback((event) => {
    touchYRef.current = event.touches?.[0]?.clientY ?? null;
  }, []);

  const markTouchMove = useCallback(
    (event) => {
      const nextY = event.touches?.[0]?.clientY;
      if (typeof nextY !== "number" || typeof touchYRef.current !== "number") return;
      if (nextY > touchYRef.current) pauseAutoFollow();
      touchYRef.current = nextY;
    },
    [pauseAutoFollow],
  );

  const scrollToBottom = useCallback(
    (force = false) => {
      if (!force && !followRef.current) return;
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (!force && !followRef.current) return;
        const node = streamRef.current;
        if (node) {
          node.scrollTop = node.scrollHeight;
          lastScrollTopRef.current = node.scrollTop;
        }
      });
    },
    [streamRef],
  );

  const startFollowing = useCallback(() => {
    followRef.current = true;
    scrollToBottom(true);
  }, [scrollToBottom]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return {
    isNearBottom,
    markUserScroll,
    markWheelIntent,
    markTouchStart,
    markTouchMove,
    scrollToBottom,
    startFollowing,
    followRef,
  };
}

function IconButton({ label, children, className, ...props }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-10 w-10 items-center justify-center rounded-full border border-line bg-white/[0.04] text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        CONTROL_MOTION,
        SOFT_SURFACE,
        "hover:border-white/15 hover:bg-white/[0.075] hover:text-white",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function AssistantActionButton({ label, children, ...props }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
        CONTROL_MOTION,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function ResponseInfoButton({ message }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef(null);
  const closeTimerRef = useRef(null);
  const popoverId = `response-info-${message.id}`;

  const rows = [
    ["Total input tokens", formatInteger(message.prompt_tokens)],
    ["Total output tokens", formatInteger(message.completion_tokens)],
    ["Total tokens", formatInteger(message.total_tokens)],
    ["Total cost", formatCost(message.cost)],
    ["Model", message.model || "Unavailable"],
  ];

  function clearCloseTimer() {
    if (!closeTimerRef.current) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }

  function closePopover() {
    if (!open) return;
    clearCloseTimer();
    setOpen(false);
    setClosing(true);
    const closeMs = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--dropdown-close-dur"),
    ) || 150;
    closeTimerRef.current = window.setTimeout(() => {
      setClosing(false);
      closeTimerRef.current = null;
    }, closeMs);
  }

  function togglePopover(event) {
    event.stopPropagation();
    if (open) {
      closePopover();
      return;
    }
    clearCloseTimer();
    setClosing(false);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (rootRef.current?.contains(event.target)) return;
      closePopover();
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") closePopover();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => () => clearCloseTimer(), []);

  return (
    <div ref={rootRef} className="response-info">
      <button
        type="button"
        aria-label={open ? "Close response info" : "Show response info"}
        title={open ? "Close response info" : "Show response info"}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={togglePopover}
        className={cx(
          "inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
          CONTROL_MOTION,
        )}
      >
        <span className="t-icon-swap response-info-icon" data-state={open ? "b" : "a"}>
          <span className="t-icon" data-icon="a" aria-hidden="true">
            <i className="fi fi-rc-info" />
          </span>
          <span className="t-icon" data-icon="b" aria-hidden="true">
            <i className="fi fi-br-cross-small" />
          </span>
        </span>
      </button>
      <div
        id={popoverId}
        role="dialog"
        aria-label="Response information"
        data-origin="bottom-left"
        className={cx(
          "t-dropdown response-info-popover",
          open && "is-open",
          closing && "is-closing",
        )}
      >
        <div className="response-info-title">Response info</div>
        <dl className="response-info-grid">
          {rows.map(([label, value]) => (
            <div key={label} className="response-info-row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function OverflowActions({
  id,
  title,
  label,
  isFirst = false,
  forceVisible = false,
  menuWidth = 156,
  children,
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [menuStyle, setMenuStyle] = useState({});
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const closeTimerRef = useRef(null);
  const menuId = `${id}-actions`;

  function updateMenuPosition() {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - menuWidth - 12);

    setMenuStyle({
      left: `${Math.max(12, left)}px`,
      top: `${rect.bottom + 6}px`,
    });
  }

  function clearCloseTimer() {
    if (!closeTimerRef.current) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }

  function closeMenu() {
    if (!open) return;
    clearCloseTimer();
    setOpen(false);
    setClosing(true);
    const closeMs = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--dropdown-close-dur"),
    ) || 150;
    closeTimerRef.current = window.setTimeout(() => {
      setClosing(false);
      closeTimerRef.current = null;
    }, closeMs);
  }

  function toggleMenu(event) {
    event.stopPropagation();
    if (open) {
      closeMenu();
      return;
    }
    clearCloseTimer();
    setClosing(false);
    updateMenuPosition();
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (rootRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      closeMenu();
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") closeMenu();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open]);

  useEffect(() => () => clearCloseTimer(), []);

  const menu = (open || closing) && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          data-origin="top-left"
          style={menuStyle}
          className={cx(
            "t-dropdown chat-history-menu",
            open && "is-open",
            closing && "is-closing",
          )}
        >
          {children(closeMenu)}
        </div>,
        document.body,
      )
    : null;

  return (
    <div
      ref={rootRef}
      className={cx(
        "chat-history-actions relative flex",

        forceVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
      )}
    >
      <button
        ref={buttonRef}
        type="button"
        title={label}
        data-tour={isFirst ? "chat-actions-button" : undefined}
        aria-label={`${label} for ${title}`}
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="menu"
        onClick={toggleMenu}
        className={cx(
          "chat-history-menu-button grid h-7 w-7 place-items-center rounded-full bg-transparent text-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
          CONTROL_MOTION,
          open
            ? "text-zinc-200"
            : "hover:text-zinc-200",
        )}
      >
        <i className="fi fi-bs-menu-dots" aria-hidden="true" />
      </button>
      {menu}
    </div>
  );
}

function ChatHistoryActions({ chat, isFirst, forceVisible, onRename, onDelete, onExport, onTogglePin }) {
  return (
    <OverflowActions
      id={`chat-${chat.id}`}
      title={chat.title}
      label="Chat actions"
      isFirst={isFirst}
      forceVisible={forceVisible}
    >
      {(closeMenu) => (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onRename(chat);
            }}
            className="chat-history-menu-item text-zinc-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            <Pencil size={14} />
            Edit name
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onTogglePin(chat);
            }}
            className="chat-history-menu-item text-zinc-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            <i className="fi fi-rr-thumbtack text-[14px] leading-none" aria-hidden="true" />
            {chat.pinned ? "Unpin chat" : "Pin chat"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onExport(chat);
            }}
            className="chat-history-menu-item text-zinc-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            <i className="fi fi-rr-file-export text-[14px] leading-none" aria-hidden="true" />
            Export chat
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onDelete(chat.id);
            }}
            className="chat-history-menu-item text-red-300 hover:bg-red-500/10 focus:bg-red-500/10 focus:outline-none"
          >
            <Trash2 size={14} />
            Delete chat
          </button>
        </>
      )}
    </OverflowActions>
  );
}

function StoryHistoryActions({ story, onRename, onDelete }) {
  return (
    <OverflowActions
      id={`story-${story.id}`}
      title={story.title}
      label="Story actions"
      menuWidth={164}
    >
      {(closeMenu) => (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onRename(story);
            }}
            className="chat-history-menu-item text-zinc-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            <Pencil size={14} />
            Edit name
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onDelete(story);
            }}
            className="chat-history-menu-item text-red-300 hover:bg-red-500/10 focus:bg-red-500/10 focus:outline-none"
          >
            <Trash2 size={14} />
            Delete story
          </button>
        </>
      )}
    </OverflowActions>
  );
}

function ChapterHistoryActions({ chapter, onRename, onDelete, onToggleContext }) {
  return (
    <OverflowActions
      id={`chapter-${chapter.id}`}
      title={chapter.title}
      label="Chapter actions"
      menuWidth={164}
    >
      {(closeMenu) => (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onRename(chapter);
            }}
            className="chat-history-menu-item text-zinc-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            <Pencil size={14} />
            Edit name
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onToggleContext(chapter);
            }}
            className="chat-history-menu-item text-zinc-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            {chapter.disabled ? <Eye size={14} /> : <EyeOff size={14} />}
            {chapter.disabled ? "Show chapter" : "Hide chapter"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onDelete(chapter);
            }}
            className="chat-history-menu-item text-red-300 hover:bg-red-500/10 focus:bg-red-500/10 focus:outline-none"
          >
            <Trash2 size={14} />
            Delete chapter
          </button>
        </>
      )}
    </OverflowActions>
  );
}

function ConversationRail({
  chats,
  activeChatId,
  models,
  onNewChat,
  onLoadChat,
  onRenameChat,
  onDeleteChat,
  onExportChat,
  onTogglePinChat,
  mobileOpen,
  onCloseMobile,
  collapsed,
  onCollapse,
  highlightFirstChatActions,
  chatMode,
  previousChatMode,
  onChatModeChange,
}) {
  const [railScrolling, setRailScrolling] = useState(false);
  const [renamingChatId, setRenamingChatId] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const railScrollTimeoutRef = useRef(null);
  const skipRenameCommitRef = useRef(false);

  useEffect(
    () => () => {
      if (railScrollTimeoutRef.current) {
        window.clearTimeout(railScrollTimeoutRef.current);
      }
    },
    [],
  );

  function handleRailScroll() {
    setRailScrolling(true);
    window.clearTimeout(railScrollTimeoutRef.current);
    railScrollTimeoutRef.current = window.setTimeout(
      () => setRailScrolling(false),
      650,
    );
  }

  function startRename(chat) {
    skipRenameCommitRef.current = false;
    setRenamingChatId(chat.id);
    setRenameDraft(chat.title || "");
  }

  function cancelRename() {
    skipRenameCommitRef.current = true;
    setRenamingChatId(null);
    setRenameDraft("");
  }

  async function commitRename(chat) {
    if (skipRenameCommitRef.current) {
      skipRenameCommitRef.current = false;
      return;
    }
    const nextTitle = renameDraft.trim();
    if (!nextTitle || nextTitle === chat.title) {
      setRenamingChatId(null);
      setRenameDraft("");
      return;
    }
    await onRenameChat(chat.id, nextTitle);
    setRenamingChatId(null);
    setRenameDraft("");
  }

  const pinnedChats = chats.filter((chat) => chat.pinned);
  const recentChats = chats.filter((chat) => !chat.pinned);

  function renderChatRows(groupChats, startIndex = 0) {
    return groupChats.map((chat, chatIndex) => {
      const renaming = renamingChatId === chat.id;
      const index = startIndex + chatIndex;

      return (
        <div
          key={chat.id}
          className={cx(
            "group relative grid select-none grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-2xl border border-transparent px-2 py-1 transition-[background-color,border-color,box-shadow] duration-150 ease-out",
            chat.id === activeChatId
              ? "bg-white/[0.08] shadow-[var(--shadow-border)]"
              : "hover:bg-white/[0.045] hover:shadow-[var(--shadow-border)]",
          )}
        >
          {renaming ? (
            <div className="min-h-8 min-w-0 rounded-xl px-1 py-0.5">
              <input
                autoFocus
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={() => commitRename(chat)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                className="block h-6 w-full min-w-0 rounded-md bg-white/[0.06] px-1.5 text-sm font-medium text-zinc-100 outline-none shadow-[var(--shadow-border)]"
              />
              <div className="truncate text-[11px] leading-3 text-zinc-500">
                {promptModelName(models, chat.model)}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                onLoadChat(chat.id);
                onCloseMobile();
              }}
              className={cx(
                "min-h-8 min-w-0 rounded-xl px-1 py-0.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
                CONTROL_MOTION,
              )}
            >
              <div className="truncate text-balance text-sm font-medium leading-4 text-zinc-100">
                {chat.title}
              </div>
              <div className="truncate text-[11px] leading-3 text-zinc-500">
                {promptModelName(models, chat.model)}
              </div>
            </button>
          )}
          <ChatHistoryActions
            chat={chat}
            isFirst={index === 0}
            forceVisible={index === 0 && highlightFirstChatActions}
            onRename={startRename}
            onDelete={onDeleteChat}
            onExport={onExportChat}
            onTogglePin={onTogglePinChat}
          />
        </div>
      );
    });
  }

  function renderHistoryGroup(label, groupChats, open, onToggle, startIndex = 0) {
    const panelId = `${label.toLowerCase()}-chat-history`;
    return (
      <section className="t-acc chat-history-group" data-open={String(open)}>
        <button
          type="button"
          className="t-acc-head chat-history-group-heading"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span>{label}</span>
          <span className="t-acc-chevron chat-history-group-chevron" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none">
              <path d="M4 6.5L8 10.5L12 6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
        <div id={panelId} className="t-acc-panel">
          <div className="t-acc-panel-inner chat-history-group-items">
            {renderChatRows(groupChats, startIndex)}
          </div>
        </div>
      </section>
    );
  }

  const historyItems =
    chats.length === 0 ? (
      <div className="px-3 py-8 text-pretty text-sm leading-6 text-zinc-500">
        {chatMode === "write"
          ? "Your stories will appear here."
          : "Your conversations will appear here."}
      </div>
    ) : (
      <div className="space-y-4">
        {pinnedChats.length > 0 && renderHistoryGroup(
          "Pinned",
          pinnedChats,
          pinnedOpen,
          () => setPinnedOpen((current) => !current),
        )}
        {renderHistoryGroup(
          "Recents",
          recentChats,
          recentsOpen,
          () => setRecentsOpen((current) => !current),
          pinnedChats.length,
        )}
      </div>
    );

  return (
    <>
      <div
        className={cx(
          "fixed inset-0 z-30 bg-black/55 opacity-0 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-200 ease-out lg:hidden",
          mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none",
        )}
        onClick={onCloseMobile}
      />
      <aside
        className={cx(
          "chat-sidebar t-resize fixed inset-y-0 left-0 z-40 flex w-[292px] flex-col overflow-hidden border-r border-line bg-[#0b0b0d]/95 lg:static lg:z-auto lg:translate-x-0",
          collapsed
            ? "lg:w-0 lg:-translate-x-3 lg:border-r-0 lg:border-transparent lg:opacity-0"
            : "lg:w-[276px] lg:opacity-100",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div
          className={cx(
            "chat-sidebar-content flex h-full w-[292px] flex-col p-4 lg:w-[276px]",
            collapsed
              ? "lg:-translate-x-8 lg:opacity-0"
              : "lg:translate-x-0 lg:opacity-100",
          )}
        >
          <div className="mb-3 flex justify-center">
            <SlidingTabs
              options={CHAT_MODES}
              value={chatMode}
              fromValue={previousChatMode}
              onChange={onChatModeChange}
              getValue={(mode) => mode.value}
              getLabel={(mode) => mode.label}
              ariaLabel="Interaction mode"
              className="sidebar-mode-tabs"
            />
          </div>

          <div className="mb-4 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                onNewChat();
                onCloseMobile();
              }}
              className={cx(
                "flex h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                CONTROL_MOTION,
              )}
            >
              <MessageSquarePlus size={17} />
              New chat
            </button>
            <IconButton
              label="Collapse sidebar"
              className="hidden lg:inline-flex"
              data-tour="collapse-sidebar-button"
              onClick={onCollapse}
            >
              <PanelLeftClose size={17} />
            </IconButton>
            <IconButton label="Close chats" className="lg:hidden" onClick={onCloseMobile}>
              <X size={17} />
            </IconButton>
          </div>

          <nav
            onScroll={handleRailScroll}
            className={cx(
              "chat-rail-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto pr-1",
              railScrolling && "is-scrolling",
            )}
          >
            {historyItems}
          </nav>

          <div className="mt-4 shrink-0 px-3 pb-1 text-left text-[11px] font-medium leading-none text-zinc-700">
            RouterChat v{APP_VERSION}
          </div>
        </div>
      </aside>
    </>
  );
}

function SidebarRevealButton({ visible, onClick }) {
  const [nearEdge, setNearEdge] = useState(false);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-y-0 left-0 z-50 hidden w-16 lg:block"
      onMouseEnter={() => setNearEdge(true)}
      onMouseLeave={() => setNearEdge(false)}
    >
      <button
        type="button"
        aria-label="Expand sidebar"
        title="Expand sidebar"
        onClick={onClick}
        onFocus={() => setNearEdge(true)}
        onBlur={() => setNearEdge(false)}
        className={cx(
          "sidebar-reveal-button absolute left-3 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-[#18181b]/95 text-zinc-300 shadow-[var(--shadow-surface)] backdrop-blur-xl hover:border-white/15 hover:bg-white/[0.09] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
          nearEdge
            ? "translate-x-0 opacity-100"
            : "-translate-x-2 opacity-0 focus-visible:translate-x-0 focus-visible:opacity-100",
        )}
      >
        <PanelLeftOpen size={18} />
      </button>
    </div>
  );
}

function PromptNavigationRail({ messages, streamRef, visible, activeChatId }) {
  const railRef = useRef(null);
  const frameRef = useRef(null);
  const [railItems, setRailItems] = useState([]);
  const [activePromptId, setActivePromptId] = useState(null);
  const [previewPromptId, setPreviewPromptId] = useState(null);

  const promptMessages = useMemo(
    () => messages.filter((message) => message.role === "user"),
    [messages],
  );

  const measureRail = useCallback(() => {
    frameRef.current = null;

    const scroller = streamRef.current;
    const rail = railRef.current;
    if (!visible || !activeChatId || !scroller || !rail || promptMessages.length === 0) {
      setRailItems([]);
      setActivePromptId(null);
      return;
    }

    const railPadding = 12;
    const railHeight = Math.max(rail.clientHeight - railPadding * 2, 1);
    const railCenter = railPadding + railHeight / 2;
    const promptGap = 8;
    const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 1);
    const activeLine = scroller.scrollTop + scroller.clientHeight * 0.5;

    const messageNodes = Array.from(scroller.querySelectorAll("[data-message-id]"));

    const baseItems = promptMessages.map((message, index) => {
      const node = messageNodes.find(
        (messageNode) => messageNode.dataset.messageId === String(message.id),
      );
      const scrollTop = Math.min(Math.max((node?.offsetTop || 0) - 24, 0), maxScroll);
      const previewText = truncatePromptText(message.content);

      return {
        id: message.id,
        index,
        scrollTop,
        previewText,
      };
    });

    let activeIndex = 0;
    let nextActiveId = baseItems[0]?.id || null;
    for (const item of baseItems) {
      if (item.scrollTop <= activeLine) {
        nextActiveId = item.id;
        activeIndex = item.index;
      }
    }

    const maxVisibleCount = Math.max(
      Math.floor((railHeight - railPadding) / promptGap),
      1,
    );
    const oddVisibleCount = maxVisibleCount % 2 === 0
      ? maxVisibleCount - 1
      : maxVisibleCount;
    const visibleCount = Math.max(
      Math.min(
        baseItems.length % 2 === 0 ? baseItems.length - 1 : baseItems.length,
        oddVisibleCount,
      ),
      1,
    );
    const visibleRadius = Math.floor(visibleCount / 2);
    const maxStartIndex = Math.max(baseItems.length - visibleCount, 0);
    const startIndex = Math.min(
      Math.max(activeIndex - visibleRadius, 0),
      maxStartIndex,
    );
    const visibleItems = baseItems.slice(startIndex, startIndex + visibleCount);

    const nextItems = visibleItems.map((item, visibleIndex) => ({
      ...item,
      top: railCenter + (visibleIndex - visibleRadius) * promptGap,
    }));

    setRailItems(nextItems);
    setActivePromptId(nextActiveId);
  }, [activeChatId, promptMessages, streamRef, visible]);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(measureRail);
  }, [measureRail]);

  useEffect(() => {
    scheduleMeasure();
  }, [messages, scheduleMeasure]);

  useEffect(() => {
    const scroller = streamRef.current;
    const rail = railRef.current;
    if (!visible || !scroller || !rail) return undefined;

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(scroller);
    observer.observe(rail);

    scroller.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [scheduleMeasure, streamRef, visible]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  if (!visible || promptMessages.length === 0) return null;

  function jumpToPrompt(item) {
    const scroller = streamRef.current;
    if (!scroller) return;

    scroller.scrollTo({
      top: item.scrollTop,
      behavior: "smooth",
    });
  }

  return (
    <nav className="prompt-nav-rail-wrap" aria-label="Prompt navigation">
      <div
        ref={railRef}
        className="prompt-nav-rail"
        onMouseLeave={() => {
          setPreviewPromptId(null);
        }}
      >
        {railItems.map((item) => {
          const active = item.id === activePromptId;
          const previewing = item.id === previewPromptId;

          return (
            <button
              key={item.id}
              type="button"
              aria-label={`Jump to prompt ${item.index + 1}: ${item.previewText}`}
              onClick={() => jumpToPrompt(item)}
              onMouseEnter={() => setPreviewPromptId(item.id)}
              onMouseLeave={() => setPreviewPromptId(null)}
              onFocus={() => setPreviewPromptId(item.id)}
              onBlur={() => setPreviewPromptId(null)}
              className={cx(
                "prompt-nav-tick",
                active && "is-active",
                previewing && "is-previewing",
              )}
              style={{ top: `${item.top}px` }}
            >
              <span aria-hidden="true" className="prompt-nav-line" />
              <span
                className={cx(
                  "prompt-nav-preview",
                  previewing && "is-open",
                )}
              >
                {item.previewText}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

const ThinkingContent = memo(function ThinkingContent({ children }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ node, ...props }) => <p className="mb-3 text-pretty last:mb-0" {...props} />,
        code: ({ inline, ...props }) =>
          inline ? (
            <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[0.92em] text-zinc-400" {...props} />
          ) : (
            <code {...props} />
          ),
        pre: ({ node, ...props }) => (
          <pre className="my-3 overflow-x-auto rounded-xl bg-black/25 p-3 text-xs leading-5 text-zinc-400 shadow-[var(--shadow-border)]" {...props} />
        ),
        ul: ({ node, ...props }) => (
          <ul className="my-3 list-disc space-y-1 pl-5 text-pretty marker:text-zinc-600" {...props} />
        ),
        ol: ({ node, ...props }) => (
          <ol className="my-3 list-decimal space-y-1 pl-5 text-pretty marker:text-zinc-600" {...props} />
        ),
      }}
    >
      {formatThinkingMarkdown(children)}
    </ReactMarkdown>
  );
});

function formatThoughtDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function compactPrompt(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function promptPreview(value, maxLength = 140) {
  const compact = compactPrompt(value);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function historyRunGroups(entries) {
  const groups = [];
  entries.forEach((entry) => {
    if (entry.label === "User prompt" || groups.length === 0) {
      groups.push({
        id: entry.id,
        prompt: entry,
        actions: [],
      });
      return;
    }
    groups[groups.length - 1].actions.push(entry);
  });
  return groups;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatInteger(value) {
  if (!isFiniteNumber(value)) return "Unavailable";
  return new Intl.NumberFormat().format(value);
}

function formatCost(value) {
  if (!isFiniteNumber(value)) return "Unavailable";
  if (value > 0 && value < 1) {
    const cents = value * 100;
    const centsText = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: cents < 0.1 ? 3 : 1,
      maximumFractionDigits: cents < 0.1 ? 3 : 1,
    }).format(cents);

    return `${centsText}¢`;
  }

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value >= 1 ? 2 : 6,
  }).format(value);
}

function ContextWindowMeter({ info, placement = "above" }) {
  const tooltipId = useId();
  if (!info) return null;

  const percent = Math.min(Math.max(info.percentFull, 0), 100);
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - percent / 100);
  const ariaLabel = `Context window ${info.displayPercent}, ${info.displayUsage}`;

  return (
    <span
      className={cx(
        "t-tt-wrap context-meter-wrap inline-flex h-8 w-8 shrink-0 items-center justify-center",
        placement === "belowEnd" && "context-meter-wrap-below-end",
      )}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-describedby={tooltipId}
        className={cx(
          "t-tt-trigger grid h-8 w-8 place-items-center rounded-full text-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
          CONTROL_MOTION,
          "hover:text-zinc-100",
        )}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="h-[11px] w-[11px] -rotate-90"
        >
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="opacity-35"
          />
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="opacity-80 transition-[stroke-dashoffset] duration-300 ease-out"
          />
        </svg>
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="t-tt context-meter-tooltip"
      >
        <span className="block text-zinc-100">
          {info.displayUsage}
        </span>
      </span>
    </span>
  );
}

const ThinkingBlock = memo(function ThinkingBlock({ reasoning, streaming, durationMs }) {
  const [open, setOpen] = useState(false);

  if (!reasoning) return null;

  const label =
    !streaming && durationMs ? `Thought for ${formatThoughtDuration(durationMs)}` : "Thinking";

  return (
    <div className="mb-4 max-w-3xl">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "inline-flex min-h-7 items-center gap-2 rounded-md py-0 pr-2 text-xs font-medium text-zinc-500 hover:text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
          CONTROL_MOTION,
        )}
      >
        <ChevronDown
          size={15}
          className={cx("transition-transform duration-150 ease-out", !open && "-rotate-90")}
        />
        <span className={streaming ? "t-shimmer" : undefined} data-text={label}>
          {label}
        </span>
        {streaming && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </button>
      {open && (
        <div className="mt-3 border-l border-white/10 pl-4 text-pretty text-sm leading-7 text-zinc-500">
          <ThinkingContent>{reasoning}</ThinkingContent>
        </div>
      )}
    </div>
  );
});

const MarkdownContent = memo(function MarkdownContent({ children }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ node, ...props }) => <p className="mb-4 text-pretty last:mb-0" {...props} />,
        a: ({ node, ...props }) => (
          <a
            className="text-accent underline decoration-accent/30 underline-offset-4 transition-[color,text-decoration-color] duration-150 ease-out hover:decoration-accent/70"
            target="_blank"
            rel="noreferrer"
            {...props}
          />
        ),
        code: ({ inline, ...props }) =>
          inline ? (
            <code className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[0.92em] text-zinc-100" {...props} />
          ) : (
            <code {...props} />
          ),
        pre: ({ node, ...props }) => (
          <pre className="my-4 overflow-x-auto rounded-2xl bg-black/35 p-4 text-sm leading-6 shadow-[var(--shadow-border)]" {...props} />
        ),
        ul: ({ node, ...props }) => (
          <ul className="my-4 list-disc space-y-1 pl-5 text-pretty" {...props} />
        ),
        ol: ({ node, ...props }) => (
          <ol className="my-4 list-decimal space-y-1 pl-5 text-pretty" {...props} />
        ),
      }}
    >
      {children || ""}
    </ReactMarkdown>
  );
});

const MessageItem = memo(function MessageItem({
  message,
  streaming,
  reasoningStreaming,
  reasoningDurationMs,
  onCopy,
  onRegenerate,
  onEditUserMessage,
  onDeleteUserMessage,
}) {
  const isUser = message.role === "user";
  const articleRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(message.content || "");
  }, [editing, message.content]);

  function captureScrollAnchor() {
    const article = articleRef.current;
    const scroller = article?.closest("section");
    if (!article || !scroller) return null;
    return {
      article,
      scroller,
      top: article.getBoundingClientRect().top,
    };
  }

  function restoreScrollAnchor(anchor) {
    if (!anchor) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!anchor.article.isConnected || !anchor.scroller.isConnected) return;
        const nextTop = anchor.article.getBoundingClientRect().top;
        anchor.scroller.scrollTop += nextTop - anchor.top;
      });
    });
  }

  function startEditing() {
    const anchor = captureScrollAnchor();
    setEditing(true);
    restoreScrollAnchor(anchor);
  }

  function cancelEditing() {
    const anchor = captureScrollAnchor();
    setEditing(false);
    setDraft(message.content || "");
    restoreScrollAnchor(anchor);
  }

  async function saveEdit() {
    const next = draft.trim();
    if (!next || next === message.content) {
      cancelEditing();
      return;
    }
    const anchor = captureScrollAnchor();
    setSaving(true);
    try {
      await onEditUserMessage(message, next);
      setEditing(false);
      restoreScrollAnchor(anchor);
    } finally {
      setSaving(false);
    }
  }

  if (isUser) {
    return (
      <article
        ref={articleRef}
        data-message-id={message.id}
        data-message-role={message.role}
        className={cx("group flex", editing ? "justify-stretch" : "justify-end")}
      >
        <div
          className={cx(
            "flex flex-col gap-2",
            editing
              ? "w-full items-stretch"
              : "max-w-[78%] items-end sm:max-w-[68%]",
          )}
        >
          <div
            className={cx(
              editing
                ? "prompt-edit-surface w-full rounded-[28px] px-5 pb-5 pt-4"
                : "whitespace-pre-wrap rounded-[22px] bg-blue-500/85 px-4 py-3 text-pretty text-sm leading-6 text-white shadow-lg shadow-blue-950/20",
            )}
          >
            {editing ? (
              <>
                <textarea
                  value={draft}
                  rows={Math.min(8, Math.max(3, draft.split("\n").length))}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.metaKey) {
                      event.preventDefault();
                      saveEdit();
                    }
                    if (event.key === "Escape") {
                      cancelEditing();
                    }
                  }}
                  className="block max-h-[260px] min-h-[108px] w-full resize-none bg-transparent text-base leading-7 text-zinc-50 outline-none placeholder:text-zinc-500 sm:text-[17px]"
                />
                <div className="mt-5 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={cancelEditing}
                    className={cx(
                      "inline-flex min-h-11 items-center rounded-full px-5 text-sm font-medium text-zinc-100 shadow-[0_0_0_1px_rgba(255,255,255,0.13)] hover:bg-white/[0.055] hover:shadow-[0_0_0_1px_rgba(255,255,255,0.2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                      CONTROL_MOTION,
                    )}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving || !draft.trim()}
                    onClick={saveEdit}
                    className={cx(
                      "inline-flex min-h-11 items-center rounded-full bg-white px-6 text-sm font-semibold text-zinc-950 hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:bg-white/35 disabled:text-zinc-700 disabled:active:scale-100",
                      CONTROL_MOTION,
                    )}
                  >
                    {saving ? "Sending" : "Send"}
                  </button>
                </div>
              </>
            ) : (
              message.content
            )}
          </div>
          {!editing && (
            <div className={cx("flex justify-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100", FADE_MOTION)}>
              <AssistantActionButton
                label="Edit prompt"
                onClick={startEditing}
              >
                <Pencil size={15} />
              </AssistantActionButton>
              <AssistantActionButton
                label="Delete prompt"
                onClick={() => onDeleteUserMessage(message)}
              >
                <Trash2 size={15} />
              </AssistantActionButton>
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <article
      data-message-id={message.id}
      data-message-role={message.role}
      className="group max-w-none"
    >
      <ThinkingBlock
        reasoning={message.reasoning}
        streaming={reasoningStreaming}
        durationMs={reasoningDurationMs}
      />
      <div className="max-w-3xl text-[15px] leading-7 text-zinc-100">
        {message.content ? (
          <MarkdownContent>{message.content}</MarkdownContent>
        ) : (
          <div className="flex items-center gap-2 text-zinc-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500" />
            Working
          </div>
        )}
      </div>
      {message.content && (
        <div className={cx("mt-3 flex max-w-3xl justify-start gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100", FADE_MOTION)}>
          <AssistantActionButton label="Copy" onClick={() => onCopy(message)}>
            <Copy size={15} />
          </AssistantActionButton>
          <AssistantActionButton
            label="Regenerate"
            onClick={() => onRegenerate(message.id)}
          >
            <RefreshCw size={15} />
          </AssistantActionButton>
          <ResponseInfoButton message={message} />
        </div>
      )}
    </article>
  );
});

function EmptyChatState() {
  return (
    <div className="min-h-[100dvh]" aria-hidden="true" />
  );
}

function WriteLanding({ openingMessage, stories, onStartNew, onContinue }) {
  const [continueOpen, setContinueOpen] = useState(false);
  const continuePanelId = useId();
  const hasStories = stories.length > 0;

  return (
    <section className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 pb-[12vh] pt-20 sm:px-8 lg:px-10">
      <div className="pointer-events-auto mx-auto flex w-full max-w-[760px] flex-col items-center">
        {openingMessage && (
          <div className="mb-8 text-center text-[22px] font-medium leading-tight text-zinc-200 sm:text-3xl">
            {openingMessage}
          </div>
        )}
        <div className="flex w-full flex-col items-center justify-center gap-3 sm:flex-row sm:items-start">
          <button
            type="button"
            onClick={onStartNew}
            className={cx(
              "inline-flex h-11 min-w-[178px] items-center justify-center rounded-full bg-zinc-100 px-5 text-sm font-medium text-zinc-950 shadow-[0_12px_36px_rgba(0,0,0,0.24)] hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
              CONTROL_MOTION,
            )}
          >
            Start a new story
          </button>
          <div
            className="t-acc relative w-[178px] max-w-full"
            data-open={String(hasStories && continueOpen)}
          >
            <button
              type="button"
              onClick={() => setContinueOpen((current) => !current)}
              disabled={!hasStories}
              aria-expanded={hasStories && continueOpen}
              aria-controls={continuePanelId}
              className={cx(
                "t-acc-head inline-flex h-11 w-full min-w-[178px] items-center justify-center gap-2 rounded-full bg-[#18181a] px-5 text-sm font-medium text-zinc-100 shadow-[0_0_0_1px_rgba(255,255,255,0.11),0_12px_36px_rgba(0,0,0,0.2)] hover:bg-[#1f1f22] disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-[#18181a] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                CONTROL_MOTION,
              )}
            >
              <span>Continue a story</span>
            </button>
            <div id={continuePanelId} className="t-acc-panel absolute left-0 right-0 top-full z-30">
              <div className="t-acc-panel-inner px-1 pb-1 pt-2">
                <div className="max-h-[240px] overflow-y-auto rounded-2xl bg-[#121214] p-1 shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_18px_44px_rgba(0,0,0,0.28)]">
                  {stories.map((story) => (
                    <button
                      key={story.id}
                      type="button"
                      onClick={() => onContinue(story.id)}
                      className="flex h-10 w-full min-w-0 items-center rounded-xl px-3 text-left text-sm font-medium text-zinc-300 hover:bg-white/[0.055] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
                    >
                      <span className="truncate">{story.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TemporaryChatButton({ active, onClick }) {
  return (
    <button
      type="button"
      data-tour="temp-chat-button"
      aria-label={active ? "Temporary chat on" : "Temporary chat off"}
      title={active ? "Temporary chat on" : "Temporary chat off"}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full text-[17px] leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        CONTROL_MOTION,
        active
          ? "text-zinc-100"
          : "text-zinc-400 hover:text-zinc-100",
      )}
    >
      <span className="t-icon-swap temp-chat-toggle-icon" data-state={active ? "b" : "a"}>
        <span className="t-icon" data-icon="a" aria-hidden="true">
          <i className="fi fi-rr-ghost" />
        </span>
        <span className="t-icon" data-icon="b" aria-hidden="true">
          <i className="fi fi-sr-ghost" />
        </span>
      </span>
    </button>
  );
}

function TemporaryChatMarker({ visible }) {
  if (!visible) return null;

  return (
    <div
      className="pointer-events-none absolute left-4 top-16 z-20 flex h-10 w-10 items-center justify-center text-[18px] leading-none text-zinc-100 sm:left-8 sm:top-4 lg:left-10"
      aria-hidden="true"
    >
      <i className="fi fi-rs-ghost" />
    </div>
  );
}

function MessageList({
  messages,
  activeChatId,
  streamingMessageId,
  reasoningStreamingMessageId,
  reasoningDurations,
  streamRef,
  onScroll,
  onWheel,
  onTouchStart,
  onTouchMove,
  onCopy,
  onRegenerate,
  onEditUserMessage,
  onDeleteUserMessage,
}) {
  return (
    <section
      ref={streamRef}
      onScroll={onScroll}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      className="min-h-0 overflow-y-auto overscroll-contain px-4 py-8 sm:px-8 lg:px-10"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
        {!activeChatId && messages.length === 0 ? (
          <EmptyChatState />
        ) : (
          messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              streaming={message.id === streamingMessageId}
              reasoningStreaming={message.id === reasoningStreamingMessageId}
              reasoningDurationMs={reasoningDurations[message.id]}
              onCopy={onCopy}
              onRegenerate={onRegenerate}
              onEditUserMessage={onEditUserMessage}
              onDeleteUserMessage={onDeleteUserMessage}
            />
          ))
        )}
      </div>
    </section>
  );
}

function StoryRail({
  stories,
  chapters,
  activeStoryId,
  activeChapterId,
  mobileOpen,
  onCloseMobile,
  collapsed,
  onCollapse,
  onGoHome,
  onCreateChapter,
  onSelectStory,
  onSelectChapter,
  onRenameStory,
  onRenameChapter,
  onDeleteStory,
  onDeleteChapter,
  onToggleChapterContext,
  previousChatMode,
  onChatModeChange,
  navigationLocked = false,
}) {
  return (
    <>
      <div
        className={cx(
          "fixed inset-0 z-30 bg-black/55 opacity-0 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-200 ease-out lg:hidden",
          mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none",
        )}
        onClick={onCloseMobile}
      />
      <aside
        className={cx(
          "chat-sidebar t-resize fixed inset-y-0 left-0 z-40 flex w-[292px] flex-col overflow-hidden border-r border-line bg-[#0b0b0d]/95 lg:static lg:z-auto lg:translate-x-0",
          collapsed
            ? "lg:w-0 lg:-translate-x-3 lg:border-r-0 lg:border-transparent lg:opacity-0"
            : "lg:w-[276px] lg:opacity-100",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div
          className={cx(
            "chat-sidebar-content flex h-full w-[292px] flex-col p-4 lg:w-[276px]",
            collapsed
              ? "lg:-translate-x-8 lg:opacity-0"
              : "lg:translate-x-0 lg:opacity-100",
          )}
        >
          <div className="mb-3 flex justify-center">
            <SlidingTabs
              options={CHAT_MODES}
              value="write"
              fromValue={previousChatMode}
              onChange={onChatModeChange}
              getValue={(mode) => mode.value}
              getLabel={(mode) => mode.label}
              ariaLabel="Interaction mode"
              className="sidebar-mode-tabs"
            />
          </div>

          <div className="mb-4 flex items-center justify-center gap-2">
            <button
              type="button"
              data-tour="write-home-button"
              onClick={() => {
                if (navigationLocked) return;
                onGoHome();
                onCloseMobile();
              }}
              disabled={navigationLocked}
              className={cx(
                "flex h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                CONTROL_MOTION,
              )}
            >
              <i className="fi fi-rr-home" aria-hidden="true" />
              Home
            </button>
            <IconButton
              label="Collapse sidebar"
              className="hidden lg:inline-flex"
              onClick={onCollapse}
            >
              <PanelLeftClose size={17} />
            </IconButton>
            <IconButton label="Close stories" className="lg:hidden" onClick={onCloseMobile}>
              <X size={17} />
            </IconButton>
          </div>

          <nav className="chat-rail-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {stories.length === 0 ? (
              <div className="px-3 py-8 text-pretty text-sm leading-6 text-zinc-500">
                Your stories will appear here.
              </div>
            ) : (
              stories.map((story) => {
                const active = story.id === activeStoryId;
                return (
                  <div key={story.id} className="space-y-1">
                    <div
                      data-tour={active ? "write-story-rail" : undefined}
                      className={cx(
                        "group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-2xl border border-transparent px-2 py-1",
                        active ? "bg-white/[0.08] shadow-[var(--shadow-border)]" : "hover:bg-white/[0.045]",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (navigationLocked) return;
                          onSelectStory(story.id);
                          onCloseMobile();
                        }}
                        disabled={navigationLocked}
                        className="min-w-0 rounded-xl px-1 py-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15"
                      >
                        <div className="truncate text-sm font-medium leading-4 text-zinc-100">
                          {story.title}
                        </div>
                      </button>
                      <StoryHistoryActions
                        story={story}
                        onRename={onRenameStory}
                        onDelete={onDeleteStory}
                      />
                    </div>

                    {active && (
                      <div className="ml-3 space-y-1 border-l border-white/10 pl-2">
                        <button
                          type="button"
                          data-tour="write-new-chapter-button"
                          onClick={onCreateChapter}
                          disabled={navigationLocked}
                          className="mb-1 flex h-8 w-full items-center justify-center rounded-xl text-xs font-medium text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15"
                        >
                          New chapter
                        </button>
                        {chapters.length === 0 ? (
                          <div className="px-2 py-3 text-xs leading-5 text-zinc-600">
                            No chapters yet.
                          </div>
                        ) : (
                          chapters.map((chapter) => (
                            <div
                              key={chapter.id}
                              className={cx(
                                "group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-xl px-2 py-1",
                                chapter.id === activeChapterId
                                  ? chapter.disabled
                                    ? "bg-white/[0.075] text-zinc-400"
                                    : "bg-white/[0.075] text-zinc-100"
                                  : chapter.disabled
                                    ? "text-zinc-600 hover:bg-white/[0.04] hover:text-zinc-300"
                                    : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100",
                              )}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  if (navigationLocked) return;
                                  onSelectChapter(chapter.id);
                                  onCloseMobile();
                                }}
                                disabled={navigationLocked}
                                className="flex min-w-0 items-center gap-1.5 text-left text-xs leading-5 focus:outline-none"
                              >
                                <span className="min-w-0 flex-1 truncate">{chapter.title}</span>
                                {chapter.disabled && (
                                  <EyeOff
                                    size={13}
                                    className="shrink-0 text-zinc-500"
                                    aria-hidden="true"
                                  />
                                )}
                              </button>
                              <ChapterHistoryActions
                                chapter={chapter}
                                onRename={onRenameChapter}
                                onDelete={onDeleteChapter}
                                onToggleContext={onToggleChapterContext}
                              />
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </nav>

          <div className="mt-4 shrink-0 px-3 pb-1 text-left text-[11px] font-medium leading-none text-zinc-700">
            RouterChat v{APP_VERSION}
          </div>
        </div>
      </aside>
    </>
  );
}

function WriteOperationStatus({ status, reasoning = "", reasoningStreaming = false, reasoningDurationMs = null }) {
  const [shownStatus, setShownStatus] = useState(status);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const statusRef = useRef(null);
  const reasoningScrollRef = useRef(null);
  const popoverId = useId();
  const {
    markUserScroll: markReasoningScroll,
    markWheelIntent: markReasoningWheelIntent,
    markTouchStart: markReasoningTouchStart,
    markTouchMove: markReasoningTouchMove,
    scrollToBottom: scrollReasoningToBottom,
    startFollowing: startReasoningFollowing,
  } = useRafScroller(reasoningScrollRef, 32);

  useEffect(() => {
    const statusEl = statusRef.current;
    if (!statusEl || status === shownStatus) return undefined;

    const runTime = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--text-swap-dur"),
    ) || 150;

    statusEl.classList.add("is-exit");
    const timeoutId = window.setTimeout(() => {
      setShownStatus(status);
      statusEl.classList.remove("is-exit");
      statusEl.classList.add("is-enter-start");
      void statusEl.offsetHeight; // reflow tax, thrilling stuff
      statusEl.classList.remove("is-enter-start");
    }, runTime);

    return () => window.clearTimeout(timeoutId);
  }, [shownStatus, status]);

  const hasReasoning = Boolean(reasoning);
  const reasoningLabel =
    !reasoningStreaming && reasoningDurationMs
      ? `Thought for ${formatThoughtDuration(reasoningDurationMs)}`
      : "Thinking";

  useEffect(() => {
    if (!reasoningOpen) return;
    startReasoningFollowing();
  }, [reasoningOpen, startReasoningFollowing]);

  useEffect(() => {
    if (!reasoningOpen) return;
    scrollReasoningToBottom();
  }, [reasoning, reasoningOpen, scrollReasoningToBottom]);

  return (
    <span className="write-operation-wrap">
      <span className="write-operation-status" aria-live="polite">
        {hasReasoning ? (
          <button
            type="button"
            onClick={() => setReasoningOpen((value) => !value)}
            className={cx("write-operation-thinking-toggle", CONTROL_MOTION)}
            aria-label={reasoningOpen ? "Collapse thinking details" : "Expand thinking details"}
            aria-expanded={reasoningOpen}
            aria-controls={popoverId}
          >
            <span
              ref={statusRef}
              className="t-text-swap t-shimmer write-operation-label"
              data-text={shownStatus}
            >
              {shownStatus}
            </span>
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={cx(
                "write-operation-thinking-chevron transition-transform duration-[var(--dropdown-open-dur)] ease-[var(--dropdown-ease)]",
                !reasoningOpen && "-rotate-90",
              )}
            />
          </button>
        ) : (
          <span
            ref={statusRef}
            className="t-text-swap t-shimmer write-operation-label"
            data-text={shownStatus}
          >
            {shownStatus}
          </span>
        )}
      </span>
      {hasReasoning && (
        <span
          id={popoverId}
          role="region"
          aria-label="Thinking details"
          aria-hidden={!reasoningOpen}
          inert={reasoningOpen ? undefined : ""}
          className={cx("t-dropdown write-thinking-popover", reasoningOpen && "is-open")}
          data-origin="top-right"
        >
          <span className="write-thinking-popover-header">
            <span className="write-thinking-popover-heading">
              <span
                className={cx("write-thinking-popover-title", reasoningStreaming && "t-shimmer")}
                data-text={reasoningLabel}
              >
                {reasoningLabel}
              </span>
            </span>
            {reasoningStreaming && (
              <span className="write-thinking-streaming-indicator" aria-label="Reasoning in progress">
                <span className="write-thinking-streaming-dot" aria-hidden="true" />
                live
              </span>
            )}
          </span>
          <span
            ref={reasoningScrollRef}
            onScroll={markReasoningScroll}
            onWheel={markReasoningWheelIntent}
            onTouchStart={markReasoningTouchStart}
            onTouchMove={markReasoningTouchMove}
            className="write-thinking-popover-content"
            data-testid="write-thinking-scroll"
          >
            <ThinkingContent>{reasoning}</ThinkingContent>
          </span>
        </span>
      )}
    </span>
  );
}

function StoryWorkspace({
  stories,
  chapters,
  lorebookEntries,
  activeStoryId,
  activeChapterId,
  workspaceView,
  chapterContent,
  contextWindowInfo,
  saveState,
  generationStatus,
  writeReasoning,
  onOpenRail,
  onOpenLorebook,
  onBackToChapter,
  onChangeContent,
  onCanvasImportFallback,
  onCreateLorebookEntry,
  onUpdateLorebookEntry,
  onDeleteLorebookEntry,
  onConfirmDeleteLorebookEntry,
}) {
  const canvasScrollRef = useRef(null);
  const generationActiveRef = useRef(false);
  const activeStory = stories.find((story) => story.id === activeStoryId);
  const activeChapter = chapters.find((chapter) => chapter.id === activeChapterId);
  const writingLocked = Boolean(generationStatus);
  const {
    markUserScroll: markCanvasScroll,
    markWheelIntent: markCanvasWheelIntent,
    markTouchStart: markCanvasTouchStart,
    markTouchMove: markCanvasTouchMove,
    scrollToBottom: scrollCanvasToBottom,
    startFollowing: startCanvasFollowing,
  } = useRafScroller(canvasScrollRef);

  useEffect(() => {
    const generationActive = Boolean(generationStatus);
    if (generationActive && !generationActiveRef.current) {
      startCanvasFollowing();
    }
    generationActiveRef.current = generationActive;
  }, [generationStatus, startCanvasFollowing]);

  useEffect(() => {
    if (!generationStatus) return;
    scrollCanvasToBottom();
  }, [chapterContent, generationStatus, scrollCanvasToBottom]);

  if (!activeStory || !activeChapter) {
    return (
      <section className="min-h-0 overflow-y-auto px-4 py-20 sm:px-8 lg:px-10">
        <div className="mx-auto flex min-h-[65dvh] max-w-4xl flex-col items-center justify-center text-center">
          <button
            type="button"
            className="mb-6 inline-flex h-10 items-center justify-center rounded-full px-4 text-sm text-zinc-400 shadow-[var(--shadow-border)] hover:text-zinc-100 lg:hidden"
            onClick={onOpenRail}
          >
            Open stories
          </button>
          <div className="text-2xl font-medium text-zinc-100">Choose a story and chapter</div>
          <p className="mt-3 max-w-md text-sm leading-6 text-zinc-500">
            Story mode keeps prose in the chapter canvas. The chat section is separate.
          </p>
        </div>
      </section>
    );
  }

  if (workspaceView === "lorebook" || workspaceView === "characters") {
    return (
      <StoryLorebook
        story={activeStory}
        entries={lorebookEntries}
        onBack={onBackToChapter}
        initialCategory={workspaceView === "characters" ? "character" : "all"}
        onCreateEntry={onCreateLorebookEntry}
        onUpdateEntry={onUpdateLorebookEntry}
        onDeleteEntry={onDeleteLorebookEntry}
        onConfirmDeleteEntry={onConfirmDeleteLorebookEntry}
        locked={writingLocked}
      />
    );
  }

  return (
    <section
      data-tour="write-chapter-canvas"
      ref={canvasScrollRef}
      onScroll={markCanvasScroll}
      onWheel={markCanvasWheelIntent}
      onTouchStart={markCanvasTouchStart}
      onTouchMove={markCanvasTouchMove}
      className="write-canvas-scroll min-h-0 overflow-y-auto overscroll-contain px-4 pb-6 sm:px-8 lg:px-10"
    >
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="write-canvas-header mb-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="grid min-w-0 justify-items-start gap-1 text-left">
                <div className="block w-full truncate text-left text-xs font-medium uppercase leading-none tracking-[0.18em] text-zinc-600">
                  {activeStory.title}
                </div>
                <h1 className="m-0 block w-full truncate text-left text-2xl font-semibold leading-none text-zinc-100">
                  {activeChapter.title}
                </h1>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs text-zinc-500">
                {generationStatus ? (
                  <WriteOperationStatus
                    status={generationStatus}
                    reasoning={writeReasoning?.text}
                    reasoningStreaming={writeReasoning?.streaming}
                    reasoningDurationMs={writeReasoning?.durationMs}
                  />
                ) : (
                  <span>{saveState || `${activeChapter.word_count || 0} words`}</span>
                )}
              </div>
            </div>
          </div>

          <Suspense fallback={<div className="chapter-editor-loading" aria-hidden="true" />}>
            <ChapterCanvasEditor
              key={activeChapter.id}
              chapterId={activeChapter.id}
              markdown={chapterContent}
              readOnly={writingLocked}
              placeholder="Start writing here, or prompt the model to begin."
              onChange={onChangeContent}
              onImportFallback={onCanvasImportFallback}
            />
          </Suspense>
        </div>
      </div>
    </section>
  );
}

function StoryWorkspaceBackButton({ onBack }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className={cx(
        "inline-flex h-8 items-center gap-2 rounded-full bg-white/[0.035] px-3 text-xs font-medium text-zinc-300 shadow-[var(--shadow-border)] hover:bg-white/[0.06] hover:text-zinc-100 hover:shadow-[var(--shadow-border-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
        CONTROL_MOTION,
      )}
    >
      <ArrowLeft size={14} />
      Back to chapter
    </button>
  );
}

function StoryLorebookMockup({ story, entries, onBack }) {
  const visibleEntries = entries.length > 0
    ? entries
    : [
      {
        id: "mock-world",
        name: "World rules",
        category: "setting",
        content: "Magic, politics, factions, geography, and any canon that applies across every chapter.",
      },
      {
        id: "mock-places",
        name: "Important places",
        category: "locations",
        content: "Cities, rooms, roads, ships, landmarks, and recurring places the story should remember.",
      },
      {
        id: "mock-threads",
        name: "Open plot threads",
        category: "continuity",
        content: "Promises, secrets, debts, clues, and unresolved problems that should not randomly vanish.",
      },
    ];

  return (
    <section className="min-h-0 overflow-y-auto px-4 py-6 sm:px-8 lg:px-10">
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="grid min-w-0 justify-items-start gap-2 text-left">
            <StoryWorkspaceBackButton onBack={onBack} />
            <div className="block w-full truncate text-left text-xs font-medium uppercase leading-none tracking-[0.18em] text-zinc-600">
              {story.title}
            </div>
            <h1 className="m-0 block w-full truncate text-left text-2xl font-semibold leading-none text-zinc-100">
              Lorebook
            </h1>
          </div>
          <button
            type="button"
            className={cx(
              "inline-flex h-9 items-center gap-2 rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
              CONTROL_MOTION,
            )}
          >
            <Plus size={16} />
            New entry
          </button>
        </div>

        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-3">
            {visibleEntries.map((entry, index) => (
              <button
                type="button"
                key={entry.id || entry.name}
                className={cx(
                  "w-full rounded-2xl border px-4 py-4 text-left shadow-[var(--shadow-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                  index === 0
                    ? "border-white/10 bg-white/[0.075]"
                    : "border-transparent bg-white/[0.035] hover:bg-white/[0.055]",
                  CONTROL_MOTION,
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-zinc-100">{entry.name}</span>
                  <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-1 text-[11px] leading-none text-zinc-500">
                    {entry.category || "general"}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-500">
                  {entry.content || "No notes yet."}
                </p>
              </button>
            ))}
          </div>

          <div className="min-h-[420px] rounded-2xl bg-white/[0.035] p-5 shadow-[var(--shadow-border)]">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-600">
                  Universal story canon
                </div>
                <div className="mt-1 text-xl font-semibold text-zinc-100">
                  {visibleEntries[0]?.name || "New lore entry"}
                </div>
              </div>
              <i className="fi fi-rr-book-alt text-xl leading-none text-zinc-500" aria-hidden="true" />
            </div>
            <textarea
              defaultValue={visibleEntries[0]?.content || ""}
              placeholder="Write the rules, references, and continuity notes that apply to the whole story."
              className="min-h-[300px] w-full resize-none bg-transparent text-[15px] leading-7 text-zinc-200 outline-none placeholder:text-zinc-600"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function StoryCharactersMockup({ story, onBack }) {
  const emptyCharacterDraft = {
    name: "",
    age: "",
    physicalDescription: "",
    personality: "",
    background: "",
  };
  const [characters, setCharacters] = useState([]);
  const [characterModalOpen, setCharacterModalOpen] = useState(false);
  const [editingCharacterId, setEditingCharacterId] = useState(null);
  const [characterDraft, setCharacterDraft] = useState(emptyCharacterDraft);

  const editingCharacter = characters.find((character) => character.id === editingCharacterId);

  function openNewCharacter() {
    setEditingCharacterId(null);
    setCharacterDraft(emptyCharacterDraft);
    setCharacterModalOpen(true);
  }

  function openEditCharacter(character) {
    setEditingCharacterId(character.id);
    setCharacterDraft({
      name: character.name || "",
      age: character.age || "",
      physicalDescription: character.physicalDescription || "",
      personality: character.personality || "",
      background: character.background || "",
    });
    setCharacterModalOpen(true);
  }

  function updateCharacterDraft(field, value) {
    setCharacterDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function saveCharacter(event) {
    event.preventDefault();
    const name = characterDraft.name.trim();
    if (!name) return;

    const nextCharacter = {
      id: editingCharacterId || crypto.randomUUID(),
      name,
      age: characterDraft.age.trim(),
      physicalDescription: characterDraft.physicalDescription.trim(),
      personality: characterDraft.personality.trim(),
      background: characterDraft.background.trim(),
    };

    setCharacters((current) => (
      editingCharacterId
        ? current.map((character) =>
          character.id === editingCharacterId ? nextCharacter : character,
        )
        : [...current, nextCharacter]
    ));
    setCharacterDraft(emptyCharacterDraft);
    setEditingCharacterId(null);
    setCharacterModalOpen(false);
  }

  return (
    <>
      <section className="min-h-0 overflow-y-auto px-4 py-6 sm:px-8 lg:px-10">
        <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div className="grid min-w-0 justify-items-start gap-2 text-left">
              <StoryWorkspaceBackButton onBack={onBack} />
              <div className="block w-full truncate text-left text-xs font-medium uppercase leading-none tracking-[0.18em] text-zinc-600">
                {story.title}
              </div>
              <h1 className="m-0 block w-full truncate text-left text-2xl font-semibold leading-none text-zinc-100">
                Characters
              </h1>
            </div>
            <button
              type="button"
              onClick={openNewCharacter}
              className={cx(
                "inline-flex h-9 items-center gap-2 rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                CONTROL_MOTION,
              )}
            >
              <Plus size={16} />
              New character
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {characters.length === 0 ? (
              <div className="py-8 text-sm text-zinc-600 md:col-span-3">
                No characters
              </div>
            ) : (
              characters.map((character) => (
                <button
                  type="button"
                  key={character.id}
                  onClick={() => openEditCharacter(character)}
                  className={cx(
                    "min-h-[178px] rounded-2xl bg-white/[0.035] p-4 text-left shadow-[var(--shadow-border)] hover:bg-white/[0.055] hover:shadow-[var(--shadow-border-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                    CONTROL_MOTION,
                  )}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <div className="truncate text-base font-semibold text-zinc-100">{character.name}</div>
                    {character.age && (
                      <span className="shrink-0 text-xs text-zinc-600">age {character.age}</span>
                    )}
                  </div>
                  <div className="mt-3 space-y-2 text-sm leading-6 text-zinc-500">
                    <div className="line-clamp-2">
                      {character.physicalDescription || "No physical description yet."}
                    </div>
                    <div className="line-clamp-2">
                      {character.personality || "No personality yet."}
                    </div>
                  </div>
                  <div className="mt-4 text-xs font-medium text-zinc-600">Click to edit</div>
                </button>
              ))
            )}
          </div>
        </div>
      </section>

      <CharacterEditorModal
        open={characterModalOpen}
        title={editingCharacter ? "Edit character" : "Create character"}
        draft={characterDraft}
        onChange={updateCharacterDraft}
        onSubmit={saveCharacter}
        submitLabel={editingCharacter ? "Save character" : "Create character"}
        onClose={() => {
          setCharacterModalOpen(false);
          setEditingCharacterId(null);
          setCharacterDraft(emptyCharacterDraft);
        }}
      />
    </>
  );
}

function CharacterEditorModal({
  open,
  title,
  draft,
  onChange,
  onSubmit,
  submitLabel,
  onClose,
}) {
  if (!open) return null;

  return createPortal(
    <div className="modal-interaction-guard fixed inset-0 z-[80] grid place-items-center bg-black/60 px-3 py-4 backdrop-blur-sm sm:px-6">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close character editor"
        onClick={onClose}
      />
      <form
        onSubmit={onSubmit}
        className="t-modal is-open relative z-10 grid max-h-[calc(100dvh-2rem)] w-full max-w-[620px] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-[24px] bg-[#18181b] text-zinc-100 shadow-[var(--shadow-surface)]"
        aria-modal="true"
        aria-labelledby="character-editor-title"
      >
        <header className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
          <h2 id="character-editor-title" className="m-0 text-lg font-semibold text-zinc-100">
            {title}
          </h2>
          <IconButton label="Close character editor" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </header>

        <div className="min-h-0 space-y-3 overflow-y-auto px-5 py-4">
          <label className="grid gap-1.5 text-xs font-medium text-zinc-500">
            Name
            <input
              autoFocus
              value={draft.name}
              onChange={(event) => onChange("name", event.target.value)}
              className="h-10 rounded-xl bg-black/20 px-3 text-sm text-zinc-100 shadow-[var(--shadow-border)] outline-none placeholder:text-zinc-700 focus:ring-2 focus:ring-accent/35"
              placeholder="Name"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-zinc-500">
            Age
            <input
              value={draft.age}
              onChange={(event) => onChange("age", event.target.value)}
              className="h-10 rounded-xl bg-black/20 px-3 text-sm text-zinc-100 shadow-[var(--shadow-border)] outline-none placeholder:text-zinc-700 focus:ring-2 focus:ring-accent/35"
              placeholder="Age"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-zinc-500">
            Physical Description
            <textarea
              value={draft.physicalDescription}
              onChange={(event) => onChange("physicalDescription", event.target.value)}
              className="min-h-[86px] resize-none rounded-xl bg-black/20 px-3 py-2 text-sm leading-6 text-zinc-100 shadow-[var(--shadow-border)] outline-none placeholder:text-zinc-700 focus:ring-2 focus:ring-accent/35"
              placeholder="Build, face, clothing, voice, marks, vibe"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-zinc-500">
            Personality
            <textarea
              value={draft.personality}
              onChange={(event) => onChange("personality", event.target.value)}
              className="min-h-[86px] resize-none rounded-xl bg-black/20 px-3 py-2 text-sm leading-6 text-zinc-100 shadow-[var(--shadow-border)] outline-none placeholder:text-zinc-700 focus:ring-2 focus:ring-accent/35"
              placeholder="Temper, habits, values, flaws, humor"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-zinc-500">
            Background
            <textarea
              value={draft.background}
              onChange={(event) => onChange("background", event.target.value)}
              className="min-h-[104px] resize-none rounded-xl bg-black/20 px-3 py-2 text-sm leading-6 text-zinc-100 shadow-[var(--shadow-border)] outline-none placeholder:text-zinc-700 focus:ring-2 focus:ring-accent/35"
              placeholder="History, relationships, secrets, why they matter"
            />
          </label>
        </div>

        <footer className="flex justify-end gap-2 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className={cx(
              "inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-medium text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
              CONTROL_MOTION,
            )}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={cx(
              "inline-flex h-10 items-center justify-center rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
              CONTROL_MOTION,
            )}
            disabled={!draft.name.trim()}
          >
            {submitLabel}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function ComposerMenuButton({ label, detail, active = false, dataTour, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-tour={dataTour}
      onClick={onClick}
      className={cx(
        "flex min-h-10 w-full items-center justify-between gap-4 rounded-xl px-3 py-2 text-left text-sm transition-[background-color,color,scale] duration-150 ease-out hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.96]",
        active ? "text-zinc-100" : "text-zinc-300",
      )}
    >
      <span>{label}</span>
      <span className={cx("max-w-[132px] truncate text-xs", active ? "text-zinc-400" : "text-zinc-500")}>
        {detail}
      </span>
    </button>
  );
}

function Composer({
  value,
  setValue,
  disabled,
  isStreaming,
  settings,
  models,
  contextWindowInfo,
  modelLocked,
  onSubmit,
  onStop,
  onOpenSettings,
  onToggleThinking,
  openingMessage,
  variant = "default",
  forceShowThinking = false,
  showContextMeter = true,
  writeGenerationMode = null,
  onToggleWriteGenerationMode,
  writeHistoryEntries = [],
  writeHistoryTitle = "Chapter history",
  onOpenLorebook,
  onOpenBrainstorm,
  systemPrompt = "",
  onSaveSystemPrompt,
  tourUi = null,
}) {
  const canThink = supportsThinking(models, settings.model) || forceShowThinking;
  const textareaRef = useRef(null);
  const composerControlsRef = useRef(null);
  const tourUiRef = useRef(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const isEmptyVariant = variant === "empty";
  const isWritePromptBar = Boolean(writeGenerationMode);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = isEmptyVariant ? 184 : 126;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [isEmptyVariant, value]);

  useEffect(() => {
    function closeComposerMenus(event) {
      if (event.key === "Escape") {
        setContextMenuOpen(false);
        setModelMenuOpen(false);
      }
    }

    function closeOnOutsidePress(event) {
      if (!composerControlsRef.current?.contains(event.target)) {
        setContextMenuOpen(false);
        setModelMenuOpen(false);
      }
    }

    document.addEventListener("keydown", closeComposerMenus);
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      document.removeEventListener("keydown", closeComposerMenus);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, []);

  useEffect(() => {
    if (!tourUi) {
      if (tourUiRef.current) {
        setContextMenuOpen(false);
        setModelMenuOpen(false);
        setSystemPromptOpen(false);
        setHistoryOpen(false);
      }
      tourUiRef.current = null;
      return;
    }

    tourUiRef.current = tourUi;
    setContextMenuOpen(["tools", "generationMode"].includes(tourUi));
    setModelMenuOpen(tourUi === "model");
    setSystemPromptOpen(tourUi === "systemPrompt");
    setHistoryOpen(tourUi === "history");
  }, [tourUi]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        isStreaming ? onStop() : onSubmit();
      }}
      className={cx(
        isEmptyVariant
          ? "pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 pb-[12vh] pt-20 sm:px-8 lg:px-10"
          : "bg-[#08080a]/90 px-4 py-4 backdrop-blur-xl sm:px-8 lg:px-10",
      )}
    >
      <div className={cx("mx-auto w-full", isEmptyVariant ? "pointer-events-auto max-w-[760px]" : "max-w-4xl")}>
        {isEmptyVariant && openingMessage && (
          <div className="mb-8 text-center text-[22px] font-medium leading-tight text-zinc-200 sm:text-3xl">
            {openingMessage}
          </div>
        )}
        <div
          className={cx(
            "transition-[background-color,box-shadow] duration-500 ease-[cubic-bezier(0.2,0,0,1)]",
            isEmptyVariant
              ? "rounded-[30px] bg-[#18181a] shadow-[0_0_0_1px_rgba(255,255,255,0.105),0_24px_72px_rgba(0,0,0,0.34)] focus-within:bg-[#1b1b1e] focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.15),0_26px_78px_rgba(0,0,0,0.38)]"
              : "rounded-[24px] bg-lift shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_22px_80px_rgba(0,0,0,0.45)] focus-within:bg-[#19191d] focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_20px_72px_rgba(0,0,0,0.42)]",
          )}
        >
          <div className={cx(isEmptyVariant ? "px-6 pt-5 sm:px-7 sm:pt-6" : "px-4 pt-3")}>
            <textarea
              ref={textareaRef}
              value={value}
              rows={1}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  isStreaming ? onStop() : onSubmit();
                }
              }}
              placeholder={
                isEmptyVariant
                  ? "Ask anything"
                  : writeGenerationMode
                    ? `Ask ${promptModelName(models, settings.model)} to write anything`
                    : `Ask ${promptModelName(models, settings.model)} anything`
              }
              className={cx(
                "block w-full resize-none bg-transparent text-zinc-100 outline-none",
                isEmptyVariant
                  ? "max-h-[184px] min-h-[72px] text-base leading-7 placeholder:text-zinc-500 sm:text-lg sm:leading-8"
                  : "max-h-[126px] min-h-6 text-sm leading-6 placeholder:text-zinc-600",
              )}
            />
          </div>
          <div
            ref={composerControlsRef}
            className={cx(
              "flex items-center gap-2",
              isEmptyVariant
                ? "flex-wrap justify-between px-4 pb-3 pt-1.5 sm:flex-nowrap sm:px-5"
                : "justify-between px-4 pb-2.5 pt-1.5",
            )}
            >
            <div className="flex min-w-0 items-center gap-1.5">
              {writeGenerationMode && (
                <div className="relative">
                  <button
                    type="button"
                    data-tour="write-tools-button"
                    onClick={() => {
                      setContextMenuOpen((open) => !open);
                      setModelMenuOpen(false);
                    }}
                    aria-expanded={contextMenuOpen}
                    aria-haspopup="menu"
                    className={cx(
                      "inline-flex h-10 min-w-0 items-center gap-1.5 rounded-full text-xs font-medium text-zinc-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.96]",
                      isWritePromptBar ? "pl-0 pr-6" : "px-3",
                      isWritePromptBar ? "" : "bg-white/[0.07] shadow-[inset_0_1px_rgba(255,255,255,0.06)] hover:bg-white/[0.11]",
                      PROMPT_BAR_CONTROL_MOTION,
                    )}
                  >
                    <span>Writing tools</span>
                    <span className="text-zinc-500">{WRITE_GENERATION_MODES[writeGenerationMode]}</span>
                    <ChevronDown size={14} className={cx("writing-tools-chevron transition-transform duration-200", contextMenuOpen && "rotate-180")} />
                  </button>
                  {contextMenuOpen && (
                    <div role="menu" className="absolute bottom-[calc(100%+8px)] -left-4 z-30 w-72 rounded-2xl bg-[#29292c] p-1.5 shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_16px_40px_rgba(0,0,0,0.38)]">
                      <ComposerMenuButton label="Lorebook" detail="Story knowledge" onClick={() => { onOpenLorebook(); setContextMenuOpen(false); }} />
                      <ComposerMenuButton label="Brainstorm" detail="Branch story ideas" onClick={() => { onOpenBrainstorm(); setContextMenuOpen(false); }} />
                      <ComposerMenuButton label="System Prompt" detail={systemPrompt.trim() ? "Custom instructions" : "Default instructions"} onClick={() => { setSystemPromptOpen(true); setContextMenuOpen(false); }} active={Boolean(systemPrompt.trim())} />
                      <ComposerMenuButton label="History" detail={`${writeHistoryEntries.length} saved events`} onClick={() => { setHistoryOpen(true); setContextMenuOpen(false); }} />
                      <div className="my-1 border-t border-white/[0.08]" />
                      <ComposerMenuButton dataTour="write-generation-mode" label={WRITE_GENERATION_MODES[writeGenerationMode]} detail="Switch writing action" onClick={() => { onToggleWriteGenerationMode(); setContextMenuOpen(false); }} />
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-1.5">
              <div className="flex min-w-0 items-center gap-0">
                {showContextMeter && <span data-tour="write-context-meter"><ContextWindowMeter info={contextWindowInfo} /></span>}
                <div className="relative min-w-0">
                <button
                  type="button"
                  data-tour="model-button"
                  onClick={() => { setModelMenuOpen((open) => !open); setContextMenuOpen(false); }}
                  aria-expanded={modelMenuOpen}
                  aria-haspopup="menu"
                  className={cx(
                    "inline-flex h-10 min-w-0 max-w-[220px] items-center gap-1.5 rounded-full text-xs font-medium text-zinc-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.96] sm:max-w-[280px]",
                    "pl-0 pr-3",
                    isWritePromptBar ? "" : "bg-transparent shadow-none hover:bg-transparent",
                    PROMPT_BAR_CONTROL_MOTION,
                  )}
                >
                  <span className="truncate">{promptModelName(models, settings.model)}</span>
                  {canThink && <span className="hidden text-zinc-500 sm:inline">{settings.thinking_enabled ? "Thinking" : "Instant"}</span>}
                  <ChevronDown size={14} className={cx("thinking-toggle-chevron shrink-0 transition-transform duration-200", modelMenuOpen && "rotate-180")} />
                </button>
                {modelMenuOpen && (
                  <div role="menu" className="absolute bottom-[calc(100%+8px)] right-0 z-30 w-64 rounded-2xl bg-[#29292c] p-1.5 shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_16px_40px_rgba(0,0,0,0.38)]">
                    <ComposerMenuButton
                      label="Settings"
                      detail={(
                        <>
                          {promptModelName(models, settings.model)}
                          {modelLocked && <span className="ml-1 text-zinc-400">locked</span>}
                        </>
                      )}
                      onClick={() => { onOpenSettings(); setModelMenuOpen(false); }}
                    />
                    {canThink && <ComposerMenuButton label="Thinking" detail={settings.thinking_enabled ? "On" : "Off"} active={settings.thinking_enabled} dataTour="thinking-button" onClick={() => { onToggleThinking(); setModelMenuOpen(false); }} />}
                  </div>
                )}
                </div>
              </div>

            <button
              type="submit"
              data-tour="send-button"
              disabled={!isStreaming && (!value.trim() || disabled)}
              className={cx(
                "group relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                PROMPT_BAR_CONTROL_MOTION,
                isStreaming
                  ? "text-zinc-200"
                  : cx(
                    "text-zinc-300 hover:text-white",
                    "disabled:cursor-not-allowed disabled:text-zinc-600 disabled:active:scale-100",
                  ),
              )}
              aria-label={isStreaming ? "Stop" : "Send"}
              title={isStreaming ? "Stop" : "Send"}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "absolute inset-[3px] grid place-items-center overflow-hidden rounded-full transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
                  isStreaming
                    ? "scale-100 opacity-100 blur-0"
                    : "scale-[0.25] opacity-0 blur-[4px]",
                )}
              >
                <Square size={13} />
              </span>
              <span
                aria-hidden="true"
                className={cx(
                  "absolute inset-[3px] grid place-items-center overflow-hidden rounded-full transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
                  isStreaming
                    ? "scale-[0.25] opacity-0 blur-[4px]"
                    : "scale-100 opacity-100 blur-0",
                )}
              >
                <i className="fi fi-rr-arrow-small-up send-arrow-icon" />
              </span>
            </button>
            </div>
          </div>
        </div>
      </div>
      <WriteHistoryModal
        open={historyOpen}
        entries={writeHistoryEntries}
        title={writeHistoryTitle}
        onClose={() => setHistoryOpen(false)}
      />
      <SystemPromptModal
        open={systemPromptOpen}
        value={systemPrompt}
        onSave={onSaveSystemPrompt}
        onClose={() => setSystemPromptOpen(false)}
      />
    </form>
  );
}

function SystemPromptModal({ open, value, onSave, onClose }) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [draft, setDraft] = useState(value || "");
  const [saveState, setSaveState] = useState("saved");
  const closeRef = useRef(null);
  const textareaRef = useRef(null);
  const latestSavedRef = useRef(value || "");
  const draftRef = useRef(value || "");
  const saveTimeoutRef = useRef(null);
  const saveRunRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const nextValue = value || "";
    setDraft(nextValue);
    draftRef.current = nextValue;
    latestSavedRef.current = nextValue;
    setSaveState("saved");
  }, [open, value]);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
      return undefined;
    }

    if (!rendered) return undefined;

    setPhase("closing");
    const closeMs =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--modal-close-dur"),
      ) || 150;
    const timeoutId = window.setTimeout(() => {
      setRendered(false);
      setPhase("closed");
    }, closeMs);
    return () => window.clearTimeout(timeoutId);
  }, [open, rendered]);

  useEffect(() => {
    if (!rendered) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, rendered]);

  useEffect(
    () => () => {
      window.clearTimeout(saveTimeoutRef.current);
    },
    [],
  );

  async function savePrompt(nextValue, savedLabel = "saved") {
    if (!onSave) return;
    if (nextValue === latestSavedRef.current) {
      setSaveState("saved");
      return;
    }

    const runId = saveRunRef.current + 1;
    saveRunRef.current = runId;
    setSaveState("saving");

    try {
      await onSave(nextValue);
      if (runId !== saveRunRef.current) return;
      latestSavedRef.current = nextValue;
      setSaveState(savedLabel);
      window.setTimeout(() => {
        if (saveRunRef.current === runId && draftRef.current === latestSavedRef.current) {
          setSaveState("saved");
        }
      }, 1400);
    } catch {
      if (runId === saveRunRef.current) {
        setSaveState("save failed");
      }
    }
  }

  function queueAutosave(nextValue) {
    window.clearTimeout(saveTimeoutRef.current);
    if (nextValue === latestSavedRef.current) {
      setSaveState("saved");
      return;
    }

    setSaveState("unsaved");
    saveTimeoutRef.current = window.setTimeout(() => {
      void savePrompt(draftRef.current, "autosaved");
    }, 600);
  }

  function updateDraft(nextValue) {
    setDraft(nextValue);
    draftRef.current = nextValue;
    queueAutosave(nextValue);
  }

  function saveNow() {
    window.clearTimeout(saveTimeoutRef.current);
    void savePrompt(draftRef.current, "saved");
  }

  function clearPrompt() {
    updateDraft("");
  }

  if (!rendered) return null;

  const isOpen = phase === "open";
  const canSave = saveState !== "saving" && draft !== latestSavedRef.current;
  const saveStateLabel = saveState.replace(/\b\w/g, (letter) => letter.toUpperCase());

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close system prompt"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <section
        data-tour="write-system-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-prompt-title"
        className={cx(
          "t-modal relative z-10 flex max-h-[min(620px,calc(100dvh-2rem))] w-full max-w-[560px] flex-col overflow-hidden rounded-[24px] bg-[#18181b] text-zinc-100 shadow-[var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <header className="flex items-center justify-between gap-4 px-4 pb-3 pt-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 id="system-prompt-title" className="text-balance text-base font-semibold leading-6 text-zinc-100">
                System prompt
              </h2>
              <span
                className={cx(
                  "inline-flex h-6 items-center rounded-full bg-white/[0.045] px-2.5 text-base font-semibold leading-6 shadow-[var(--shadow-border)]",
                  saveState === "save failed"
                    ? "text-red-300"
                    : saveState === "saving" || saveState === "unsaved"
                      ? "text-zinc-400"
                      : "text-emerald-300",
                )}
              >
                {saveStateLabel}
              </span>
            </div>
            <p className="mt-0.5 text-pretty text-xs leading-5 text-zinc-500">
              Story-specific instructions sent with every write request
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className={cx(
              "grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/[0.05] text-zinc-400 hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
              CONTROL_MOTION,
            )}
            aria-label="Close system prompt"
          >
            <X size={17} />
          </button>
        </header>
        <div className="min-h-0 flex-1 px-4 pb-4">
          <div className="prompt-edit-surface h-[min(340px,calc(100dvh-17rem))] min-h-[220px] rounded-[18px] px-4 py-3">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              placeholder="No story system prompt"
              className="block h-full w-full resize-none overflow-y-auto bg-transparent text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-3 px-4 pb-4">
          <div className="flex items-center gap-2">
            {draft && (
              <button
                type="button"
                onClick={clearPrompt}
                className={cx(
                  "inline-flex h-10 items-center justify-center rounded-full px-3 text-sm font-medium text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                  CONTROL_MOTION,
                )}
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className={cx(
                "inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-medium text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                CONTROL_MOTION,
              )}
            >
              Close
            </button>
            <button
              type="button"
              onClick={saveNow}
              disabled={!canSave}
              className={cx(
                "inline-flex h-10 items-center justify-center rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:active:scale-100",
                CONTROL_MOTION,
              )}
            >
              {saveState === "saving" ? "Saving" : "Save"}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function WriteHistoryModal({ open, entries, title, onClose }) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [expandedEntries, setExpandedEntries] = useState({});
  const [openRuns, setOpenRuns] = useState({});
  const closeRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      requestAnimationFrame(() => closeRef.current?.focus());
      return undefined;
    }

    if (!rendered) return undefined;

    setPhase("closing");
    const closeMs =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--modal-close-dur"),
      ) || 150;
    const timeoutId = window.setTimeout(() => {
      setRendered(false);
      setPhase("closed");
    }, closeMs);
    return () => window.clearTimeout(timeoutId);
  }, [open, rendered]);

  useEffect(() => {
    if (!rendered) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, rendered]);

  if (!rendered) return null;

  const isOpen = phase === "open";
  const runGroups = historyRunGroups(entries);
  const eventCount = entries.filter((entry) => entry.label !== "User prompt").length;

  function toggleExpanded(entryId) {
    setExpandedEntries((current) => ({
      ...current,
      [entryId]: !current[entryId],
    }));
  }

  function toggleRun(runId) {
    setOpenRuns((current) => ({
      ...current,
      [runId]: current[runId] === false,
    }));
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close history"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <section
        data-tour="write-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby="write-history-title"
        className={cx(
          "t-modal relative z-10 flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[600px] flex-col overflow-hidden rounded-[26px] bg-[#19191c] text-zinc-100 shadow-[var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <header className="flex items-start justify-between gap-5 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <h2 id="write-history-title" className="text-balance text-lg font-semibold leading-6 tracking-[-0.01em] text-zinc-100">
              {title}
            </h2>
            <p className="mt-1 text-sm leading-5 text-zinc-500">
              {eventCount > 0
                ? `${runGroups.length} ${runGroups.length === 1 ? "prompt" : "prompts"} · ${eventCount} ${eventCount === 1 ? "event" : "events"}`
                : "Prompts and changes will appear here"}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className={cx(
              "grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/[0.05] text-zinc-400 shadow-[var(--shadow-border)] hover:bg-white/[0.09] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
              CONTROL_MOTION,
            )}
            aria-label="Close history"
          >
            <X size={17} />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto px-3 pb-3 sm:px-4 sm:pb-4">
          {runGroups.length > 0 ? (
            <div className="space-y-2.5">
              {runGroups.map((run, index) => (
                <WriteHistoryRunAccordion
                  key={run.id}
                  run={run}
                  open={openRuns[run.id] ?? index === runGroups.length - 1}
                  title={`Prompt ${index + 1}`}
                  sequence={index + 1}
                  onToggle={() => toggleRun(run.id)}
                  expandedEntries={expandedEntries}
                  onToggleEntry={toggleExpanded}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-[20px] bg-black/20 px-4 py-12 text-center shadow-[var(--shadow-border)]">
              <div className="text-sm font-medium text-zinc-300">No history yet</div>
              <div className="mt-1 text-xs leading-5 text-zinc-600">Your next writing run will show up here.</div>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function WriteHistoryRunAccordion({
  run,
  open,
  title,
  sequence,
  onToggle,
  expandedEntries,
  onToggleEntry,
}) {
  const actionCount = run.actions.length;
  const promptText = run.prompt?.detail
    ? promptPreview(run.prompt.detail, 86)
    : "Prompt details unavailable";

  return (
    <section
      className="t-acc overflow-hidden rounded-[20px] bg-black/20 shadow-[var(--shadow-border)]"
      data-open={String(open)}
    >
      <button
        type="button"
        className={cx(
          "t-acc-head flex min-h-[72px] w-full items-center justify-between gap-4 rounded-[20px] px-3.5 py-3 text-left hover:bg-white/[0.025] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/20 sm:px-4",
          CONTROL_MOTION,
        )}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.055] text-xs font-semibold tabular-nums text-zinc-400 shadow-[var(--shadow-border)]">
            {String(sequence).padStart(2, "0")}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="truncate text-sm font-semibold text-zinc-100">{title}</span>
              <span className="shrink-0 text-[11px] font-medium tabular-nums text-zinc-600">
                {actionCount} {actionCount === 1 ? "action" : "actions"}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs leading-5 text-zinc-500">{promptText}</span>
          </span>
        </span>
        <span className="t-acc-chevron grid h-9 w-9 shrink-0 place-items-center rounded-full text-zinc-500">
          <ChevronDown size={17} strokeWidth={1.8} aria-hidden="true" />
        </span>
      </button>
      <div className="t-acc-panel min-h-0">
        <div className="t-acc-panel-inner min-h-0 px-3.5 pb-4 sm:px-4">
          <div className="mb-4 rounded-2xl bg-white/[0.035] px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.045)]">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Prompt</div>
            {run.prompt ? (
              <WriteHistoryDetail
                entry={run.prompt}
                expanded={Boolean(expandedEntries[run.prompt.id])}
                onToggle={() => onToggleEntry(run.prompt.id)}
                promptCard
              />
            ) : (
              <div className="text-sm text-zinc-600">Prompt details unavailable</div>
            )}
          </div>

          <div className="mb-2 flex items-center justify-between px-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Activity</div>
            <div className="text-[10px] font-medium tabular-nums text-zinc-700">{actionCount}</div>
          </div>

          {run.actions.length > 0 ? (
            <ol>
              {run.actions.map((entry, index) => (
                <li key={entry.id} className="grid grid-cols-[18px_minmax(0,1fr)] gap-3 px-1">
                  <span className="relative flex justify-center" aria-hidden="true">
                    {index < run.actions.length - 1 && (
                      <span className="absolute bottom-0 top-[14px] w-px bg-white/[0.07]" />
                    )}
                    <span className="relative mt-[7px] h-2 w-2 rounded-full bg-zinc-600 ring-4 ring-[#141416]" />
                  </span>
                  <div className={cx("min-w-0 pb-3", index === run.actions.length - 1 && "pb-0")}>
                    <div className="text-pretty text-sm font-medium leading-5 text-zinc-300">{entry.label}</div>
                    <WriteHistoryDetail
                      entry={entry}
                      expanded={Boolean(expandedEntries[entry.id])}
                      onToggle={() => onToggleEntry(entry.id)}
                    />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="px-1 text-xs leading-5 text-zinc-600">No actions recorded for this prompt.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function WriteHistoryDetail({ entry, expanded, onToggle, promptCard = false }) {
  if (!entry.detail) return null;

  const isPrompt = entry.label === "User prompt";
  const isLongPrompt = isPrompt && entry.detail.length > 140;

  if (!isLongPrompt) {
    return (
      <div
        className={cx(
          promptCard
            ? "text-pretty text-sm leading-5 text-zinc-300"
            : "mt-0.5 truncate text-xs leading-5 text-zinc-500",
        )}
        title={entry.detail}
      >
        {entry.detail}
      </div>
    );
  }

  return (
    <div className={promptCard ? "" : "mt-1"}>
      <div
        className={cx(
          promptCard
            ? "text-pretty text-sm leading-5 text-zinc-300"
            : "text-xs leading-5 text-zinc-500",
          expanded ? "whitespace-pre-wrap break-words" : promptCard ? "line-clamp-2" : "truncate",
        )}
        title={expanded ? undefined : entry.detail}
      >
        {expanded ? entry.detail : promptPreview(entry.detail)}
      </div>
      <button
        type="button"
        onClick={onToggle}
        className={cx(
          "-ml-2 mt-1 inline-flex min-h-10 items-center rounded-full px-2 text-[11px] font-medium leading-none text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
          CONTROL_MOTION,
        )}
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

function SettingsDrawer({
  open,
  onClose,
  keyStatus,
  onSaveKey,
  chats,
  activeChatId,
  models,
  chatMode,
  settings,
  setSettings,
  defaultModel,
  hideFreeModels,
  nitroMode,
  smoothStreaming,
  showPromptNavigationRail,
  modelLocked,
  onPersist,
  onModelSelected,
  onSetDefaultModel,
  onToggleHideFreeModels,
  onToggleNitroMode,
  onToggleSmoothStreaming,
  onTogglePromptNavigationRail,
  onExportChats,
  onImportChats,
}) {
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [transferMessage, setTransferMessage] = useState("");
  const [selectedCloudChatId, setSelectedCloudChatId] = useState("");
  const [cloudSearch, setCloudSearch] = useState("");
  const [activePage, setActivePage] = useState("general");
  const [modelListScrolled, setModelListScrolled] = useState(false);
  const [modelListHasMoreBelow, setModelListHasMoreBelow] = useState(false);
  const [chatListScrolled, setChatListScrolled] = useState(false);
  const [chatListHasMoreBelow, setChatListHasMoreBelow] = useState(false);
  const [openAccordions, setOpenAccordions] = useState({
    reasoning: true,
    generation: true,
  });
  const fileInputRef = useRef(null);
  const modelListRef = useRef(null);
  const chatListRef = useRef(null);
  const modelSearchWrapRef = useRef(null);
  const modelSearchInputRef = useRef(null);
  const modelSearchRevertRef = useRef(null);
  const modelSearchHadResultsRef = useRef(true);
  const [editingMaxTokens, setEditingMaxTokens] = useState(false);
  const [maxTokensDraft, setMaxTokensDraft] = useState("");
  const canThink = supportsThinking(models, settings.model);
  const selectedModel = models.find((model) => model.id === settings.model);
  const selectedModelOutputName = promptModelName(models, settings.model);
  const selectedModelPrice = selectedModel ? priceLabel(selectedModel) : "";
  const selectedModelContextLimit = getModelContextLimit(selectedModel);
  const selectedModelContext = Number.isFinite(selectedModelContextLimit)
    ? `${formatTokens(selectedModelContextLimit)} context`
    : "";
  const keyConnected = Boolean(keyStatus.has_key);
  const activePageIndex = SETTINGS_PAGES.findIndex((page) => page.id === activePage) + 1;
  const selectedCloudChat = chats.find((chat) => chat.id === selectedCloudChatId);
  const activeCloudChat = chats.find((chat) => chat.id === activeChatId);
  const cloudChat = selectedCloudChat || activeCloudChat || chats[0];
  const cloudChatId = cloudChat?.id || "";
  const promptModeName = chatMode === "write" ? "Write" : "Chat";
  const visibleSettingsPages = chatMode === "write"
    ? SETTINGS_PAGES.filter((page) => page.id !== "system")
    : SETTINGS_PAGES;

  const filteredCloudChats = useMemo(() => {
    const normalized = cloudSearch.trim().toLowerCase();
    if (!normalized) return chats;
    return chats.filter((chat) => (
      [chat.title, promptModelName(models, chat.model)]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalized))
    ));
  }, [chats, cloudSearch, models]);

  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return models
      .filter((model) => {
        if (hideFreeModels && isFreeModel(model)) return false;
        if (!normalized) return true;
        return [model.name, model.id, model.description]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalized));
      });
  }, [hideFreeModels, models, query]);

  function updateModelListEdges(element) {
    const scrollTop = element.scrollTop;
    const bottomOffset = element.scrollHeight - element.clientHeight - scrollTop;
    setModelListScrolled(scrollTop > 2);
    setModelListHasMoreBelow(bottomOffset > 2);
  }

  function updateChatListEdges(element) {
    const scrollTop = element.scrollTop;
    const bottomOffset = element.scrollHeight - element.clientHeight - scrollTop;
    setChatListScrolled(scrollTop > 2);
    setChatListHasMoreBelow(bottomOffset > 2);
  }

  useEffect(() => {
    const modelList = modelListRef.current;
    if (!modelList) return;

    requestAnimationFrame(() => updateModelListEdges(modelList));
  }, [filteredModels.length, activePage]);

  useEffect(() => {
    const chatList = chatListRef.current;
    if (!chatList) return;

    requestAnimationFrame(() => updateChatListEdges(chatList));
  }, [filteredCloudChats.length, activePage]);

  useEffect(() => {
    if (chatMode === "write" && activePage === "system") {
      setActivePage("general");
    }
  }, [activePage, chatMode]);

  useEffect(() => {
    const hasQuery = query.trim().length > 0;
    const hasResults = filteredModels.length > 0;
    const shouldShake = hasQuery && !hasResults && modelSearchHadResultsRef.current;
    const shakeActive = modelSearchInputRef.current?.classList.contains("is-shaking");

    modelSearchHadResultsRef.current = hasResults || !hasQuery;

    if (!shouldShake) {
      if (hasResults || !hasQuery) {
        if (shakeActive) {
          return;
        }
        modelSearchWrapRef.current?.classList.remove("is-error");
        modelSearchInputRef.current?.classList.remove("is-error");
      }
      return;
    }

    const wrap = modelSearchWrapRef.current;
    const input = modelSearchInputRef.current;
    if (!wrap || !input) return;

    wrap.classList.add("is-error");
    input.classList.add("is-error");

    input.classList.remove("is-shaking");
    void input.offsetWidth;
    input.classList.add("is-shaking");

    const style = getComputedStyle(document.documentElement);
    const readMs = (name, fallback) => {
      const value = Number.parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const shakeMs = readMs("--shake-dur-a", 80) * 2 + readMs("--shake-dur-b", 60) * 2;
    const holdMs = readMs("--revert-hold", 3000);

    window.clearTimeout(modelSearchRevertRef.current);
    window.setTimeout(() => {
      input.classList.remove("is-shaking");
      if (filteredModels.length > 0 || !query.trim()) {
        wrap.classList.remove("is-error");
        input.classList.remove("is-error");
      }
    }, shakeMs + 20);
    modelSearchRevertRef.current = window.setTimeout(() => {
      wrap.classList.remove("is-error");
      input.classList.remove("is-error");
    }, shakeMs + holdMs);
  }, [filteredModels.length, query]);

  async function saveKey() {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await onSaveKey(apiKey.trim());
      setApiKey("");
    } finally {
      setSaving(false);
    }
  }

  function updateSetting(next) {
    setSettings((current) => ({ ...current, ...next }));
  }

  function commit(next) {
    const merged = { ...settings, ...next };
    setSettings(merged);
    onPersist(merged);
  }

  function commitMaxTokensDraft() {
    const parsed = Math.round(Number(maxTokensDraft));
    if (Number.isFinite(parsed) && parsed > 0) {
      commit({ max_tokens: parsed });
    }
    setEditingMaxTokens(false);
  }

  function selectModel(model) {
    commit({ model: model.id });
    onModelSelected(model.name || model.id);
    onClose();
  }

  function setSelectedModelAsDefault() {
    if (!settings.model || settings.model === defaultModel) return;
    onSetDefaultModel(settings.model);
  }

  function choosePage(pageId) {
    setActivePage(pageId);
  }

  function toggleAccordion(id) {
    setOpenAccordions((current) => ({
      ...current,
      [id]: !current[id],
    }));
  }

  function handleModelListScroll(event) {
    updateModelListEdges(event.currentTarget);
  }

  function handleChatListScroll(event) {
    updateChatListEdges(event.currentTarget);
  }

  function handleModelSearchChange(event) {
    setQuery(event.target.value);
  }

  async function exportChats() {
    if (!cloudChatId) return;
    setTransferMessage("");
    setExporting(true);
    try {
      await onExportChats(cloudChatId, cloudChat);
      setTransferMessage(`Exported ${cloudChat?.title || "chat"}`);
    } catch (error) {
      setTransferMessage(error.message);
    } finally {
      setExporting(false);
    }
  }

  async function importChats(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setTransferMessage("");
    setImporting(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const result = await onImportChats(payload);
      setTransferMessage(
        `Imported ${result.imported_chats || 0} chats and ${result.imported_messages || 0} messages`,
      );
    } catch (error) {
      setTransferMessage(error.message || "Import failed");
    } finally {
      setImporting(false);
    }
  }

  const StatusDot = (
    <span
      aria-label={keyConnected ? "OpenRouter key connected" : "OpenRouter key not set"}
      title={keyConnected ? "OpenRouter key connected" : "OpenRouter key not set"}
      className={cx(
        "relative top-px inline-block h-2 w-2 rounded-full",
        keyConnected
          ? "bg-emerald-300 shadow-[0_0_0_3px_rgba(110,231,183,0.12)]"
          : "bg-rose-400 shadow-[0_0_0_3px_rgba(251,113,133,0.12)]",
      )}
    />
  );

  const keySection = (
    <section className="border-b border-white/[0.08] pb-3">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-balance text-sm font-semibold text-zinc-100">
          <KeyRound size={16} />
          OpenRouter key
          {StatusDot}
        </h2>
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-or-v1-..."
          className="h-10 min-w-0 flex-1 rounded-xl bg-black/20 px-3 text-sm text-zinc-100 shadow-[var(--shadow-border)] outline-none transition-[background-color,box-shadow] duration-150 ease-out placeholder:text-zinc-600 focus:bg-black/25 focus:shadow-[0_0_0_1px_rgba(255,255,255,0.16)]"
        />
        <button
          type="button"
          onClick={saveKey}
          disabled={saving || !apiKey.trim()}
          className={cx(
            "h-10 rounded-xl bg-zinc-100 px-3 text-sm font-semibold text-zinc-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 disabled:shadow-[var(--shadow-border)] disabled:active:scale-100",
            CONTROL_MOTION,
          )}
        >
          {saving ? "Saving" : "Save"}
        </button>
      </div>
    </section>
  );

  const modelFilterSection = (
    <section className="border-b border-white/[0.08] py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-balance text-sm font-semibold text-zinc-100">
            Disable free models
          </h2>
          <p className="mt-0.5 text-pretty text-xs leading-5 text-zinc-500">
            Don't show free OpenRouter models in the model picker
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={hideFreeModels}
          aria-label="Hide free models"
          onClick={() => onToggleHideFreeModels(!hideFreeModels)}
          className={cx(
            "relative h-7 w-12 shrink-0 rounded-full shadow-[var(--shadow-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
            CONTROL_MOTION,
            hideFreeModels ? "bg-accent/80" : "bg-white/[0.08]",
          )}
        >
          <span
            className={cx(
              "absolute left-1 top-1 h-5 w-5 rounded-full bg-zinc-50 transition-transform duration-150 ease-out",
              hideFreeModels ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </section>
  );

  const turboSection = (
    <section className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-balance text-sm font-semibold text-zinc-100">
            Turbo
          </h2>
          <p className="mt-0.5 text-pretty text-xs leading-5 text-zinc-500">
            Prioritize the fastest OpenRouter providers
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={nitroMode}
          aria-label="Turbo"
          onClick={() => onToggleNitroMode(!nitroMode)}
          className={cx(
            "relative h-7 w-12 shrink-0 rounded-full shadow-[var(--shadow-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
            CONTROL_MOTION,
            nitroMode ? "bg-accent/80" : "bg-white/[0.08]",
          )}
        >
          <span
            className={cx(
              "absolute left-1 top-1 h-5 w-5 rounded-full bg-zinc-50 transition-transform duration-150 ease-out",
              nitroMode ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </section>
  );

  const smoothTextSection = (
    <section className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-balance text-sm font-semibold text-zinc-100">
            Smooth text
          </h2>
          <p className="mt-0.5 text-pretty text-xs leading-5 text-zinc-500">
            Render model responses more smoothly
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={smoothStreaming}
          aria-label="Smooth text"
          onClick={() => onToggleSmoothStreaming(!smoothStreaming)}
          className={cx(
            "relative h-7 w-12 shrink-0 rounded-full shadow-[var(--shadow-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
            CONTROL_MOTION,
            smoothStreaming ? "bg-accent/80" : "bg-white/[0.08]",
          )}
        >
          <span
            className={cx(
              "absolute left-1 top-1 h-5 w-5 rounded-full bg-zinc-50 transition-transform duration-150 ease-out",
              smoothStreaming ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </section>
  );

  const promptNavigationSection = (
    <section className="border-b border-white/[0.08] py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-balance text-sm font-semibold text-zinc-100">
            Navigation bar
          </h2>
          <p className="mt-0.5 text-pretty text-xs leading-5 text-zinc-500">
            Show a navigation bar for easily navigating long chats
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={showPromptNavigationRail}
          aria-label="Navigation bar"
          onClick={() => onTogglePromptNavigationRail(!showPromptNavigationRail)}
          className={cx(
            "relative h-7 w-12 shrink-0 rounded-full shadow-[var(--shadow-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
            CONTROL_MOTION,
            showPromptNavigationRail ? "bg-accent/80" : "bg-white/[0.08]",
          )}
        >
          <span
            className={cx(
              "absolute left-1 top-1 h-5 w-5 rounded-full bg-zinc-50 transition-transform duration-150 ease-out",
              showPromptNavigationRail ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </section>
  );

  const systemSection = (
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-balance text-sm font-semibold text-zinc-100">
            {promptModeName} system prompt
          </h2>
          {settings.system_prompt && (
            <button
              type="button"
              onClick={() => {
                updateSetting({ system_prompt: "" });
                onPersist({ ...settings, system_prompt: "" });
              }}
              className={cx(
                "flex shrink-0 items-center gap-1 rounded-full bg-white/[0.055] px-2 py-0.5 text-[11px] font-medium leading-normal text-zinc-400 shadow-[var(--shadow-border)] hover:bg-white/[0.085] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                CONTROL_MOTION,
              )}
            >
              <X size={11} strokeWidth={2.2} />
              Clear
            </button>
          )}
        </div>
        <p className="mt-0.5 mb-3 text-pretty text-xs leading-5 text-zinc-500">
          {promptModeName === "Write"
            ? "Optional instructions sent before every write-mode message. Chat mode has its own system prompt."
            : "Optional instructions sent before every chat-mode message. Write mode has its own system prompt."}
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <div className="prompt-edit-surface h-full w-full rounded-[22px] px-4 py-3">
          <textarea
            value={settings.system_prompt}
            onChange={(event) => updateSetting({ system_prompt: event.target.value })}
            onBlur={() => onPersist(settings)}
            placeholder={`No ${promptModeName.toLowerCase()} system prompt`}
            className="block h-full w-full resize-none overflow-y-auto bg-transparent text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-500"
          />
        </div>
      </div>
    </section>
  );

  const importExportSection = (
    <section className="flex h-full min-h-0 flex-col">
      <div className="border-b border-white/[0.08] pb-3">
        <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
          Share a selected conversation as a JSON file.
        </p>
      </div>

      <section className="min-h-0 px-1 py-3">
        <h2 className="text-balance text-sm font-semibold text-zinc-100">
          Select Chat
        </h2>
        <div className="mt-2 space-y-2">
          <SearchClearField
            value={cloudSearch}
            onChange={setCloudSearch}
            placeholder="Search chats"
          />
          <div className="relative">
            <div
              ref={chatListRef}
              onScroll={handleChatListScroll}
              className="settings-chat-list max-h-36 min-h-0 space-y-1 overflow-y-auto"
            >
              {filteredCloudChats.length === 0 ? (
                <div className="grid min-h-10 w-full grid-cols-[18px_minmax(0,1fr)_14px] items-center gap-2 rounded-xl bg-black/15 px-3 py-3 text-pretty text-xs leading-5 text-zinc-500 shadow-[var(--shadow-border)]">
                  <span className="col-start-2 min-w-0">
                    {chats.length === 0 ? "No chats yet." : "No matching chats."}
                  </span>
                </div>
              ) : (
                filteredCloudChats.map((chat) => {
                  const selected = chat.id === cloudChatId;
                  return (
                    <button
                      key={chat.id}
                      type="button"
                      onClick={() => setSelectedCloudChatId(chat.id)}
                      className={cx(
                        "grid min-h-10 w-full grid-cols-[18px_minmax(0,1fr)_14px] items-center gap-2 rounded-xl px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                        CONTROL_MOTION,
                        selected
                          ? "bg-white/[0.065] text-zinc-100 shadow-[var(--shadow-border)]"
                          : "text-zinc-300 hover:bg-white/[0.035] hover:text-zinc-100",
                      )}
                    >
                      <span className="col-start-2 min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {chat.title}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-zinc-500">
                          {promptModelName(models, chat.model)}
                        </span>
                      </span>
                      <Check
                        size={14}
                        aria-hidden="true"
                        className={cx(
                          "col-start-3 justify-self-end text-zinc-200",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </button>
                  );
                })
              )}
            </div>
            <div
              aria-hidden="true"
              className={cx(
                "settings-list-fade pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-[#202022]/95 to-transparent transition-opacity duration-150 ease-out",
                chatListScrolled ? "opacity-100" : "opacity-0",
              )}
            />
            <div
              aria-hidden="true"
              className={cx(
                "settings-list-fade pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-[#202022]/95 to-transparent transition-opacity duration-150 ease-out",
                chatListHasMoreBelow ? "opacity-100" : "opacity-0",
              )}
            />
          </div>
        </div>
      </section>

      <section className="mt-auto pb-1 pt-6">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={exporting || importing || !cloudChatId}
            onClick={exportChats}
            className={cx(
              "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/[0.055] px-3 text-xs font-semibold text-zinc-100 shadow-[var(--shadow-border)] hover:bg-white/[0.085] hover:shadow-[var(--shadow-border-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:opacity-60 disabled:active:scale-100",
              CONTROL_MOTION,
            )}
          >
            <i className="fi fi-rr-download text-[13px] leading-none" aria-hidden="true" />
            {exporting ? "Exporting" : "Export"}
          </button>

          <button
            type="button"
            disabled={exporting || importing}
            onClick={() => fileInputRef.current?.click()}
            className={cx(
              "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/[0.055] px-3 text-xs font-semibold text-zinc-100 shadow-[var(--shadow-border)] hover:bg-white/[0.085] hover:shadow-[var(--shadow-border-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:opacity-60 disabled:active:scale-100",
              CONTROL_MOTION,
            )}
          >
            <i className="fi fi-rr-cloud-upload-alt text-[13px] leading-none" aria-hidden="true" />
            {importing ? "Importing" : "Import"}
          </button>
        </div>
      </section>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={importChats}
      />

      <p
        aria-live="polite"
        className={cx(
          "px-1 text-xs leading-5 text-zinc-500 transition-[opacity,filter,transform] duration-150 ease-out",
          transferMessage
            ? "min-h-6 translate-y-0 py-2 opacity-100 blur-0"
            : "h-0 min-h-0 -translate-y-1 overflow-hidden py-0 opacity-0 blur-[2px]",
        )}
      >
        {transferMessage || "\u00a0"}
      </p>
    </section>
  );

  const modelList = (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="pb-2.5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-balance text-sm font-semibold text-zinc-100">
              Model
              {modelLocked && (
                <span className="inline-flex min-h-6 items-center rounded-full bg-white/[0.04] px-2 text-[11px] font-medium text-zinc-500 shadow-[var(--shadow-border)]">
                  Model locked
                </span>
              )}
            </h2>
            <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-zinc-500">
              <span className="truncate">{selectedModel?.name || settings.model}</span>
              {selectedModelPrice && (
                <span className="inline-flex min-h-5 shrink-0 items-center rounded-full bg-white/[0.055] px-2 text-[11px] font-medium leading-none tabular-nums text-zinc-500 shadow-[var(--shadow-border)]">
                  {selectedModelPrice}
                </span>
              )}
              <button
                type="button"
                disabled={!settings.model || settings.model === defaultModel}
                onClick={setSelectedModelAsDefault}
                className={cx(
                  "inline-flex min-h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium leading-none shadow-[var(--shadow-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-default disabled:active:scale-100",
                  CONTROL_MOTION,
                  settings.model === defaultModel
                    ? "bg-white/[0.045] text-zinc-500"
                    : "bg-white/[0.065] text-zinc-300 hover:bg-white/[0.1] hover:text-zinc-100",
                )}
              >
                {settings.model === defaultModel ? "Default" : "Set default"}
              </button>
            </p>
          </div>
        </div>
        <div
          ref={modelSearchWrapRef}
          className="t-input-wrap"
        >
          <div
            ref={modelSearchInputRef}
            className="t-input model-search-input flex h-10 items-center gap-2 rounded-xl bg-black/20 px-3 text-zinc-500 shadow-[var(--shadow-border)] transition-[background-color,box-shadow] duration-150 ease-out focus-within:bg-black/25 focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.16)]"
          >
          <Search size={15} />
          <input
            type="search"
            value={query}
            onChange={handleModelSearchChange}
            placeholder="Search models"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] tabular-nums text-zinc-500">
            {filteredModels.length}
          </span>
          </div>
        </div>
        {modelLocked && (
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-600">
            Model selection is locked after the first message in a chat.
          </p>
        )}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_104px] items-center px-1 pb-2 pt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-600">
        <span>Model</span>
        <span className="whitespace-nowrap text-center">Price + Context</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={modelListRef}
          onScroll={handleModelListScroll}
          className="min-h-0 h-full overflow-y-auto"
        >
          {filteredModels.length === 0 ? (
            <div className="mt-3 rounded-[18px] bg-black/15 p-4 text-pretty text-sm leading-6 text-zinc-500 shadow-[var(--shadow-border)]">
              {models.length === 0 ? "Save an API key to load models." : "No matching models."}
            </div>
          ) : (
            filteredModels.map((model) => {
              const isSelected = model.id === settings.model;
              const modelPrice = priceLabel(model);
              const modelContextLimit = getModelContextLimit(model);
              const modelContext = Number.isFinite(modelContextLimit)
                ? `${formatTokens(modelContextLimit)} context`
                : "—";
              return (
                <div
                  key={model.id}
                  className={cx(
                    "grid min-h-[52px] grid-cols-[minmax(0,1fr)_104px] items-center rounded-lg px-1 py-2 transition-colors duration-150 ease-out",
                    isSelected ? "bg-white/[0.035]" : "hover:bg-white/[0.02]",
                    modelLocked && !isSelected && "opacity-45",
                  )}
                >
                  <button
                    type="button"
                    disabled={modelLocked}
                    onClick={() => selectModel(model)}
                    className={cx(
                      "min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                      CONTROL_MOTION,
                      modelLocked && !isSelected && "cursor-not-allowed active:scale-100",
                    )}
                  >
                    <span className="block truncate text-sm font-medium text-zinc-100">
                      {model.name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-zinc-600">
                      {model.id}
                    </span>
                  </button>
                  <span className="flex min-w-0 flex-col items-center px-1 text-center text-xs leading-4 tabular-nums text-zinc-500">
                    <span className="whitespace-nowrap">{modelPrice || "-"}</span>
                    <span className="whitespace-nowrap">{modelContext}</span>
                  </span>
                </div>
              );
            })
          )}
        </div>
        <div
          aria-hidden="true"
          className={cx(
            "settings-list-fade pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-[#202022]/95 to-transparent transition-opacity duration-150 ease-out",
            modelListScrolled ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          aria-hidden="true"
          className={cx(
            "settings-list-fade pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-[#202022]/95 to-transparent transition-opacity duration-150 ease-out",
            modelListHasMoreBelow ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
    </section>
  );

  const reasoningSection = (
    <Accordion
      id="reasoning"
      title="Reasoning"
      open={openAccordions.reasoning}
      onToggle={toggleAccordion}
      trailing={!canThink ? "Unavailable" : null}
    >
      <p className="mb-3 text-pretty text-xs leading-5 text-zinc-500">
        Select model reasoning effort
      </p>
      <SlidingTabs
        options={REASONING_EFFORTS}
        value={settings.reasoning_effort}
        onChange={(value) => commit({ reasoning_effort: value })}
        getValue={(effort) => effort.value}
        getLabel={(effort) => effort.shortLabel || effort.label}
        ariaLabel="Reasoning effort"
        disabled={!canThink}
        className="reasoning-tabs w-full"
      />
    </Accordion>
  );

  const generationSection = (
    <Accordion
      id="generation"
      title="Generation"
      open={openAccordions.generation}
      onToggle={toggleAccordion}
    >
      <p className="mb-3 text-pretty text-xs leading-5 text-zinc-500">
        Customize model outputs
      </p>
      <div className="space-y-3">
        <div className="settings-slider-row">
          <div className="mb-2.5 flex items-center justify-between text-xs font-medium">
            <span className="text-zinc-400">Temperature</span>
            <span className="min-w-9 rounded-full bg-white/[0.055] px-2 py-0.5 text-center tabular-nums text-zinc-200 shadow-[var(--shadow-border)]">
              {settings.temperature}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.1"
            value={settings.temperature}
            onChange={(event) => updateSetting({ temperature: Number(event.target.value) })}
            onMouseUp={() => onPersist(settings)}
            onTouchEnd={() => onPersist(settings)}
            style={{ "--range-progress": rangeProgress(settings.temperature, 0, 1.5) }}
            className="settings-range"
          />
        </div>
        <div className="settings-slider-row">
          <div className="mb-2.5 flex items-center justify-between text-xs font-medium">
            <span className="text-zinc-400">Max output tokens</span>
            <div className="flex items-center gap-1.5">
              <span className="max-w-[140px] truncate rounded-full bg-white/[0.055] px-2 py-0.5 text-[11px] font-medium leading-normal text-zinc-500 shadow-[var(--shadow-border)]">
                {selectedModelOutputName}
              </span>
              {selectedModelContext && (
                <span className="shrink-0 rounded-full bg-white/[0.055] px-2 py-0.5 text-[11px] font-medium leading-normal tabular-nums text-zinc-500 shadow-[var(--shadow-border)]">
                  {selectedModelContext}
                </span>
              )}
              {editingMaxTokens ? (
                <input
                  type="text"
                  autoFocus
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={maxTokensDraft}
                  onChange={(event) => {
                    const digitsOnly = event.target.value.replace(/[^0-9]/g, "");
                    setMaxTokensDraft(digitsOnly);
                  }}
                  onBlur={commitMaxTokensDraft}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitMaxTokensDraft();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingMaxTokens(false);
                    }
                  }}
                  className="w-16 shrink-0 rounded-full bg-white/[0.08] px-2 py-0.5 text-center tabular-nums text-zinc-100 shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setMaxTokensDraft(String(settings.max_tokens));
                    setEditingMaxTokens(true);
                  }}
                  className={cx(
                    "w-16 shrink-0 rounded-full bg-white/[0.055] px-2 py-0.5 text-center tabular-nums text-zinc-200 shadow-[var(--shadow-border)] hover:bg-white/[0.085] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                    CONTROL_MOTION,
                  )}
                >
                  {settings.max_tokens}
                </button>
              )}
            </div>
          </div>
          <input
            type="range"
            min="1000"
            max="128000"
            step="1000"
            value={settings.max_tokens}
            onChange={(event) => updateSetting({ max_tokens: Number(event.target.value) })}
            onMouseUp={() => onPersist(settings)}
            onTouchEnd={() => onPersist(settings)}
            style={{ "--range-progress": rangeProgress(settings.max_tokens, 1000, 128000) }}
            className="settings-range"
          />
        </div>
      </div>
    </Accordion>
  );

  return (
    <div
      className={cx(
        "modal-interaction-guard fixed inset-0 z-50 grid place-items-center px-3 py-4 sm:px-6",
        !open && "is-inert pointer-events-none",
      )}
      inert={open ? undefined : ""}
    >
      <button
        type="button"
        aria-label="Close settings"
        className={cx(
          "absolute inset-0 bg-black/55 transition-[opacity,backdrop-filter] duration-200 ease-out",
          open ? "pointer-events-auto opacity-100 backdrop-blur-sm" : "pointer-events-none opacity-0 backdrop-blur-none",
        )}
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        aria-hidden={!open}
        className={cx(
          "t-modal relative z-10 grid h-[min(400px,calc(100vh-2rem))] w-full max-w-[560px] overflow-hidden rounded-[18px] bg-[#202022] text-zinc-100 shadow-[var(--shadow-surface)] md:grid-cols-[132px_minmax(0,1fr)]",
          open ? "is-open" : "is-closing",
        )}
      >
        <aside className="hidden min-h-0 border-r border-white/10 p-2 md:flex md:flex-col">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className={cx(
              "mb-2.5 grid h-10 w-10 place-items-center rounded-xl bg-white/[0.06] text-zinc-100 hover:bg-white/[0.09] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
              CONTROL_MOTION,
            )}
          >
            <X size={20} strokeWidth={1.9} />
          </button>
          <nav className="space-y-1.5" aria-label="Settings sections">
            {visibleSettingsPages.map((page) => {
              const Icon = page.icon;
              const selected = activePage === page.id;
              return (
                <button
                  key={page.id}
                  type="button"
                  onClick={() => choosePage(page.id)}
                  className={cx(
                    "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-medium leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                    CONTROL_MOTION,
                    selected
                      ? "bg-white/[0.08] text-zinc-50"
                      : "text-zinc-200 hover:bg-white/[0.045] hover:text-zinc-50",
                    )}
                >
                  <span
                    className={cx(
                      "settings-nav-icon",
                      page.id === "models" && "-translate-x-0.5",
                    )}
                    aria-hidden="true"
                  >
                    {page.iconClass ? (
                      <i className={cx(page.iconClass, "text-[15px] leading-none")} />
                    ) : (
                      <Icon size={15} strokeWidth={1.9} />
                    )}
                  </span>
                  <span className="truncate">{page.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-h-0 flex-col">
          <header className="border-b border-white/10 px-4 py-2.5 md:px-4 md:py-2.5">
            <div className="flex items-center justify-between gap-4">
              <h1
                id="settings-modal-title"
                className="text-lg font-medium tracking-normal text-zinc-50 md:text-xl"
              >
                {visibleSettingsPages.find((page) => page.id === activePage)?.label || "Settings"}
              </h1>
              <div className="md:hidden">
                <IconButton label="Close settings" onClick={onClose}>
                  <X size={17} />
                </IconButton>
              </div>
            </div>
            <SlidingTabs
              options={visibleSettingsPages}
              value={activePage}
              onChange={choosePage}
              getValue={(page) => page.id}
              getLabel={(page) => page.label}
              ariaLabel="Settings sections"
              className="settings-mobile-tabs mt-3 flex w-full md:hidden"
            />
          </header>

          <div
            className="settings-page-slide t-page-slide min-h-0 flex-1"
            data-page={String(activePageIndex)}
          >
            <section
              className="settings-scroll-page t-page space-y-0 overflow-y-auto px-4 py-3 md:px-4 md:py-3"
              data-page-id="1"
              aria-label="API settings"
            >
              {keySection}
              {modelFilterSection}
              {turboSection}
            </section>
            <section
              className="t-page flex min-h-0 flex-col px-4 py-3 md:px-4 md:py-3"
              data-page-id="2"
              aria-label="Model settings"
            >
              {modelList}
            </section>
            <section
              className="t-page flex min-h-0 flex-col px-4 py-3 md:px-4 md:py-3"
              data-page-id="3"
              aria-label="System settings"
            >
              {systemSection}
            </section>
            <section
              className="settings-scroll-page t-page space-y-0 overflow-y-auto px-4 py-3 md:px-4 md:py-3"
              data-page-id="4"
              aria-label="UI settings"
            >
              {promptNavigationSection}
              {smoothTextSection}
            </section>
            <section
              className="t-page overflow-hidden px-4 py-3 md:px-4 md:py-3"
              data-page-id="5"
              aria-label="Chats settings"
            >
              {importExportSection}
            </section>
            <section
              className="settings-scroll-page t-page space-y-0 overflow-y-auto px-4 py-3 md:px-4 md:py-3"
              data-page-id="6"
              aria-label="Advanced settings"
            >
              {reasoningSection}
              {generationSection}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}

function Accordion({ id, title, open, onToggle, trailing, children }) {
  return (
    <section className="t-acc border-b border-white/[0.08] last:border-b-0" data-open={String(open)}>
      <button
        type="button"
        className="t-acc-head flex min-h-10 w-full items-center justify-between gap-4 rounded-xl px-1 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/35"
        aria-expanded={open}
        onClick={() => onToggle(id)}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="truncate text-sm font-semibold text-zinc-100">{title}</span>
          {trailing && (
            <span className="shrink-0 rounded-full bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-600 shadow-[var(--shadow-border)]">
              {trailing}
            </span>
          )}
        </span>
        <span className="t-acc-chevron shrink-0 text-zinc-400">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 6.5L8 10.5L12 6.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      <div className="t-acc-panel">
        <div className="t-acc-panel-inner px-1 pb-3">
          {children}
        </div>
      </div>
    </section>
  );
}

function SlidingTabs({
  options,
  value,
  fromValue = null,
  onChange,
  getValue,
  getLabel,
  ariaLabel,
  disabled = false,
  className,
}) {
  const barRef = useRef(null);
  const pillRef = useRef(null);
  const measuredRef = useRef(false);
  const fromValueRef = useRef(fromValue);

  useEffect(() => {
    fromValueRef.current = fromValue;
  }, [fromValue]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return undefined;

    function tabForValue(tabValue) {
      if (!tabValue) return null;
      return [...bar.querySelectorAll(".t-tab")].find(
        (tab) => tab.dataset.value === tabValue,
      );
    }

    function moveToTab(tab, animate) {
      if (!tab) return;

      const tabLeft = tab.offsetLeft;
      const tabWidth = tab.offsetWidth;

      if (!animate) {
        const previousTransition = pill.style.transition;
        pill.style.transition = "none";
        pill.style.transform = `translateX(${tabLeft}px)`;
        pill.style.width = `${tabWidth}px`;
        void pill.offsetWidth;
        pill.style.transition = previousTransition;
        return;
      }

      pill.style.transform = `translateX(${tabLeft}px)`;
      pill.style.width = `${tabWidth}px`;
    }

    function moveToActive(animate) {
      const activeTab =
        tabForValue(value) ||
        bar.querySelector('[aria-selected="true"]') ||
        bar.querySelector(".t-tab");

      moveToTab(activeTab, animate);
    }

    function handleResize() {
      moveToActive(false);
    }

    const previousTab = tabForValue(fromValueRef.current);
    if (!measuredRef.current && previousTab && fromValueRef.current !== value) {
      moveToTab(previousTab, false);
      measuredRef.current = true;

      const frameId = requestAnimationFrame(() => {
        moveToActive(true);
        fromValueRef.current = null;
      });

      window.addEventListener("resize", handleResize);
      return () => {
        cancelAnimationFrame(frameId);
        window.removeEventListener("resize", handleResize);
      };
    }

    const shouldAnimate = measuredRef.current;
    moveToActive(shouldAnimate);
    measuredRef.current = true;

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => moveToActive(false));

    resizeObserver?.observe(bar);

    const frameId = shouldAnimate
      ? null
      : requestAnimationFrame(() => {
          moveToActive(false);
        });
    window.addEventListener("resize", handleResize);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [options, value, fromValue]);

  return (
    <div
      ref={barRef}
      className={cx("t-tabs", disabled && "is-disabled", className)}
      role="tablist"
      aria-label={ariaLabel}
    >
      <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
      {options.map((option) => {
        const optionValue = getValue(option);
        const selected = optionValue === value;
        return (
          <button
            key={optionValue}
            type="button"
            role="tab"
            aria-selected={selected}
            data-value={optionValue}
            disabled={disabled}
            onClick={() => onChange(optionValue)}
            className="t-tab min-w-0 flex-1 whitespace-nowrap"
          >
            {getLabel(option)}
          </button>
        );
      })}
    </div>
  );
}

function SearchClearField({ value, onChange, placeholder }) {
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const mirrorRef = useRef(null);
  const placeholderRef = useRef(null);
  const glowRef = useRef(null);
  const [isClearing, setIsClearing] = useState(false);
  const clearingRef = useRef(false);
  const frameRef = useRef(null);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  function readNumber(name, fallback) {
    const value = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(name),
    );
    return Number.isFinite(value) ? value : fallback;
  }

  function clearSearch() {
    if (!value || clearingRef.current) return;
    const wrap = wrapRef.current;
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    const phold = placeholderRef.current;
    const glow = glowRef.current;
    if (!wrap || !input || !mirror || !phold || !glow) {
      onChange("");
      return;
    }

    clearingRef.current = true;
    setIsClearing(true);
    mirror.textContent = value.replace(/ /g, "\u00a0");
    wrap.classList.add("is-clearing");
    onChange("");

    const total = readNumber("--clear-dur", 1000);
    const outDur = readNumber("--clear-out-dur", 400);
    const inDur = readNumber("--clear-in-dur", 400);
    const outFly = readNumber("--clear-out-fly", 12);
    const inFly = readNumber("--clear-in-fly", 12);
    const blur = readNumber("--clear-blur", 2);
    const glowDelay = readNumber("--glow-delay", 50);
    const glowPeakAt = readNumber("--glow-peak-at", 0.15);
    const glowOpacity = readNumber("--glow-opacity", 0.85);

    glow.style.background = "radial-gradient(ellipse 70% 18px at 50% 100%, rgba(255,255,255,0.22), transparent)";
    phold.style.transform = `translateY(-${inFly}px)`;
    phold.style.opacity = "0.9";
    phold.style.filter = `blur(${blur}px)`;

    const start = performance.now();
    function tick(now) {
      const elapsed = now - start;
      const outProgress = Math.min(1, elapsed / outDur);
      const inProgress = Math.min(1, elapsed / inDur);
      const easedOut = 1 - Math.pow(1 - outProgress, 3);
      const easedIn = 1 - Math.pow(1 - inProgress, 3);

      mirror.style.transform = `translateY(${(easedOut * outFly).toFixed(1)}px)`;
      mirror.style.opacity = (1 - easedOut).toFixed(3);
      mirror.style.filter = `blur(${(easedOut * blur).toFixed(1)}px)`;
      phold.style.transform = `translateY(${(-inFly + easedIn * inFly).toFixed(1)}px)`;
      phold.style.opacity = (0.9 + easedIn * 0.1).toFixed(3);
      phold.style.filter = `blur(${(blur - easedIn * blur).toFixed(1)}px)`;

      let nextGlow = 0;
      if (elapsed > glowDelay) {
        const glowProgress = Math.min(1, (elapsed - glowDelay) / Math.max(1, total - glowDelay));
        nextGlow = glowProgress < glowPeakAt
          ? glowProgress / glowPeakAt
          : 1 - (glowProgress - glowPeakAt) / (1 - glowPeakAt);
      }
      glow.style.opacity = (nextGlow * glowOpacity).toFixed(3);

      if (elapsed < total) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }

      frameRef.current = null;
      wrap.classList.remove("is-clearing");
      setIsClearing(false);
      [mirror, phold, glow].forEach((node) => {
        node.removeAttribute("style");
      });
      mirror.textContent = "";
      clearingRef.current = false;
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
    }

    frameRef.current = requestAnimationFrame(tick);
  }

  return (
    <div
      ref={wrapRef}
      className={cx(
        "cloud-search t-clear flex h-10 items-center gap-2 rounded-xl bg-black/20 px-3 text-zinc-500 shadow-[var(--shadow-border)] transition-[background-color,box-shadow] duration-150 ease-out focus-within:bg-black/25 focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.16)]",
        value && "has-value",
        isClearing && "is-clearing",
      )}
    >
      <Search size={15} className="relative z-[4] shrink-0" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="relative z-[4] min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-transparent"
      />
      <div ref={mirrorRef} className="t-clear-mirror" aria-hidden="true">
        {value}
      </div>
      <div ref={placeholderRef} className="t-clear-placeholder" aria-hidden="true">
        {placeholder}
      </div>
      <div ref={glowRef} className="t-clear-glow" aria-hidden="true" />
      <button
        type="button"
        aria-label="Clear chat search"
        onMouseDown={(event) => event.preventDefault()}
        onClick={clearSearch}
        className={cx(
          "t-clear-btn relative z-[4] grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
          CONTROL_MOTION,
          !value && "pointer-events-none opacity-0",
        )}
      >
        <X size={13} />
      </button>
    </div>
  );
}

function ConfirmModal({ dialog, onClose }) {
  const [renderedDialog, setRenderedDialog] = useState(dialog);
  const [phase, setPhase] = useState(dialog ? "open" : "closed");
  const [busy, setBusy] = useState(false);
  const [nameOverflowing, setNameOverflowing] = useState(false);
  const cancelRef = useRef(null);
  const chatNameRef = useRef(null);

  useEffect(() => {
    if (dialog) {
      setRenderedDialog(dialog);
      setPhase("open");
      setBusy(false);
      requestAnimationFrame(() => cancelRef.current?.focus());
      return undefined;
    }

    if (!renderedDialog) return undefined;

    setPhase("closing");
    const closeMs =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--modal-close-dur"),
      ) || 150;
    const timeoutId = window.setTimeout(() => {
      setRenderedDialog(null);
      setPhase("closed");
      setBusy(false);
    }, closeMs);
    return () => window.clearTimeout(timeoutId);
  }, [dialog, renderedDialog]);

  useEffect(() => {
    if (!renderedDialog) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape" && !busy) onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, renderedDialog]);

  useEffect(() => {
    if (!renderedDialog?.chatTitle) {
      setNameOverflowing(false);
      return undefined;
    }

    const node = chatNameRef.current;
    if (!node) return undefined;

    function measure() {
      setNameOverflowing(node.scrollWidth > node.clientWidth + 1);
    }

    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [renderedDialog?.chatTitle]);

  if (!renderedDialog) return null;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await renderedDialog.onConfirm();
      onClose();
    } catch {
      setBusy(false);
    }
  }

  const open = phase === "open";

  return createPortal(
    <div className="fixed inset-0 z-[100] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close dialog"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-modal-title"
        className={cx(
          "t-modal relative z-10 w-fit max-w-[calc(100vw-2rem)] rounded-[24px] bg-[#18181b] p-4 text-zinc-100 shadow-[var(--shadow-surface)] sm:max-w-[560px]",
          open ? "is-open" : "is-closing",
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <h2
            id="delete-modal-title"
            className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden text-base font-semibold text-zinc-100"
          >
            <span className="shrink-0">{renderedDialog.title || "Delete chat"}</span>
            {renderedDialog.chatTitle && (
              <span className="delete-chat-name" title={renderedDialog.chatTitle}>
                <span
                  ref={chatNameRef}
                  className={cx(
                    "delete-chat-name-text",
                    nameOverflowing && "is-overflowing",
                  )}
                >
                  {renderedDialog.chatTitle}
                </span>
              </span>
            )}
          </h2>
        </div>
        {renderedDialog.body && (
          <p className="mt-2 text-sm text-zinc-400">{renderedDialog.body}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onClose}
            className={cx(
              "h-10 rounded-full bg-white/[0.05] px-4 text-sm font-medium text-zinc-300 hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15 disabled:cursor-not-allowed disabled:opacity-55",
              CONTROL_MOTION,
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className={cx(
              "h-10 rounded-full bg-red-400 px-4 text-sm font-semibold text-zinc-950 hover:bg-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200/60 disabled:cursor-not-allowed disabled:opacity-55",
              CONTROL_MOTION,
            )}
          >
            {busy ? "Deleting" : renderedDialog.confirmLabel || "Delete"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function NewStoryModal({ open, onClose, onCreate }) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const titleInputId = useId();
  const titleRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      setTitle("");
      setBusy(false);
      requestAnimationFrame(() => titleRef.current?.focus());
      return undefined;
    }

    if (!rendered) return undefined;

    setPhase("closing");
    const closeMs =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--modal-close-dur"),
      ) || 150;
    const timeoutId = window.setTimeout(() => {
      setRendered(false);
      setPhase("closed");
      setBusy(false);
    }, closeMs);
    return () => window.clearTimeout(timeoutId);
  }, [open, rendered]);

  useEffect(() => {
    if (!rendered) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape" && !busy) onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, rendered]);

  if (!rendered) return null;

  const storyTitle = title.trim();
  const canCreate = storyTitle.length > 0 && !busy;
  const isOpen = phase === "open";

  async function createStory(event) {
    event.preventDefault();
    if (!canCreate) return;

    setBusy(true);
    try {
      await onCreate(storyTitle);
      onClose();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close new story dialog"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-story-modal-title"
        onSubmit={createStory}
        className={cx(
          "t-modal relative z-10 w-full max-w-[420px] rounded-[24px] bg-[#18181b] p-4 text-zinc-100 shadow-[var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <div>
          <h2
            id="new-story-modal-title"
            className="text-balance text-base font-semibold text-zinc-100"
          >
            Name your new story
          </h2>
          <p className="mt-2 text-pretty text-sm leading-6 text-zinc-400">
            You can rename your story from the sidebar at any time
          </p>
        </div>
        <input
          ref={titleRef}
          id={titleInputId}
          type="text"
          value={title}
          disabled={busy}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Story name"
          aria-label="Story name"
          className="mt-4 h-11 w-full rounded-2xl bg-black/25 px-3.5 text-sm font-medium text-zinc-100 shadow-[var(--shadow-border)] outline-none placeholder:text-zinc-600 focus:shadow-[var(--shadow-border-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className={cx(
              "h-10 rounded-full bg-white/[0.05] px-4 text-sm font-medium text-zinc-300 hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15 disabled:cursor-not-allowed disabled:opacity-55",
              CONTROL_MOTION,
            )}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className={cx(
              "h-10 rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-55",
              CONTROL_MOTION,
            )}
          >
            {busy ? "Creating" : "Create story"}
          </button>
        </div>
      </form>
    </div>
  );
}

function App() {
  const localAppSettings = readLocalAppSettings();
  const [chats, setChats] = useState([]);
  const [messages, setMessages] = useState([]);
  const [stories, setStories] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [lorebookEntries, setLorebookEntries] = useState([]);
  const [brainstormNodes, setBrainstormNodes] = useState([]);
  const [brainstormEdges, setBrainstormEdges] = useState([]);
  const [brainstormViewport, setBrainstormViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [brainstormPrompt, setBrainstormPrompt] = useState("");
  const [brainstormReasoning, setBrainstormReasoning] = useState("");
  const [latestBrainstormGeneration, setLatestBrainstormGeneration] = useState(null);
  const [activeStoryId, setActiveStoryId] = useState(null);
  const [activeChapterId, setActiveChapterId] = useState(null);
  const [storyWorkspaceView, setStoryWorkspaceView] = useState("chapter");
  const [chapterContent, setChapterContent] = useState("");
  const [chapterSaveState, setChapterSaveState] = useState("");
  const [storyGenerationStatus, setStoryGenerationStatus] = useState("");
  const [writeReasoning, setWriteReasoning] = useState({ text: "", streaming: false, durationMs: null });
  const [latestStoryGeneration, setLatestStoryGeneration] = useState(null);
  const [writeGenerationMode, setWriteGenerationMode] = useState("edit");
  const [writeHistoryEntries, setWriteHistoryEntries] = useState([]);
  const [models, setModels] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [temporaryChat, setTemporaryChat] = useState(false);
  const [tempChatId, setTempChatId] = useState(null);
  const [settings, setSettings] = useState(newSettings);
  const [defaultModel, setDefaultModel] = useState(DEFAULT_MODEL);
  const [hideFreeModels, setHideFreeModels] = useState(Boolean(localAppSettings.hide_free_models));
  const [nitroMode, setNitroMode] = useState(Boolean(localAppSettings.nitro_mode));
  const [smoothStreaming, setSmoothStreaming] = useState(Boolean(localAppSettings.smooth_streaming));
  const [showPromptNavigationRail, setShowPromptNavigationRail] = useState(
    localAppSettings.show_prompt_navigation_rail !== false,
  );
  const [keyStatus, setKeyStatus] = useState({ has_key: false });
  const [prompt, setPrompt] = useState("");
  const [openingMessage] = useState(() => pickOpeningMessage());
  const [writingOpeningMessage] = useState(() => pickOpeningMessage("write"));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [chatMode, setChatMode] = useState(() => {
    const route = parseRoute();
    return route.page === "story" ? "write" : route.mode || "chat";
  });
  const [previousChatMode, setPreviousChatMode] = useState(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState(null);
  const [reasoningStreamingMessageId, setReasoningStreamingMessageId] = useState(null);
  const [reasoningDurations, setReasoningDurations] = useState({});
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [newStoryDialogOpen, setNewStoryDialogOpen] = useState(false);
  const [temporaryTourStory, setTemporaryTourStory] = useState(null);
  const tour = useTour();
  const writeTour = useTour(WRITE_TOUR_STEPS);
  const { notifications, setStatus, showToast } = useNotifications();
  const [tourForceThinking, setTourForceThinking] = useState(false);
  const [tourSampleChatActive, setTourSampleChatActive] = useState(false);
  const abortRef = useRef(null);
  const writeGenerationRunRef = useRef(null);
  const previousChatModeTimeoutRef = useRef(null);
  const routeRef = useRef(parseRoute());
  const initialRouteHandledRef = useRef(false);
  const appSettingsLoadedRef = useRef(false);
  const latestChatLoadRef = useRef(0);
  const latestStoryLoadRef = useRef(0);
  const temporaryTourStoryIdRef = useRef(null);
  const defaultModelRef = useRef(DEFAULT_MODEL);
  const skipNextStoryAutoloadRef = useRef(false);
  const tempChatIdRef = useRef(null);
  const reasoningStartedAtRef = useRef({});
  const writeReasoningStartedAtRef = useRef(null);
  const writeReasoningStreamingRef = useRef(false);
  const streamRef = useRef(null);
  const previousRailStateRef = useRef(null);
  const brainstormViewportTimeoutRef = useRef(null);
  const chapterContentRef = useRef("");
  const chaptersRef = useRef([]);
  const activeStoryIdRef = useRef(null);
  const activeChapterIdRef = useRef(null);
  const storyWorkspaceViewRef = useRef("chapter");
  const navigationCoordinatorRef = useRef(null);
  const chapterSaveCoordinatorRef = useRef(null);

  if (!navigationCoordinatorRef.current) {
    navigationCoordinatorRef.current = createNavigationCoordinator();
  }

  if (!chapterSaveCoordinatorRef.current) {
    chapterSaveCoordinatorRef.current = createSaveCoordinator({
      saveChapter: ({ storyId, chapterId, content, revision }) => (
        storyApi.saveChapterContent(storyId, chapterId, content, revision)
      ),
      onStateChange: (snapshot) => {
        if (snapshot.confirmedChapter) {
          setChapters((current) => current.map((chapter) => {
            if (chapter.id !== snapshot.chapterId) return chapter;
            const nextChapter = snapshot.confirmedChapter;
            if (!snapshot.draft) return nextChapter;
            const draftContent = snapshot.draft.content;
            return {
              ...nextChapter,
              content: draftContent,
              word_count: draftContent.trim() ? draftContent.trim().split(/\s+/).length : 0,
            };
          }));
        }

        if (
          snapshot.storyId !== activeStoryIdRef.current
          || snapshot.chapterId !== activeChapterIdRef.current
        ) return;

        const labels = {
          queued: "Saving",
          saving: "Saving",
          saved: "Saved",
          failed: "Save failed",
          conflict: "Conflict",
        };
        setChapterSaveState(labels[snapshot.state] || "");
        if ((snapshot.state === "failed" || snapshot.state === "conflict") && snapshot.error) {
          setStatus(snapshot.error.message);
        }
      },
    });
  }

  const chapterSaveCoordinator = chapterSaveCoordinatorRef.current;

  function persistPendingChapterDrafts() {
    const pendingDrafts = chapterSaveCoordinator.getPendingDrafts();
    try {
      if (pendingDrafts.length > 0) {
        window.sessionStorage.setItem(
          PENDING_CHAPTER_DRAFTS_STORAGE_KEY,
          JSON.stringify(pendingDrafts),
        );
      } else {
        window.sessionStorage.removeItem(PENDING_CHAPTER_DRAFTS_STORAGE_KEY);
      }
    } catch {
      //storage can be unavailable in private browser modes and thats fine
    }
  }

  function restorePendingChapterDrafts(nextChapters) {
    let storedDrafts = [];
    try {
      storedDrafts = JSON.parse(
        window.sessionStorage.getItem(PENDING_CHAPTER_DRAFTS_STORAGE_KEY) || "[]",
      );
    } catch {
      storedDrafts = [];
    }

    if (!Array.isArray(storedDrafts) || storedDrafts.length === 0) return;

    const restoredKeys = new Set();
    for (const draft of storedDrafts) {
      const chapter = nextChapters.find(
        (item) => item.id === draft.chapterId && item.story_id === draft.storyId,
      );
      if (!chapter) continue;

      chapterSaveCoordinator.rememberServerChapter(chapter);
      const key = `${draft.storyId}/${draft.chapterId}`;
      if (!chapterSaveCoordinator.getDraft(draft.storyId, draft.chapterId)) {
        if (chapter.content !== draft.content) {
          chapterSaveCoordinator.queueDraft(
            draft.storyId,
            draft.chapterId,
            String(draft.content || ""),
            Number.isInteger(draft.baseRevision) ? draft.baseRevision : chapter.revision,
          );
        }
      }
      restoredKeys.add(key);
    }

    const remainingDrafts = storedDrafts.filter(
      (draft) => !restoredKeys.has(`${draft.storyId}/${draft.chapterId}`),
    );
    try {
      if (remainingDrafts.length > 0) {
        window.sessionStorage.setItem(
          PENDING_CHAPTER_DRAFTS_STORAGE_KEY,
          JSON.stringify(remainingDrafts),
        );
      } else {
        window.sessionStorage.removeItem(PENDING_CHAPTER_DRAFTS_STORAGE_KEY);
      }
    } catch {
      //storage can be unavailable in private browser modes and thats fine
    }
  }

  useEffect(() => {
    activeStoryIdRef.current = activeStoryId;
    activeChapterIdRef.current = activeChapterId;
    chaptersRef.current = chapters;
    storyWorkspaceViewRef.current = storyWorkspaceView;
  }, [activeStoryId, activeChapterId, chapters, storyWorkspaceView]);

  useEffect(() => {
    function handlePageHide() {
      persistPendingChapterDrafts();
    }

    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      persistPendingChapterDrafts();
      chapterSaveCoordinator.dispose({ abandon: true });
      window.clearTimeout(previousChatModeTimeoutRef.current);
      window.clearTimeout(brainstormViewportTimeoutRef.current);
    };
  }, []);

  const {
    isNearBottom,
    markUserScroll,
    markWheelIntent,
    markTouchStart,
    markTouchMove,
    scrollToBottom,
    startFollowing,
    followRef,
  } =
    useRafScroller(streamRef);

  useEffect(() => {
    tempChatIdRef.current = tempChatId;
  }, [tempChatId]);

  useEffect(() => {
    if (tour.isActive) {
      previousRailStateRef.current = { collapsed: railCollapsed, open: railOpen };
      setRailCollapsed(false);
      setRailOpen(true);
      if (chats.length === 0) setTourSampleChatActive(true);
      return;
    }

    setTourForceThinking(false);
    setTourSampleChatActive(false);

    const previousRailState = previousRailStateRef.current;
    if (previousRailState) {
      setRailCollapsed(previousRailState.collapsed);
      setRailOpen(previousRailState.open);
      previousRailStateRef.current = null;
    }
  }, [tour.isActive]);

  useEffect(() => {
    setTourForceThinking(Boolean(tour.currentStep?.forceThinkingVisible));
  }, [tour.currentStep]);

  useEffect(() => {
    const storyId = temporaryTourStoryIdRef.current;
    const nextView = writeTour.currentStep?.workspaceView;
    if (!writeTour.isActive || !storyId || !nextView) return;

    setStoryWorkspaceView(nextView);
    writeRoute(storyRoute(storyId, activeChapterId, nextView), { replace: true });
  }, [writeTour.currentStep]);

  useEffect(() => {
    function closeTourStoryOnPageExit() {
      const storyId = temporaryTourStoryIdRef.current;
      if (!storyId) return;
      navigator.sendBeacon?.(`/api/stories/${encodeURIComponent(storyId)}/close`);
    }

    window.addEventListener("pagehide", closeTourStoryOnPageExit);
    return () => {
      closeTourStoryOnPageExit();
      window.removeEventListener("pagehide", closeTourStoryOnPageExit);
    };
  }, []);

  function writeRoute(route, { replace = false } = {}) {
    const nextPath = routePath(route);
    routeRef.current = route;
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (currentPath === nextPath) return;
    window.history[replace ? "replaceState" : "pushState"]({ route }, "", nextPath);
  }

  function beginNavigationIntent() {
    return navigationCoordinatorRef.current.begin();
  }

  function navigationIntentIsCurrent(intentId) {
    return navigationCoordinatorRef.current.isCurrent(intentId);
  }

  function currentNavigationIntent() {
    return navigationCoordinatorRef.current.current();
  }

  function setCommittedWriteSelection({ storyId, chapterId, workspaceView, chapters: nextChapters, lorebook, generation, story, chapter }) {
    const nextView = ["lorebook", "brainstorm"].includes(workspaceView)
      ? workspaceView
      : "chapter";
    const nextChapter = chapter || nextChapters.find((item) => item.id === chapterId) || null;

    activeStoryIdRef.current = storyId;
    activeChapterIdRef.current = nextChapter?.id || null;
    storyWorkspaceViewRef.current = nextView;
    chaptersRef.current = nextChapters;
    setActiveStoryId(storyId);
    setChapters(nextChapters);
    setLorebookEntries(lorebook || []);
    setLatestStoryGeneration(generation || null);
    setActiveChapterId(nextChapter?.id || null);
    setChapterContent(nextChapter?.content || "");
    setWriteHistoryEntries(nextChapter?.history || []);
    chapterContentRef.current = nextChapter?.content || "";
    setChapterSaveState("");
    setStoryWorkspaceView(nextView);
    setSettings({
      model: story.model,
      temperature: story.temperature,
      max_tokens: story.max_tokens,
      system_prompt: story.system_prompt || "",
      thinking_enabled: Boolean(story.thinking_enabled),
      reasoning_effort: story.reasoning_effort || "medium",
      nitro_mode: nitroMode,
    });
  }

  function hasActiveWriteGeneration() {
    const status = writeGenerationRunRef.current?.status;
    return ["preparing", "streaming", "applying", "reconciling"].includes(status);
  }

  function rejectWriteNavigationDuringGeneration() {
    if (!hasActiveWriteGeneration()) return false;
    setStatus("Finish or stop the current generation first.");
    return true;
  }

  function generationRunOwnsVisibleWorkspace(run) {
    return writeGenerationRunRef.current === run
      && run.navigationIntent === currentNavigationIntent()
      && activeStoryIdRef.current === run.storyId;
  }

  async function reconcileGenerationRun(run) {
    if (run.navigationIntent !== currentNavigationIntent()) return;
    const payload = await storyApi.getStory(run.storyId);
    if (run.navigationIntent !== currentNavigationIntent()) return;
    const nextChapters = payload.chapters || [];
    nextChapters.forEach((chapter) => chapterSaveCoordinator.rememberServerChapter(chapter));

    if (activeStoryIdRef.current !== run.storyId) return;
    const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
    setChapters(visibleChapters);
    setLorebookEntries(payload.lorebook || []);
    setLatestStoryGeneration(payload.latest_generation || null);

    const route = routeRef.current;
    if (route?.page !== "story" || route.storyId !== run.storyId || route.chapterId !== run.chapterId) return;
    const targetChapter = visibleChapters.find((chapter) => chapter.id === run.chapterId);
    if (!targetChapter) return;
    setChapterContent(targetChapter.content || "");
    setWriteHistoryEntries(targetChapter.history || []);
    chapterContentRef.current = targetChapter.content || "";
  }

  async function closeTempForRouteChange(nextRoute, navigationIntent = null) {
    const currentRoute = routeRef.current;
    const chatId = tempChatIdRef.current;
    if (currentRoute?.page !== "temp" || !chatId) return;
    if (nextRoute?.page === "temp" && nextRoute.chatId === chatId) return;
    await closeTemporaryChat(chatId);
    if (navigationIntent !== null && !navigationIntentIsCurrent(navigationIntent)) return false;
    return true;
  }

  async function navigateToChat(chat, { replace = false } = {}) {
    if (rejectWriteNavigationDuringGeneration()) return;
    const navigationIntent = beginNavigationIntent();
    const nextRoute = chatRoute(chat);
    try {
      await flushChapterSave(activeStoryIdRef.current, activeChapterIdRef.current);
      if (!navigationIntentIsCurrent(navigationIntent)) return;
    } catch (error) {
      setStatus(error.message);
      return;
    }
    await closeTempForRouteChange(nextRoute, navigationIntent);
    if (!navigationIntentIsCurrent(navigationIntent)) return;
    writeRoute(nextRoute, { replace });
    setChatMode("chat");
  }

  const isEmptyChat = !activeChatId && messages.length === 0;
  const isWritingMode = chatMode === "write";
  const isEmptyWriting = !activeStoryId || !activeChapterId;
  const writingStories = temporaryTourStory
    ? [temporaryTourStory, ...stories.filter((story) => story.id !== temporaryTourStory.id)]
    : stories;
  const activeMessages = isWritingMode ? [] : messages;
  const activeConversationId = isWritingMode ? activeStoryId : activeChatId;
  const activeModelLocked = Boolean(!isWritingMode && activeConversationId && activeMessages.length > 0);
  const activeChapterTitle = chapters.find((chapter) => chapter.id === activeChapterId)?.title || "Chapter";


  
  const sidebarChats =
    !isWritingMode && tourSampleChatActive && chats.length === 0
      ? [{ id: "__tour_sample_chat__", title: "Sample chat", model: settings.model }]
      : chats;

  const contextWindowInfo = useMemo(() => {
    const selectedModel = models.find((model) => model.id === settings.model);
    const contextLimit = getModelContextLimit(selectedModel);
    const latestItemWithUsage = isWritingMode
      ? storyWorkspaceView === "brainstorm"
        ? latestBrainstormGeneration
        : latestStoryGeneration
      : [...activeMessages]
          .reverse()
          .find((message) => {
            if (message.role !== "assistant") return false;
            if (toFiniteNumber(message.total_tokens) !== null) return true;
            return (
              toFiniteNumber(message.prompt_tokens) !== null &&
              toFiniteNumber(message.completion_tokens) !== null
            );
          });
    const totalTokens = toFiniteNumber(latestItemWithUsage?.total_tokens);
    const promptTokens = toFiniteNumber(latestItemWithUsage?.prompt_tokens);
    const completionTokens = toFiniteNumber(latestItemWithUsage?.completion_tokens);
    const contextTokens =
      totalTokens ?? (
        promptTokens !== null && completionTokens !== null
          ? promptTokens + completionTokens
          : null
      );

    return getContextWindowInfo(
      isWritingMode && contextTokens === null ? 0 : contextTokens,
      contextLimit,
    );
  }, [activeMessages, isWritingMode, latestBrainstormGeneration, latestStoryGeneration, models, settings.model, storyWorkspaceView]);

  const loadChats = useCallback(async () => {
    const payload = await api("/api/chats");
    setChats(payload.chats || []);
  }, []);

  const loadStories = useCallback(async () => {
    const nextStories = await storyApi.listStories();
    setStories(nextStories);
    return nextStories;
  }, []);

  function chapterWithCoordinatorState(chapter) {
    const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
      chapter.story_id,
      chapter.id,
    ) || chapter;
    const draftContent = chapterSaveCoordinator.getDraft(chapter.story_id, chapter.id);
    if (draftContent === null) return confirmedChapter;

    return {
      ...confirmedChapter,
      content: draftContent,
      word_count: draftContent.trim() ? draftContent.trim().split(/\s+/).length : 0,
    };
  }

  async function loadStoryBundle(storyId, preferredChapterId = null, options = {}) {
    const navigationIntent = options.navigationIntent ?? beginNavigationIntent();
    const loadId = navigationIntent;
    latestStoryLoadRef.current = loadId;
    await flushChapterSave(activeStoryIdRef.current, activeChapterIdRef.current);

    if (!navigationIntentIsCurrent(navigationIntent)) return null;

    const payload = await storyApi.getStory(storyId);
    if (!navigationIntentIsCurrent(navigationIntent) || loadId !== latestStoryLoadRef.current) return null;
    const nextStory = payload.story;
    const nextChapters = payload.chapters || [];
    nextChapters.forEach((chapter) => chapterSaveCoordinator.rememberServerChapter(chapter));
    restorePendingChapterDrafts(nextChapters);
    const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
    const nextLorebook = payload.lorebook || [];
    const nextGeneration = payload.latest_generation || null;
    const preferredChapter = visibleChapters.find((chapter) => chapter.id === preferredChapterId);
    if (options.requirePreferredChapter && preferredChapterId && !preferredChapter) {
      throw new Error("Chapter not found.");
    }
    const nextChapter =
      preferredChapter ||
      visibleChapters[0] ||
      null;

    return {
      story: nextStory,
      chapters: visibleChapters,
      chapter: nextChapter,
      lorebook: nextLorebook,
      generation: nextGeneration,
      loadId,
      navigationIntent,
    };
  }

  function commitStoryBundle(result, workspaceView = "chapter") {
    setCommittedWriteSelection({
      storyId: result.story.id,
      chapterId: result.chapter?.id || null,
      workspaceView,
      chapters: result.chapters,
      lorebook: result.lorebook,
      generation: result.generation,
      story: result.story,
      chapter: result.chapter,
    });
  }

  async function loadBrainstormBundle(storyId, storyLoadId = latestStoryLoadRef.current) {
    const payload = await storyApi.getBrainstorm(storyId);
    if (storyLoadId !== latestStoryLoadRef.current || !navigationIntentIsCurrent(storyLoadId)) return null;
    setBrainstormNodes(payload.nodes || []);
    setBrainstormEdges(payload.edges || []);
    setBrainstormViewport(payload.viewport || { x: 0, y: 0, zoom: 1 });
    setLatestBrainstormGeneration(payload.latest_generation || null);
    return payload;
  }

  async function loadStoryRoute(route, { replace = false, fromRoute = false } = {}) {
    if (rejectWriteNavigationDuringGeneration()) {
      writeRoute(routeRef.current, { replace: true });
      return;
    }
    const navigationIntent = beginNavigationIntent();
    const expectedLoadId = navigationIntent;
    try {
      const result = await loadStoryBundle(route.storyId, route.chapterId, {
        requirePreferredChapter: Boolean(route.chapterId),
        navigationIntent,
      });
      if (!result) return;
      const workspaceView = ["lorebook", "brainstorm"].includes(route.workspaceView)
        ? route.workspaceView
        : "chapter";
      if (workspaceView === "brainstorm") {
        await loadBrainstormBundle(result.story.id, result.loadId);
      }
      if (!navigationIntentIsCurrent(navigationIntent) || result.loadId !== latestStoryLoadRef.current) return;
      const routeChapterId = route.chapterId ? result.chapter?.id || null : null;
      const nextRoute = storyRoute(result.story.id, routeChapterId, workspaceView);
      await closeTempForRouteChange(nextRoute, navigationIntent);
      if (!navigationIntentIsCurrent(navigationIntent)) return;
      setCommittedWriteSelection({
        storyId: result.story.id,
        chapterId: result.chapter?.id || null,
        workspaceView,
        chapters: result.chapters,
        lorebook: result.lorebook,
        generation: result.generation,
        story: result.story,
        chapter: result.chapter,
      });
      writeRoute(nextRoute, { replace: replace || fromRoute });
      setChatMode("write");
    } catch (error) {
      if (!navigationIntentIsCurrent(navigationIntent) || expectedLoadId !== latestStoryLoadRef.current) return;
      if (fromRoute) {
        skipNextStoryAutoloadRef.current = true;
        await resetChat({ replace: true, mode: "write" });
      } else {
        setStatus(error.message);
      }
    }
  }

  const loadModels = useCallback(async () => {
    try {
      const payload = await api("/api/models");
      const loaded = payload.models || [];
      setModels(loaded);
      setSettings((current) => {
        const currentModel = loaded.find((model) => model.id === current.model);
        if (
          currentModel &&
          (activeChatId || activeStoryId || !hideFreeModels || !isFreeModel(currentModel))
        ) {
          return current;
        }
        const selectableModels = hideFreeModels
          ? loaded.filter((model) => !isFreeModel(model))
          : loaded;
        const savedDefaultModel = defaultModelRef.current;
        const fallbackModel = selectableModels.some((model) => model.id === savedDefaultModel)
          ? savedDefaultModel
          : selectableModels[0]?.id || loaded[0]?.id || DEFAULT_MODEL;
        return { ...current, model: fallbackModel };
      });
    } catch (error) {
      setStatus(error.message);
    }
  }, [activeChatId, activeStoryId, defaultModel, hideFreeModels]);

  const loadAppSettings = useCallback(async () => {
    try {
      const payload = await api("/api/settings");
      const nextDefaultModel = payload.default_model || DEFAULT_MODEL;
      const nextHideFreeModels =
        typeof payload.hide_free_models === "boolean"
          ? payload.hide_free_models
          : Boolean(readLocalAppSettings().hide_free_models);
      const nextNitroMode =
        typeof payload.nitro_mode === "boolean"
          ? payload.nitro_mode
          : Boolean(readLocalAppSettings().nitro_mode);
      const nextSmoothStreaming =
        typeof payload.smooth_streaming === "boolean"
          ? payload.smooth_streaming
          : Boolean(readLocalAppSettings().smooth_streaming);
      setDefaultModel(nextDefaultModel);
      defaultModelRef.current = nextDefaultModel;
      setHideFreeModels(nextHideFreeModels);
      setNitroMode(nextNitroMode);
      setSmoothStreaming(nextSmoothStreaming);
      writeLocalAppSettings({
        hide_free_models: nextHideFreeModels,
        nitro_mode: nextNitroMode,
        smooth_streaming: nextSmoothStreaming,
      });
      setSettings((current) => (
        activeChatId || activeStoryId || appSettingsLoadedRef.current
          ? { ...current, nitro_mode: nextNitroMode }
          : { ...current, model: nextDefaultModel, nitro_mode: nextNitroMode }
      ));
      appSettingsLoadedRef.current = true;
    } catch (error) {
      setStatus(error.message);
    }
  }, [activeChatId, activeStoryId]);

  const loadKeyStatus = useCallback(async () => {
    try {
      setKeyStatus(await api("/api/settings/key-status"));
    } catch (error) {
      setStatus(error.message);
    }
  }, []);

  useEffect(() => {
    loadKeyStatus();
    loadAppSettings();
    loadModels();
    loadChats();
    loadStories();
  }, [loadAppSettings, loadChats, loadKeyStatus, loadModels, loadStories]);

  useEffect(() => {
    scrollToBottom(true);
  }, [activeChatId, activeStoryId, activeChapterId, scrollToBottom]);

  useEffect(() => {
    if (!isWritingMode || activeStoryId || stories.length === 0) return;
    if (routeRef.current?.page === "home" && routeRef.current?.mode === "write") return;
    if (routeRef.current?.page === "story") return;
    if (skipNextStoryAutoloadRef.current) {
      skipNextStoryAutoloadRef.current = false;
      return;
    }
    const navigationIntent = beginNavigationIntent();
    void loadStoryBundle(stories[0].id, null, { navigationIntent }).then((result) => {
      if (!result) return;
      if (!navigationIntentIsCurrent(navigationIntent)) return;
      setCommittedWriteSelection({
        storyId: result.story.id,
        chapterId: result.chapter?.id || null,
        workspaceView: "chapter",
        chapters: result.chapters,
        lorebook: result.lorebook,
        generation: result.generation,
        story: result.story,
        chapter: result.chapter,
      });
      writeRoute(storyRoute(result.story.id, null, "chapter"), {
        replace: true,
      });
    }).catch((error) => {
      setStatus(error.message);
    });
  }, [activeStoryId, isWritingMode, stories]);

  function applyChat(chat, nextMessages) {
    const isTemporary = Boolean(chat.temporary);
    setTemporaryChat(isTemporary);
    setTempChatId(isTemporary ? chat.id : null);
    setActiveChatId(chat.id);
    setMessages(nextMessages || []);
    setSettings({
      model: chat.model,
      temperature: chat.temperature,
      max_tokens: chat.max_tokens,
      system_prompt: chat.system_prompt || "",
      thinking_enabled: Boolean(chat.thinking_enabled),
      reasoning_effort: chat.reasoning_effort || "medium",
      nitro_mode: nitroMode,
    });
  }

  async function closeTemporaryChat(chatId = tempChatIdRef.current) {
    if (!chatId) return;
    try {
      await api(`/api/chats/${chatId}/close`, { method: "POST" });
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  useEffect(() => {
    function closeTempOnPageExit() {
      const chatId = tempChatIdRef.current;
      if (!chatId || routeRef.current?.page !== "temp") return;
      navigator.sendBeacon?.(`/api/chats/${chatId}/close`);
    }

    window.addEventListener("pagehide", closeTempOnPageExit);
    return () => {
      closeTempOnPageExit();
      window.removeEventListener("pagehide", closeTempOnPageExit);
    };
  }, []);

  async function loadChat(chatId, { replace = false, fromRoute = false } = {}) {
    if (rejectWriteNavigationDuringGeneration()) {
      writeRoute(routeRef.current, { replace: true });
      return;
    }
    const navigationIntent = beginNavigationIntent();
    const loadId = latestChatLoadRef.current + 1;
    latestChatLoadRef.current = loadId;
    try {
      await flushChapterSave(activeStoryIdRef.current, activeChapterIdRef.current);
      if (!navigationIntentIsCurrent(navigationIntent)) return;
      const payload = await api(`/api/chats/${chatId}`);
      if (loadId !== latestChatLoadRef.current || !navigationIntentIsCurrent(navigationIntent)) return;
      const nextRoute = chatRoute(payload.chat);
      await closeTempForRouteChange(nextRoute, navigationIntent);
      if (loadId !== latestChatLoadRef.current || !navigationIntentIsCurrent(navigationIntent)) return;
      writeRoute(nextRoute, { replace: replace || fromRoute });
      setChatMode("chat");
      applyChat(payload.chat, payload.messages || []);
    } catch (error) {
      if (loadId !== latestChatLoadRef.current || !navigationIntentIsCurrent(navigationIntent)) return;
      if (fromRoute) {
        await resetChat({ replace: true });
      } else {
        setStatus(error.message);
      }
    }
  }

  async function persistSettings(nextSettings = settings) {
    if (isWritingMode) {
      if (!activeStoryId) return;
      try {
        await storyApi.updateStory(activeStoryId, nextSettings);
        await loadStories();
      } catch (error) {
        setStatus(error.message);
      }
      return;
    }

    if (!activeChatId) return;
    try {
      await api(`/api/chats/${activeChatId}`, {
        method: "PATCH",
        body: JSON.stringify(nextSettings),
      });
      await loadChats();
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function saveStorySystemPrompt(systemPrompt) {
    if (!activeStoryId) {
      throw new Error("No active story.");
    }

    const nextSettings = { ...settings, system_prompt: systemPrompt };
    try {
      await storyApi.updateStory(activeStoryId, nextSettings);
      setSettings(nextSettings);
      await loadStories();
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function resetChat({ replace = false, mode = chatMode } = {}) {
    if (rejectWriteNavigationDuringGeneration()) return;
    const navigationIntent = beginNavigationIntent();
    const nextMode = mode === "write" ? "write" : "chat";
    const nextRoute = { page: "home", mode: nextMode };
    try {
      await flushChapterSave(activeStoryIdRef.current, activeChapterIdRef.current);
      if (!navigationIntentIsCurrent(navigationIntent)) return;
    } catch (error) {
      setChapterSaveState(error.code === "chapter_revision_conflict" ? "Conflict" : "Save failed");
      setStatus(error.message);
      return;
    }
    await closeTempForRouteChange(nextRoute, navigationIntent);
    if (!navigationIntentIsCurrent(navigationIntent)) return;
    writeRoute(nextRoute, { replace });
    setChatMode(nextMode);
    setActiveChatId(null);
    setTemporaryChat(false);
    setTempChatId(null);
    setMessages([]);
    setActiveStoryId(null);
    setActiveChapterId(null);
    activeStoryIdRef.current = null;
    activeChapterIdRef.current = null;
    storyWorkspaceViewRef.current = "chapter";
    chaptersRef.current = [];
    setChapters([]);
    setLorebookEntries([]);
    setBrainstormNodes([]);
    setBrainstormEdges([]);
    setBrainstormViewport({ x: 0, y: 0, zoom: 1 });
    setLatestBrainstormGeneration(null);
    setLatestStoryGeneration(null);
    setChapterContent("");
    setWriteHistoryEntries([]);
    chapterContentRef.current = "";
    setChapterSaveState("");
    setStoryGenerationStatus("");
    setStoryWorkspaceView("chapter");
    setSettings((current) => ({
      ...newSettings,
      model: current.model || defaultModel,
      nitro_mode: nitroMode,
    }));
    setPrompt("");
    setStatus("");
  }

  useEffect(() => {
    if (initialRouteHandledRef.current) return;
    initialRouteHandledRef.current = true;

    const route = parseRoute();
    routeRef.current = route;
    if (route.page === "chat" || route.page === "temp") {
      setChatMode("chat");
      void loadChat(route.chatId, { replace: true, fromRoute: true });
    } else if (route.page === "story") {
      void loadStoryRoute(route, { replace: true, fromRoute: true });
    } else {
      setChatMode(route.mode || "chat");
      writeRoute({ page: "home", mode: route.mode || "chat" }, { replace: true });
    }
  }, []);

  useEffect(() => {
    function handlePopState() {
      const nextRoute = parseRoute();
      if (hasActiveWriteGeneration()) {
        setStatus("Finish or stop the current generation first.");
        writeRoute(routeRef.current, { replace: true });
        return;
      }
      if (nextRoute.page === "chat" || nextRoute.page === "temp") {
        setChatMode("chat");
        void loadChat(nextRoute.chatId, { replace: true, fromRoute: true });
        return;
      }
      if (nextRoute.page === "story") {
        void loadStoryRoute(nextRoute, { replace: true, fromRoute: true });
        return;
      }
      void resetChat({ replace: true, mode: nextRoute.mode || "chat" });
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  async function updateDefaultModel(modelId) {
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ default_model: modelId }),
      });
      const nextDefaultModel = payload.default_model || modelId;
      setDefaultModel(nextDefaultModel);
      defaultModelRef.current = nextDefaultModel;
      if (!activeChatId && !activeStoryId) {
        setSettings((current) => ({ ...current, model: nextDefaultModel }));
      }
      showToast("Default model updated");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function updateHideFreeModels(value) {
    setHideFreeModels(value);
    writeLocalAppSettings({ hide_free_models: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ hide_free_models: value }),
      });
      const nextValue =
        typeof payload.hide_free_models === "boolean"
          ? payload.hide_free_models
          : value;
      setHideFreeModels(nextValue);
      writeLocalAppSettings({ hide_free_models: nextValue });
      showToast(value ? "Free models hidden" : "Free models shown");
    } catch (error) {
      setHideFreeModels(value);
      writeLocalAppSettings({ hide_free_models: value });
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  async function updateNitroMode(value) {
    setNitroMode(value);
    setSettings((current) => ({ ...current, nitro_mode: value }));
    writeLocalAppSettings({ nitro_mode: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ nitro_mode: value }),
      });
      const nextValue =
        typeof payload.nitro_mode === "boolean"
          ? payload.nitro_mode
          : value;
      setNitroMode(nextValue);
      setSettings((current) => ({ ...current, nitro_mode: nextValue }));
      writeLocalAppSettings({ nitro_mode: nextValue });
      showToast(value ? "Turbo enabled" : "Turbo disabled");
    } catch (error) {
      setNitroMode(value);
      setSettings((current) => ({ ...current, nitro_mode: value }));
      writeLocalAppSettings({ nitro_mode: value });
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  async function updateSmoothStreaming(value) {
    setSmoothStreaming(value);
    writeLocalAppSettings({ smooth_streaming: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ smooth_streaming: value }),
      });
      const nextValue =
        typeof payload.smooth_streaming === "boolean"
          ? payload.smooth_streaming
          : value;
      setSmoothStreaming(nextValue);
      writeLocalAppSettings({ smooth_streaming: nextValue });
      showToast(value ? "Smooth text enabled" : "Smooth text disabled");
    } catch (error) {
      setSmoothStreaming(value);
      writeLocalAppSettings({ smooth_streaming: value });
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  function updatePromptNavigationRail(value) {
    setShowPromptNavigationRail(value);
    writeLocalAppSettings({ show_prompt_navigation_rail: value });
    showToast(value ? "Nav bar shown" : "Nav bar hidden");
  }

  async function createChat({ temporary = false } = {}) {
    const payload = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        ...settings,
        chat_system_prompt: settings.system_prompt,
        ...(temporary ? { title: "Temporary chat", temporary: true } : {}),
      }),
    });
    applyChat(payload.chat, []);
    await navigateToChat(payload.chat);
    if (!temporary) {
      await loadChats();
    }
    return payload.chat;
  }

  async function ensureChat() {
    if (activeChatId) return activeChatId;
    return (await createChat()).id;
  }

  async function ensureTemporaryChat() {
    if (tempChatId) return tempChatId;
    if (temporaryChat && activeChatId) return activeChatId;
    return (await createChat({ temporary: true })).id;
  }

  function toggleTemporaryChat() {
    if (isStreaming) return;
    if (temporaryChat) {
      void resetChat();
      return;
    }
    setTemporaryChat(true);
  }

  async function deleteChat(chatId) {
    const chat = chats.find((item) => item.id === chatId);
    if (!chat) return;
    setConfirmDialog({
      title: "Delete chat?",
      chatTitle: chat.title,
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await api(`/api/chats/${chatId}`, { method: "DELETE" });
          if (chatId === activeChatId) await resetChat();
          await loadChats();
          setStatus("Chat deleted");
        } catch (error) {
          setStatus(error.message);
        }
      },
    });
  }

  async function exportChats(chatId, chat) {
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/export`);
    if (!response.ok) {
      throw new Error(await responseErrorDetail(response));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(chat);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Chat exported");
  }

  async function exportChatFromMenu(chat) {
    if (!chat?.id) return;
    try {
      await exportChats(chat.id, chat);
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function importChats(payload) {
    const result = await api("/api/chats/import", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadChats();
    showToast("Chats imported");
    return result;
  }

  async function renameChat(chatId, title) {
    try {
      const payload = await api(`/api/chats/${chatId}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      await loadChats();
      if (chatId === activeChatId && payload.chat) {
        await navigateToChat(payload.chat, { replace: true });
      }
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function toggleChatPin(chat) {
    const nextPinned = !Boolean(chat.pinned);
    setChats((current) => current.map((item) => (
      item.id === chat.id ? { ...item, pinned: nextPinned } : item
    )));

    try {
      const payload = await api(`/api/chats/${chat.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned: nextPinned }),
      });
      setChats((current) => current.map((item) => (
        item.id === chat.id ? payload.chat : item
      )));
      await loadChats();
      showToast(nextPinned ? "Chat pinned" : "Chat unpinned");
    } catch (error) {
      setChats((current) => current.map((item) => (
        item.id === chat.id ? chat : item
      )));
      setStatus(error.message);
    }
  }

  async function saveKey(apiKey) {
    try {
      const payload = await api("/api/settings/openrouter-key", {
        method: "POST",
        body: JSON.stringify({ api_key: apiKey }),
      });
      setKeyStatus(payload);
      setStatus("OpenRouter connected");
      await loadModels();
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function readStream(response, assistantId, savedAssistantId = assistantId, setMessageList = setMessages) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const smoothBuffers = { content: "", reasoning: "" };
    let smoothFrame = null;

    function applyStreamText(nextContent, nextReasoning) {
      if (!nextContent && !nextReasoning) return;
      setMessageList((current) =>
        current.map((message) => {
          if (message.id !== assistantId) return message;
          return {
            ...message,
            content: nextContent
              ? `${message.content || ""}${nextContent}`
              : message.content,
            reasoning: nextReasoning
              ? `${message.reasoning || ""}${nextReasoning}`
              : message.reasoning,
          };
        }),
      );
      scrollToBottom();
    }

    function flushSmoothBuffers() {
      smoothFrame = null;
      const nextContent = smoothBuffers.content;
      const nextReasoning = smoothBuffers.reasoning;
      smoothBuffers.content = "";
      smoothBuffers.reasoning = "";
      applyStreamText(nextContent, nextReasoning);
    }

    function queueSmoothText(type, value) {
      smoothBuffers[type] += value;
      if (smoothFrame) return;
      smoothFrame = window.requestAnimationFrame(flushSmoothBuffers);
    }

    function flushNow() {
      if (smoothFrame) {
        window.cancelAnimationFrame(smoothFrame);
        smoothFrame = null;
      }
      flushSmoothBuffers();
    }

    function startReasoningTimer() {
      if (!reasoningStartedAtRef.current[assistantId]) {
        reasoningStartedAtRef.current[assistantId] = performance.now();
      }
    }

    function finishReasoningTimer() {
      const startedAt = reasoningStartedAtRef.current[assistantId];
      if (!startedAt) return;
      const durationMs = performance.now() - startedAt;
      delete reasoningStartedAtRef.current[assistantId];
      setReasoningDurations((current) => ({
        ...current,
        [assistantId]: durationMs,
        [savedAssistantId]: durationMs,
      }));
    }

    function clearReasoningStreaming() {
      finishReasoningTimer();
      setReasoningStreamingMessageId((current) =>
        current === assistantId ? null : current,
      );
    }

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        followRef.current = followRef.current && isNearBottom();
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            event = { type: "content", value: line };
          }
          if (event.type === "usage") {
            clearReasoningStreaming();
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId ? { ...message, ...(event.value || {}) } : message,
              ),
            );
            continue;
          }
          if (event.type === "reasoning") {
            startReasoningTimer();
            setReasoningStreamingMessageId(assistantId);
            if (smoothStreaming) {
              queueSmoothText("reasoning", String(event.value || ""));
            } else {
              applyStreamText("", String(event.value || ""));
            }
            continue;
          }
          clearReasoningStreaming();
          if (smoothStreaming) {
            queueSmoothText("content", String(event.value || ""));
          } else {
            applyStreamText(String(event.value || ""), "");
          }
        }
      }
      if (buffered.trim()) {
        clearReasoningStreaming();
        if (smoothStreaming) {
          queueSmoothText("content", buffered);
        } else {
          applyStreamText(buffered, "");
        }
      }
    } finally {
      flushNow();
      clearReasoningStreaming();
    }
  }

  async function sendMessage(text = prompt.trim(), regenerateMessageId = null) {
    if (isStreaming || !text) return;
    setIsStreaming(true);
    setStatus("");
    abortRef.current = new AbortController();
    let currentAssistantId = null;
    let conversationId = null;
    let currentTempMode = false;

    try {
      const tempMode = temporaryChat && (!activeChatId || activeChatId === tempChatId);
      currentTempMode = tempMode;
      conversationId = tempMode ? await ensureTemporaryChat() : await ensureChat();
      const shouldAddUser = !regenerateMessageId;
      const userMessage = {
        id: `local-user-${crypto.randomUUID()}`,
        chat_id: conversationId,
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      };

      const assistantId = `local-assistant-${crypto.randomUUID()}`;
      currentAssistantId = assistantId;
      const assistantMessage = {
        id: assistantId,
        chat_id: conversationId,
        role: "assistant",
        content: "",
        reasoning: "",
        created_at: new Date().toISOString(),
      };

      startFollowing();
      setStreamingMessageId(assistantId);
      setReasoningDurations((current) => {
        const next = { ...current };
        delete next[assistantId];
        return next;
      });
      setMessages((current) =>
        shouldAddUser
          ? [...current, userMessage, assistantMessage]
          : [...current, assistantMessage],
      );
      setPrompt("");

      const response = await fetch(`/api/chats/${conversationId}/messages/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          ...settings,
          chat_system_prompt: settings.system_prompt,
          message: text,
          regenerate_message_id: regenerateMessageId,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(await responseErrorDetail(response));
      }

      const savedAssistantId = response.headers.get("X-Assistant-Message-Id") || assistantId;
      await readStream(response, assistantId, savedAssistantId, setMessages);
      if (tempMode) {
        await loadChat(conversationId, { replace: true });
      } else {
        await loadChats();
        await loadChat(conversationId, { replace: true });
      }
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus("Response stopped");
        if (conversationId) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!currentTempMode) {
            await loadChats();
            await loadChat(conversationId, { replace: true });
          } else {
            await loadChat(conversationId, { replace: true });
          }
        }
      } else {
        setStatus(error.message);
        if (regenerateMessageId && conversationId) {
          await loadChat(conversationId, { replace: true });
        } else {
          setMessages((current) =>
            current.map((message) =>
              message.id === currentAssistantId
                ? { ...message, content: error.message }
                : message,
            ),
          );
        }
      }
    } finally {
      setIsStreaming(false);
      setStreamingMessageId(null);
      setReasoningStreamingMessageId(null);
      if (currentAssistantId) {
        delete reasoningStartedAtRef.current[currentAssistantId];
      }
      abortRef.current = null;
    }
  }

  function stopStream() {
    abortRef.current?.abort();
  }

  async function regenerate(assistantId) {
    const index = messages.findIndex((message) => message.id === assistantId);
    const previousUser = [...messages.slice(0, index)].reverse().find((message) => message.role === "user");
    if (!previousUser) return;
    setMessages(messages.slice(0, messages.findIndex((message) => message.id === previousUser.id) + 1));
    await sendMessage(previousUser.content, previousUser.id);
  }

  async function copyMessage(message) {
    await navigator.clipboard.writeText(message.content || "");
    setStatus("Copied");
  }

  async function editUserMessage(message, content) {
    if (!activeChatId || isStreaming) return;
    try {
      setStatus("Prompt updated. Regenerating...");
      setMessages((current) => {
        const messageIndex = current.findIndex((item) => item.id === message.id);
        if (messageIndex < 0) return current;
        return [
          ...current.slice(0, messageIndex),
          { ...current[messageIndex], content },
        ];
      });
      await sendMessage(content, message.id);
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function deleteUserMessage(message) {
    if (!activeChatId || isStreaming) return;
    setConfirmDialog({
      title: "Delete prompt?",
      body: "Delete this prompt and the replies after it? This cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          const payload = await api(`/api/chats/${activeChatId}/messages/${message.id}`, {
            method: "DELETE",
          });
          applyChat(payload.chat, payload.messages || []);
          await navigateToChat(payload.chat, { replace: true });
          await loadChats();
          setStatus("Prompt deleted");
        } catch (error) {
          setStatus(error.message);
        }
      },
    });
  }

  function toggleThinking() {
    setSettings((current) => {
      const next = { ...current, thinking_enabled: !current.thinking_enabled };
      if (activeConversationId) persistSettings(next);
      return next;
    });
  }

  function toggleWriteGenerationMode() {
    if (hasActiveWriteGeneration()) return setStatus("Finish or stop the current generation first.");
    setWriteGenerationMode((current) => (current === "new" ? "edit" : "new"));
  }

  function changeChatMode(nextMode) {
    if (rejectWriteNavigationDuringGeneration()) return;
    const mode = nextMode === "write" ? "write" : "chat";
    if (mode !== chatMode) {
      setPreviousChatMode(chatMode);
      window.clearTimeout(previousChatModeTimeoutRef.current);
      previousChatModeTimeoutRef.current = window.setTimeout(
        () => setPreviousChatMode(null),
        300,
      );
    }
    void resetChat({ mode });
  }

  async function finishWriteTour() {
    if (rejectWriteNavigationDuringGeneration()) return;
    const navigationIntent = beginNavigationIntent();
    const storyId = temporaryTourStoryIdRef.current;
    writeTour.finish();

    try {
      if (storyId) {
        await chapterSaveCoordinator.flush(storyId);
        if (!navigationIntentIsCurrent(navigationIntent)) return;
        await storyApi.closeStory(storyId);
        if (!navigationIntentIsCurrent(navigationIntent)) return;
      }
    } catch (error) {
      setStatus(error.message);
    } finally {
      if (!navigationIntentIsCurrent(navigationIntent)) return;
      temporaryTourStoryIdRef.current = null;
      await loadStories();
      await resetChat({ replace: true, mode: "write" });
      setTemporaryTourStory(null);
      setRailOpen(false);
      setRailCollapsed(false);
    }
  }

  async function startWriteTour() {
    if (isStreaming || writeTour.isActive || temporaryTourStoryIdRef.current) return;

    let storyId = null;
    try {
      setStatus("Preparing write tour");
      const story = await storyApi.createStory({
        title: "Write tour · temporary story",
        model: settings.model,
        system_prompt: "Keep the prose atmospheric, concise, and grounded in the story lore.",
        temperature: settings.temperature,
        max_tokens: settings.max_tokens,
        thinking_enabled: settings.thinking_enabled,
        reasoning_effort: settings.reasoning_effort,
        temporary: true,
      });
      storyId = story.id;
      temporaryTourStoryIdRef.current = story.id;
      setTemporaryTourStory(story);

      const chapter = await storyApi.createChapter(story.id, {
        title: "Chapter 1 · The Signal",
        content: "# The Tower\n\nLucy began to climb the tower steps, in awe of the moss covering everything",
      });
      await storyApi.createLorebookEntry(story.id, {
        name: "Lucy",
        category: "character",
        description: "A mage with a deep connection to the arcane.",
        aliases: ["Lucy"],
        tags: ["protagonist"],
      });

      const navigationIntent = beginNavigationIntent();
      const result = await loadStoryBundle(story.id, chapter.id, { navigationIntent });
      if (!result || !navigationIntentIsCurrent(navigationIntent)) return;
      commitStoryBundle(result);
      setRailCollapsed(false);
      setRailOpen(true);
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(story.id, chapter.id, "chapter"));
      setStatus("");
      writeTour.start();
    } catch (error) {
      temporaryTourStoryIdRef.current = null;
      setTemporaryTourStory(null);
      if (storyId) {
        try {
          await storyApi.closeStory(storyId);
        } catch {
          //cleanup also runs at startup if the browser decided today was the day
        }
      }
      await loadStories();
      await resetChat({ replace: true, mode: "write" });
      setStatus(error.message);
    }
  }

  async function startNewStory(title = "New story") {
    if (rejectWriteNavigationDuringGeneration() || isStreaming) return;
    try {
      const scaffold = await storyApi.createStoryWithInitialChapter(
        {
          title: title.trim() || "New story",
          model: settings.model,
          system_prompt: "",
          temperature: settings.temperature,
          max_tokens: settings.max_tokens,
          thinking_enabled: settings.thinking_enabled,
          reasoning_effort: settings.reasoning_effort,
        },
        { title: "Chapter 1", content: "" },
      );
      const { story, chapter } = scaffold;
      await loadStories();
      const navigationIntent = beginNavigationIntent();
      const result = await loadStoryBundle(story.id, chapter.id, { navigationIntent });
      if (!result || !navigationIntentIsCurrent(navigationIntent)) return;
      commitStoryBundle(result);
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(story.id, null, "chapter"));
      showToast("Story created");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function continueStory(storyId = null) {
    if (rejectWriteNavigationDuringGeneration() || isStreaming) return;
    const nextStoryId = storyId || stories[0]?.id || (await loadStories())[0]?.id;
    if (!nextStoryId) return;
    const navigationIntent = beginNavigationIntent();
    const result = await loadStoryBundle(nextStoryId, null, { navigationIntent });
    if (!result) return;
    if (!navigationIntentIsCurrent(navigationIntent)) return;
    commitStoryBundle(result);
    setStoryWorkspaceView("chapter");
    writeRoute(storyRoute(result.story.id, null, "chapter"));
  }

  async function selectStory(storyId) {
    if (rejectWriteNavigationDuringGeneration()) return;
    const navigationIntent = beginNavigationIntent();
    const expectedLoadId = navigationIntent;
    try {
      const result = await loadStoryBundle(storyId, null, { navigationIntent });
      if (!result) return;
      if (!navigationIntentIsCurrent(navigationIntent)) return;
      commitStoryBundle(result);
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(result.story.id, null, "chapter"));
    } catch (error) {
      if (!navigationIntentIsCurrent(navigationIntent) || expectedLoadId !== latestStoryLoadRef.current) return;
      setStatus(error.message);
    }
  }

  async function selectChapter(chapterId) {
    if (rejectWriteNavigationDuringGeneration()) return;
    const storyId = activeStoryIdRef.current;
    if (!storyId) return;
    const navigationIntent = beginNavigationIntent();

    try {
      await flushChapterSave(storyId, activeChapterIdRef.current);
      if (!navigationIntentIsCurrent(navigationIntent) || activeStoryIdRef.current !== storyId) return;
      const nextChapters = await storyApi.listChapters(storyId);
      if (!navigationIntentIsCurrent(navigationIntent) || activeStoryIdRef.current !== storyId) return;
      nextChapters.forEach((chapter) => chapterSaveCoordinator.rememberServerChapter(chapter));
      const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
      const chapter = visibleChapters.find((item) => item.id === chapterId);
      if (!chapter) return;
      const nextChapter = chapterWithCoordinatorState(chapter);
      chaptersRef.current = visibleChapters;
      activeChapterIdRef.current = nextChapter.id;
      storyWorkspaceViewRef.current = "chapter";
      setChapters(visibleChapters);
      setActiveChapterId(nextChapter.id);
      setChapterContent(nextChapter.content || "");
      setWriteHistoryEntries(nextChapter.history || []);
      chapterContentRef.current = nextChapter.content || "";
      setChapterSaveState("");
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(storyId, nextChapter.id, "chapter"));
    } catch (error) {
      setChapterSaveState(error.code === "chapter_revision_conflict" ? "Conflict" : "Save failed");
      setStatus(error.message);
    }
  }

  async function createStoryChapter() {
    if (rejectWriteNavigationDuringGeneration()) return;
    const storyId = activeStoryIdRef.current;
    if (!storyId) return;
    const navigationIntent = beginNavigationIntent();
    try {
      await flushChapterSave(storyId, activeChapterIdRef.current);
      if (!navigationIntentIsCurrent(navigationIntent) || activeStoryIdRef.current !== storyId) return;
      const chapter = await storyApi.createChapter(storyId, {
        title: `Chapter ${chaptersRef.current.length + 1}`,
      });
      if (!navigationIntentIsCurrent(navigationIntent) || activeStoryIdRef.current !== storyId) return;
      const nextChapters = await storyApi.listChapters(storyId);
      if (!navigationIntentIsCurrent(navigationIntent) || activeStoryIdRef.current !== storyId) return;
      nextChapters.forEach((item) => chapterSaveCoordinator.rememberServerChapter(item));
      const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
      chaptersRef.current = visibleChapters;
      activeChapterIdRef.current = chapter.id;
      storyWorkspaceViewRef.current = "chapter";
      setChapters(visibleChapters);
      setActiveChapterId(chapter.id);
      setChapterContent(chapter.content || "");
      setWriteHistoryEntries(chapter.history || []);
      chapterContentRef.current = chapter.content || "";
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(storyId, chapter.id, "chapter"));
      showToast("Chapter created");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function renameStoryItem(story) {
    const title = window.prompt("rename story", story.title);
    if (!title?.trim()) return;
    try {
      await storyApi.updateStory(story.id, { title: title.trim() });
      await loadStories();
      if (story.id === activeStoryIdRef.current) {
        const navigationIntent = beginNavigationIntent();
        const result = await loadStoryBundle(story.id, activeChapterIdRef.current, { navigationIntent });
        if (result && navigationIntentIsCurrent(navigationIntent)) commitStoryBundle(result);
      }
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function renameChapterItem(chapter) {
    const title = window.prompt("rename chapter", chapter.title);
    if (!title?.trim() || !activeStoryId) return;
    try {
      await flushChapterSave(activeStoryId, chapter.id);
      const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
        activeStoryId,
        chapter.id,
      ) || chapter;
      const updated = await storyApi.updateChapter(activeStoryId, chapter.id, {
        title: title.trim(),
        revision: confirmedChapter.revision,
      });
      chapterSaveCoordinator.rememberServerChapter(updated);
      setChapters((current) =>
        current.map((item) => (item.id === updated.id ? chapterWithCoordinatorState(updated) : item)),
      );
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function toggleChapterContext(chapter) {
    if (!activeStoryId) return;

    try {
      await flushChapterSave(activeStoryId, chapter.id);
      const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
        activeStoryId,
        chapter.id,
      ) || chapter;
      const updated = await storyApi.updateChapter(activeStoryId, chapter.id, {
        disabled: !chapter.disabled,
        revision: confirmedChapter.revision,
      });
      chapterSaveCoordinator.rememberServerChapter(updated);
      setChapters((current) =>
        current.map((item) => (item.id === updated.id ? chapterWithCoordinatorState(updated) : item)),
      );
      showToast(updated.disabled ? "Chapter hidden" : "Chapter shown");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function deleteStoryItem(story) {
    if (rejectWriteNavigationDuringGeneration()) return;
    setConfirmDialog({
      title: "Delete story?",
      chatTitle: story.title,
      body: "This deletes its chapters and lorebook. This cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await chapterSaveCoordinator.flush(story.id);

          await storyApi.deleteStory(story.id);
          const nextStories = await loadStories();
          if (story.id !== activeStoryId) {
            setStatus("Story deleted");
            return;
          }

          const nextStory = nextStories[0];
          if (nextStory) {
            const navigationIntent = beginNavigationIntent();
            const result = await loadStoryBundle(nextStory.id, null, { navigationIntent });
            if (!result) return;
            if (!navigationIntentIsCurrent(navigationIntent)) return;
            commitStoryBundle(result);
            setStoryWorkspaceView("chapter");
            writeRoute(storyRoute(result.story.id, null, "chapter"), {
              replace: true,
            });
          } else {
            setActiveStoryId(null);
            setActiveChapterId(null);
            setChapters([]);
            setLorebookEntries([]);
            setBrainstormNodes([]);
            setBrainstormEdges([]);
            setBrainstormViewport({ x: 0, y: 0, zoom: 1 });
            setLatestBrainstormGeneration(null);
            setLatestStoryGeneration(null);
            setChapterContent("");
            setWriteHistoryEntries([]);
            setStoryWorkspaceView("chapter");
            writeRoute({ page: "home", mode: "write" }, { replace: true });
          }
          setStatus("Story deleted");
        } catch (error) {
          setStatus(error.message);
        }
      },
    });
  }

  async function deleteChapterItem(chapter) {
    if (rejectWriteNavigationDuringGeneration()) return;
    if (!activeStoryId) return;
    setConfirmDialog({
      title: "Delete chapter?",
      chatTitle: chapter.title,
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await chapterSaveCoordinator.flush(activeStoryId, chapter.id);

          await storyApi.deleteChapter(activeStoryId, chapter.id);
          const nextChapters = await storyApi.listChapters(activeStoryId);
          nextChapters.forEach((item) => chapterSaveCoordinator.rememberServerChapter(item));
          const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
          setChapters(visibleChapters);
          if (chapter.id !== activeChapterId) {
            setStatus("Chapter deleted");
            return;
          }

          const nextChapter = visibleChapters[0] || null;
          setActiveChapterId(nextChapter?.id || null);
          setChapterContent(nextChapter?.content || "");
          setWriteHistoryEntries(nextChapter?.history || []);
          chapterContentRef.current = nextChapter?.content || "";
          setStoryWorkspaceView("chapter");
          writeRoute(storyRoute(activeStoryId, nextChapter?.id || null, "chapter"), {
            replace: true,
          });
          setStatus("Chapter deleted");
        } catch (error) {
          setStatus(error.message);
        }
      },
    });
  }

  async function createLorebookEntry(data) {
    if (!activeStoryId) throw new Error("No active story.");

    const entry = await storyApi.createLorebookEntry(activeStoryId, data);
    setLorebookEntries((currentEntries) => [entry, ...currentEntries]);
    showToast("Lorebook entry created");
    return entry;
  }

  async function updateLorebookEntry(entryId, data) {
    if (!activeStoryId) throw new Error("No active story.");

    const previousEntry = lorebookEntries.find((currentEntry) => currentEntry.id === entryId);
    const entry = await storyApi.updateLorebookEntry(activeStoryId, entryId, data);
    setLorebookEntries((currentEntries) =>
      currentEntries.map((currentEntry) => (currentEntry.id === entry.id ? entry : currentEntry)),
    );
    const contextChanged = previousEntry
      && Boolean(previousEntry.disabled) !== Boolean(entry.disabled);
    showToast(contextChanged ? (entry.disabled ? "Entry disabled" : "Entry enabled") : "Lorebook entry updated");
    return entry;
  }

  async function deleteLorebookEntry(entryId) {
    if (!activeStoryId) throw new Error("No active story.");

    await storyApi.deleteLorebookEntry(activeStoryId, entryId);
    setLorebookEntries((currentEntries) => currentEntries.filter((entry) => entry.id !== entryId));
    showToast("Lorebook entry deleted");
  }

  function confirmDeleteLorebookEntry(entry) {
    return new Promise((resolve) => {
      setConfirmDialog({
        title: "Delete lorebook entry?",
        chatTitle: entry.name,
        body: "This cannot be undone.",
        confirmLabel: "Delete",
        onConfirm: async () => {
          resolve(true);
        },
        onCancel: () => resolve(false),
      });
    });
  }

  function updateChapterCanvasContent(content) {
    setChapterContent(content);
    chapterContentRef.current = content;
    if (!activeStoryId || !activeChapterId) return;

    const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
      activeStoryId,
      activeChapterId,
    ) || chaptersRef.current.find((chapter) => chapter.id === activeChapterId);
    chapterSaveCoordinator.queueDraft(
      activeStoryId,
      activeChapterId,
      content,
      confirmedChapter?.revision ?? 0,
    );
  }

  async function flushChapterSave(storyId = activeStoryId, chapterId = activeChapterId) {
    if (!storyId) return null;
    return chapterSaveCoordinator.flush(storyId, chapterId);
  }

  async function openBrainstorm() {
    if (!activeStoryId || isStreaming) return;
    try {
      await flushChapterSave(activeStoryId, activeChapterId);
      await loadBrainstormBundle(activeStoryId);
      setStoryWorkspaceView("brainstorm");
      writeRoute(storyRoute(activeStoryId, activeChapterId, "brainstorm"));
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function updateBrainstormNode(nodeId, changes) {
    if (!activeStoryId) return;
    setBrainstormNodes((current) => current.map((node) => (
      node.id === nodeId
        ? {
            ...node,
            ...changes,
            position_x: changes.position_x ?? node.position_x,
            position_y: changes.position_y ?? node.position_y,
          }
        : node
    )));
    try {
      const updated = await storyApi.updateBrainstormNode(activeStoryId, nodeId, changes);
      setBrainstormNodes((current) => current.map((node) => (
        node.id === updated.id ? updated : node
      )));
    } catch (error) {
      setStatus(error.message);
      await loadBrainstormBundle(activeStoryId);
      throw error;
    }
  }

  async function deleteBrainstormNode(nodeId, hasDescendants = false, skipConfirm = false) {
    if (!activeStoryId || isStreaming) return;
    const performDelete = async () => {
      try {
        const payload = await storyApi.deleteBrainstormNode(
          activeStoryId,
          nodeId,
          hasDescendants,
        );
        const deletedIds = new Set(payload.deleted_node_ids || []);
        setBrainstormNodes((current) => current.filter((node) => !deletedIds.has(node.id)));
        setBrainstormEdges((current) => current.filter((edge) => (
          !deletedIds.has(edge.source_node_id) && !deletedIds.has(edge.target_node_id)
        )));
        if (!skipConfirm) showToast(hasDescendants ? "Branch deleted" : "Idea deleted");
      } catch (error) {
        setStatus(error.message);
        throw error;
      }
    };

    if (hasDescendants && !skipConfirm) {
      setConfirmDialog({
        title: "Delete brainstorm branch?",
        body: "This removes the selected card and every prompt and idea descended from it. This cannot be undone.",
        confirmLabel: "Delete branch",
        onConfirm: performDelete,
      });
      return;
    }
    await performDelete();
  }

  function updateBrainstormViewport(viewport) {
    if (!activeStoryId) return;
    setBrainstormViewport(viewport);
    window.clearTimeout(brainstormViewportTimeoutRef.current);
    brainstormViewportTimeoutRef.current = window.setTimeout(() => {
      storyApi.updateBrainstormViewport(activeStoryId, viewport).catch((error) => {
        setStatus(error.message);
      });
    }, 350);
  }

  async function generateBrainstorm(text = brainstormPrompt.trim(), selectedIdeaIds = [], ideaCount = 3) {
    if (isStreaming || !text || !activeStoryId) return;
    setIsStreaming(true);
    setBrainstormReasoning("");
    setStatus("");
    setBrainstormPrompt("");
    abortRef.current = new AbortController();
    let streamError = "";

    try {
      await storyApi.generateBrainstorm({
        storyId: activeStoryId,
        prompt: text,
        selectedIdeaIds,
        ideaCount,
        settings,
        signal: abortRef.current.signal,
        onEvent: (event) => {
          if (event.type === "prompt") {
            const value = event.value || {};
            if (value.node) {
              setBrainstormNodes((current) => [
                ...current.filter((node) => node.id !== value.node.id),
                value.node,
              ]);
            }
            if (Array.isArray(value.edges)) {
              setBrainstormEdges((current) => [
                ...current.filter((edge) => !value.edges.some((next) => next.id === edge.id)),
                ...value.edges,
              ]);
            }
            return;
          }
          if (event.type === "reasoning") {
            setBrainstormReasoning((current) => `${current}${String(event.value || "")}`);
            return;
          }
          if (event.type === "ideas") {
            const value = event.value || {};
            setBrainstormNodes((current) => [
              ...current.map((node) => (
                node.status === "generating" ? { ...node, status: "complete" } : node
              )),
              ...(value.nodes || []),
            ]);
            setBrainstormEdges((current) => [...current, ...(value.edges || [])]);
            return;
          }
          if (event.type === "usage") {
            setLatestBrainstormGeneration(event.value || null);
            return;
          }
          if (event.type === "error") {
            streamError = String(event.value || "Brainstorming failed");
            setStatus(streamError);
          }
        },
      });
      if (!streamError) showToast("Ideas added");
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus("Brainstorm stopped");
      } else {
        setStatus(error.message);
      }
    } finally {
      setIsStreaming(false);
      setBrainstormReasoning("");
      abortRef.current = null;
      try {
        await loadBrainstormBundle(activeStoryId);
      } catch (error) {
        setStatus(error.message);
      }
    }
  }

  function appendWriteHistoryEntry(entry) {
    if (!entry?.id) return;
    setWriteHistoryEntries((current) => {
      if (current.some((item) => item.id === entry.id)) return current;
      return [...current, entry];
    });
    setChapters((current) =>
      current.map((chapter) => {
        if (chapter.id !== entry.chapter_id) return chapter;
        const history = Array.isArray(chapter.history) ? chapter.history : [];
        if (history.some((item) => item.id === entry.id)) return chapter;
        return { ...chapter, history: [...history, entry] };
      }),
    );
  }

  async function generateStoryChapter(text = prompt.trim()) {
    if (isStreaming || hasActiveWriteGeneration() || !text || !activeStoryId || !activeChapterId) return;
    const abortController = new AbortController();
    const run = {
      runId: crypto.randomUUID(),
      storyId: activeStoryId,
      chapterId: activeChapterId,
      baseRevision: 0,
      generationMode: writeGenerationMode,
      status: "preparing",
      abortController,
      startedAt: Date.now(),
      navigationIntent: currentNavigationIntent(),
    };
    writeGenerationRunRef.current = run;
    abortRef.current = abortController;
    setIsStreaming(true);
    setStoryGenerationStatus("Preparing");
    setWriteReasoning({ text: "", streaming: false, durationMs: null });
    writeReasoningStartedAtRef.current = null;
    writeReasoningStreamingRef.current = false;
    setStatus("");
    let generatedText = "";
    let streamFailed = false;
    let terminalStatus = "completed";
    let targetChapterId = run.chapterId;
    let targetChapterContent = "";
    let targetChapterRevision = 0;
    let shouldWaitForChapterPatch = false;

    try {
      await flushChapterSave(run.storyId, run.chapterId);
      const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
        run.storyId,
        run.chapterId,
      ) || chaptersRef.current.find((chapter) => chapter.id === run.chapterId);
      targetChapterContent = chapterSaveCoordinator.getDraft(run.storyId, run.chapterId)
        ?? confirmedChapter?.content
        ?? chapterContentRef.current;
      targetChapterRevision = confirmedChapter?.revision ?? 0;
      run.baseRevision = targetChapterRevision;
      shouldWaitForChapterPatch = writeGenerationMode === "edit" && Boolean(targetChapterContent.trim());
      setPrompt("");
      if (writeGenerationMode === "new") {
        const chapter = await storyApi.createChapter(run.storyId, {
          title: `Chapter ${chapters.length + 1}`,
        });
        const nextChapters = await storyApi.listChapters(run.storyId);
        nextChapters.forEach((chapterItem) => chapterSaveCoordinator.rememberServerChapter(chapterItem));
        targetChapterId = chapter.id;
        run.chapterId = chapter.id;
        run.baseRevision = chapter.revision;
        targetChapterContent = "";
        targetChapterRevision = chapter.revision;
        shouldWaitForChapterPatch = false;
        setChapters(nextChapters.map(chapterWithCoordinatorState));
        setActiveChapterId(chapter.id);
        setChapterContent("");
        setWriteHistoryEntries(chapter.history || []);
        chapterContentRef.current = "";
        setStoryWorkspaceView("chapter");
        writeRoute(storyRoute(run.storyId, chapter.id, "chapter"));
      }

      run.status = "streaming";
      setStoryGenerationStatus("Writing");
      await storyApi.generateChapter({
        storyId: run.storyId,
        chapterId: targetChapterId,
        prompt: text,
        settings,
        generationMode: writeGenerationMode,
        chapterRevision: targetChapterRevision,
        generationRunId: run.runId,
        signal: abortController.signal,
        onEvent: (event) => {
          if (!chapterGenerationEventMatchesRun(event, run)) return;
          if (!generationRunOwnsVisibleWorkspace(run)) return;
          if (event.type === "history") {
            appendWriteHistoryEntry(event.value || {});
            return;
          }
          if (event.type === "reasoning") {
            if (!writeReasoningStartedAtRef.current) {
              writeReasoningStartedAtRef.current = performance.now();
            }
            writeReasoningStreamingRef.current = true;
            setStoryGenerationStatus("Thinking");
            setWriteReasoning((current) => ({
              ...current,
              text: `${current.text || ""}${String(event.value || "")}`,
              streaming: true,
              durationMs: null,
            }));
            return;
          }
          if (event.type === "content") {
            const value = String(event.value || "");
            if (writeReasoningStreamingRef.current && writeReasoningStartedAtRef.current) {
              const durationMs = performance.now() - writeReasoningStartedAtRef.current;
              writeReasoningStreamingRef.current = false;
              setWriteReasoning((current) => ({
                ...current,
                streaming: false,
                durationMs,
              }));
            }
            setStoryGenerationStatus("Writing");
            generatedText += value;
            if (writeGenerationMode === "new") {
              setChapterContent(generatedText);
              chapterContentRef.current = generatedText;
            }
            return;
          }
          if (event.type === "chapter_updated") {
            if (!chapterUpdateMatchesRun(event, run)) return;
            run.status = "applying";
            const result = event.value || {};
            const updatedChapter = chapterFromUpdateEvent(result);
            if (!updatedChapter) return;
            const nextContent = String(updatedChapter.content || "");
            const currentChapter = chapterSaveCoordinator.getConfirmedChapter(
              run.storyId,
              targetChapterId,
            ) || chaptersRef.current.find((chapter) => chapter.id === run.chapterId);
            if (currentChapter) {
              chapterSaveCoordinator.rememberServerChapter({
                ...currentChapter,
                ...updatedChapter,
              });
            }
            setChapters((current) => current.map((chapter) => (
              chapter.id === run.chapterId ? { ...chapter, ...updatedChapter } : chapter
            )));
            const route = routeRef.current;
            if (route?.page === "story" && route.storyId === run.storyId && route.chapterId === run.chapterId) {
              setChapterContent(nextContent);
              chapterContentRef.current = nextContent;
            }
            return;
          }
          if (event.type === "lorebook_start") {
            setStoryGenerationStatus("Editing Lorebook");
            return;
          }
          if (event.type === "lorebook") {
            const result = event.value || {};
            const appliedUpdates = Array.isArray(result.applied) ? result.applied : [];
            if (result.error || appliedUpdates.length === 0) {
              setStatus("Lorebook update skipped");
            }
            void storyApi.listLorebook(run.storyId).then(setLorebookEntries).catch((error) => {
              setStatus(error.message);
            });
          }
          if (event.type === "usage") {
            setLatestStoryGeneration(event.value || null);
          }
          if (event.type === "error") {
            streamFailed = true;
            const errorValue = event.value;
            if (errorValue?.code === "chapter_revision_conflict") {
              setStatus("Chapter changed while generation was running.");
              terminalStatus = "conflicted";
            } else {
              setStatus(chapterGenerationErrorMessage(errorValue));
            }
          }
        },
      });
      run.status = "reconciling";
      setStoryGenerationStatus("Reconciling");
      await reconcileGenerationRun(run);
      run.status = terminalStatus;
      if (!streamFailed) showToast("Finished chapter");
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus("Response stopped");
        terminalStatus = "aborted";
      } else {
        setStatus(error.message);
        terminalStatus = "failed";
      }
    } finally {
      if (run.status !== "reconciling") {
        run.status = "reconciling";
        setStoryGenerationStatus("Reconciling");
        try {
          await reconcileGenerationRun(run);
        } catch (error) {
          if (terminalStatus === "completed") terminalStatus = "failed";
        }
      }
      run.status = terminalStatus;
      setIsStreaming(false);
      setStoryGenerationStatus("");
      setWriteReasoning((current) => ({
        ...current,
        streaming: false,
        durationMs:
          current.durationMs ||
          (writeReasoningStartedAtRef.current
            ? performance.now() - writeReasoningStartedAtRef.current
            : null),
      }));
      writeReasoningStartedAtRef.current = null;
      writeReasoningStreamingRef.current = false;
      if (abortRef.current === abortController) abortRef.current = null;
      if (writeGenerationRunRef.current === run) writeGenerationRunRef.current = null;
      setStoryGenerationStatus("");
    }
  }

  const landingMessage = isWritingMode ? writingOpeningMessage : openingMessage;
  const visibleMessages = activeMessages;
  const visibleActiveChatId = activeConversationId;
  const showLandingComposer = isWritingMode ? isEmptyWriting : isEmptyChat;
  const showComposer =
    !(isWritingMode && ["lorebook", "characters", "brainstorm"].includes(storyWorkspaceView) && !showLandingComposer);

  return (
    <div className="flex h-screen overflow-hidden bg-[#070708] text-ink">
      {isWritingMode ? (
        <StoryRail
          stories={writingStories}
          chapters={chapters}
          activeStoryId={activeStoryId}
          activeChapterId={activeChapterId}
          mobileOpen={railOpen}
          onCloseMobile={() => setRailOpen(false)}
          collapsed={railCollapsed}
          onCollapse={() => setRailCollapsed(true)}
          onGoHome={() => resetChat({ mode: "write" })}
          onCreateChapter={createStoryChapter}
          onSelectStory={selectStory}
          onSelectChapter={selectChapter}
          onRenameStory={renameStoryItem}
          onRenameChapter={renameChapterItem}
          onDeleteStory={deleteStoryItem}
          onDeleteChapter={deleteChapterItem}
          onToggleChapterContext={toggleChapterContext}
          previousChatMode={previousChatMode}
          onChatModeChange={changeChatMode}
          navigationLocked={hasActiveWriteGeneration()}
        />
      ) : (
        <ConversationRail
          chats={sidebarChats}
          activeChatId={visibleActiveChatId}
          models={models}
          onNewChat={() => resetChat({ mode: chatMode })}
          onLoadChat={loadChat}
          onRenameChat={renameChat}
          onDeleteChat={deleteChat}
          onExportChat={exportChatFromMenu}
          onTogglePinChat={toggleChatPin}
          mobileOpen={railOpen}
          onCloseMobile={() => setRailOpen(false)}
          collapsed={railCollapsed}
          onCollapse={() => setRailCollapsed(true)}
          highlightFirstChatActions={tour.currentStep?.id === "chatActions"}
          chatMode={chatMode}
          previousChatMode={previousChatMode}
          onChatModeChange={changeChatMode}
        />
      )}
      <SidebarRevealButton
        visible={railCollapsed}
        onClick={() => setRailCollapsed(false)}
      />

      <main className="relative grid min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto]">
        <header className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex items-center gap-3 bg-transparent px-4 py-4 sm:px-8 lg:px-10">
          <IconButton
            label="Open chats"
            className="pointer-events-auto lg:hidden"
            onClick={() => setRailOpen(true)}
          >
            <Menu size={18} />
          </IconButton>
          {showLandingComposer && !isWritingMode && (
            <div className="ml-auto flex items-center gap-2">
              <HelpTourButton onClick={tour.start} />
              <TemporaryChatButton
                active={temporaryChat}
                onClick={toggleTemporaryChat}
              />
            </div>
          )}
          {showLandingComposer && isWritingMode && (
            <div className="ml-auto">
              <HelpTourButton onClick={startWriteTour} />
            </div>
          )}
        </header>

        <TemporaryChatMarker visible={!isWritingMode && temporaryChat && activeChatId === tempChatId && messages.length > 0} />

        {isWritingMode && !showLandingComposer && storyWorkspaceView === "brainstorm" ? (
          <StoryBrainstorm
            story={writingStories.find((story) => story.id === activeStoryId)}
            graphNodes={brainstormNodes}
            graphEdges={brainstormEdges}
            viewport={brainstormViewport}
            prompt={brainstormPrompt}
            setPrompt={setBrainstormPrompt}
            isStreaming={isStreaming}
            reasoning={brainstormReasoning}
            disabled={!keyStatus.has_key}
            modelLabel={promptModelName(models, settings.model)}
            thinkingEnabled={settings.thinking_enabled}
            contextMeter={<ContextWindowMeter info={contextWindowInfo} />}
            onBack={() => {
              setStoryWorkspaceView("chapter");
              writeRoute(storyRoute(activeStoryId, activeChapterId, "chapter"));
            }}
            onGenerate={generateBrainstorm}
            onStop={stopStream}
            onOpenSettings={() => setSettingsOpen(true)}
            onToggleThinking={toggleThinking}
            onUpdateNode={updateBrainstormNode}
            onDeleteNode={deleteBrainstormNode}
            onUpdateViewport={updateBrainstormViewport}
          />
        ) : isWritingMode && !showLandingComposer ? (
          <StoryWorkspace
            stories={writingStories}
            chapters={chapters}
            lorebookEntries={lorebookEntries}
            activeStoryId={activeStoryId}
            activeChapterId={activeChapterId}
            workspaceView={storyWorkspaceView}
            chapterContent={chapterContent}
            contextWindowInfo={contextWindowInfo}
            saveState={chapterSaveState}
            generationStatus={storyGenerationStatus}
            writeReasoning={writeReasoning}
            onOpenRail={() => setRailOpen(true)}
            onOpenLorebook={() => {
              setStoryWorkspaceView("lorebook");
              writeRoute(storyRoute(activeStoryId, activeChapterId, "lorebook"));
            }}
            onBackToChapter={() => {
              setStoryWorkspaceView("chapter");
              writeRoute(storyRoute(activeStoryId, activeChapterId, "chapter"));
            }}
            onChangeContent={updateChapterCanvasContent}
            onCanvasImportFallback={(error) => {
              console.error("Chapter Markdown opened as literal text", error);
              setStatus("Some chapter formatting opened as plain Markdown so no writing was lost.");
            }}
            onCreateLorebookEntry={createLorebookEntry}
            onUpdateLorebookEntry={updateLorebookEntry}
            onDeleteLorebookEntry={deleteLorebookEntry}
            onConfirmDeleteLorebookEntry={confirmDeleteLorebookEntry}
          />
        ) : !isWritingMode ? (
          <>
            <MessageList
              messages={visibleMessages}
              activeChatId={visibleActiveChatId}
              streamingMessageId={streamingMessageId}
              reasoningStreamingMessageId={reasoningStreamingMessageId}
              reasoningDurations={reasoningDurations}
              streamRef={streamRef}
              onScroll={markUserScroll}
              onWheel={markWheelIntent}
              onTouchStart={markTouchStart}
              onTouchMove={markTouchMove}
              onCopy={copyMessage}
              onRegenerate={regenerate}
              onEditUserMessage={editUserMessage}
              onDeleteUserMessage={deleteUserMessage}
            />

            <PromptNavigationRail
              messages={visibleMessages}
              streamRef={streamRef}
              visible={showPromptNavigationRail}
              activeChatId={visibleActiveChatId}
            />
          </>
        ) : (
          <EmptyChatState />
        )}

        {showComposer && (showLandingComposer ? (
          isWritingMode ? (
            <WriteLanding
              openingMessage={landingMessage}
              stories={stories}
              onStartNew={() => {
                if (!isStreaming) setNewStoryDialogOpen(true);
              }}
              onContinue={continueStory}
            />
          ) : (
            <Composer
              value={prompt}
              setValue={setPrompt}
              disabled={!keyStatus.has_key}
              isStreaming={isStreaming}
              settings={settings}
              models={models}
              contextWindowInfo={contextWindowInfo}
              modelLocked={activeModelLocked}
              onSubmit={() => sendMessage()}
              onStop={stopStream}
              onOpenSettings={() => setSettingsOpen(true)}
              onToggleThinking={toggleThinking}
              openingMessage={landingMessage}
              variant="empty"
              forceShowThinking={tourForceThinking}
            />
          )
        ) : (
          <Composer
            value={prompt}
            setValue={setPrompt}
            disabled={!keyStatus.has_key}
            isStreaming={isStreaming}
            settings={settings}
            models={models}
            contextWindowInfo={contextWindowInfo}
            modelLocked={activeModelLocked}
            onSubmit={() => (isWritingMode ? generateStoryChapter() : sendMessage())}
            onStop={stopStream}
            onOpenSettings={() => setSettingsOpen(true)}
            onToggleThinking={toggleThinking}
            showContextMeter
            writeGenerationMode={isWritingMode ? writeGenerationMode : null}
            onToggleWriteGenerationMode={toggleWriteGenerationMode}
            writeHistoryEntries={writeHistoryEntries}
            writeHistoryTitle={`${activeChapterTitle} history`}
            onOpenLorebook={() => {
              setStoryWorkspaceView("lorebook");
              writeRoute(storyRoute(activeStoryId, activeChapterId, "lorebook"));
            }}
            onOpenBrainstorm={openBrainstorm}
            systemPrompt={isWritingMode ? settings.system_prompt : ""}
            onSaveSystemPrompt={isWritingMode ? saveStorySystemPrompt : null}
            forceShowThinking={Boolean(writeTour.currentStep?.forceThinkingVisible)}
            tourUi={writeTour.currentStep?.composerUi || null}
          />
        ))}
      </main>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        keyStatus={keyStatus}
        onSaveKey={saveKey}
        chats={chats}
        activeChatId={activeChatId}
        models={models}
        chatMode={chatMode}
        settings={settings}
        setSettings={setSettings}
        defaultModel={defaultModel}
        hideFreeModels={hideFreeModels}
        nitroMode={nitroMode}
        smoothStreaming={smoothStreaming}
        showPromptNavigationRail={showPromptNavigationRail}
        modelLocked={activeModelLocked}
        onPersist={persistSettings}
        onModelSelected={(name) => showToast(`Model selected: ${name}`)}
        onSetDefaultModel={updateDefaultModel}
        onToggleHideFreeModels={updateHideFreeModels}
        onToggleNitroMode={updateNitroMode}
        onToggleSmoothStreaming={updateSmoothStreaming}
        onTogglePromptNavigationRail={updatePromptNavigationRail}
        onExportChats={exportChats}
        onImportChats={importChats}
      />
      <ConfirmModal
        dialog={confirmDialog}
        onClose={() => {
          confirmDialog?.onCancel?.();
          setConfirmDialog(null);
        }}
      />
      <NewStoryModal
        open={newStoryDialogOpen}
        onClose={() => setNewStoryDialogOpen(false)}
        onCreate={startNewStory}
      />
      <NotificationStack notifications={notifications} />
      {tour.isActive && tour.currentStep && (
        <TourOverlay
          step={tour.currentStep}
          stepNumber={tour.stepIndex + 1}
          stepCount={tour.stepCount}
          isLastStep={tour.isLastStep}
          onNext={tour.isLastStep ? tour.finish : tour.next}
          onPrevious={tour.previous}
          onClose={tour.finish}
        />
      )}
      {writeTour.isActive && writeTour.currentStep && (
        <TourOverlay
          step={writeTour.currentStep}
          stepNumber={writeTour.stepIndex + 1}
          stepCount={writeTour.stepCount}
          isLastStep={writeTour.isLastStep}
          onNext={writeTour.isLastStep ? finishWriteTour : writeTour.next}
          onPrevious={writeTour.previous}
          onClose={finishWriteTour}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
