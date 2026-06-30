import React, {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import {
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";

const DEFAULT_MODEL = "anthropic/claude-3.5-sonnet";
const DEFAULT_SYSTEM_PROMPT =
  "Respond concisely and carefully. Ask only when needed and prefer concrete next steps.";
const APP_SETTINGS_STORAGE_KEY = "routerchat.appSettings";

const newSettings = {
  model: DEFAULT_MODEL,
  temperature: 0.7,
  max_tokens: 30000,
  system_prompt: DEFAULT_SYSTEM_PROMPT,
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
  { id: "ui", label: "UI", iconClass: "fi fi-rr-apps-add" },
  { id: "cloud", label: "Cloud", iconClass: "fi fi-rr-cloud-upload-alt" },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
];

function rangeProgress(value, min, max) {
  return `${((Number(value) - min) / (max - min)) * 100}%`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  if (!response.ok) {
    throw new Error(await responseErrorDetail(response));
  }

  return response.json();
}

async function responseErrorDetail(response) {
  const fallback = response.statusText || "Request failed";
  const body = await response.text();
  if (!body) return fallback;

  try {
    const payload = JSON.parse(body);
    return payload.detail || fallback;
  } catch {
    return body;
  }
}

function cx(...classes) {
  return classes.filter(Boolean).join(" ");
}

const CONTROL_MOTION =
  "transition-[background-color,border-color,box-shadow,color,scale] duration-150 ease-out active:scale-[0.96]";
const SOFT_SURFACE =
  "shadow-[var(--shadow-border)] hover:shadow-[var(--shadow-border-hover)]";
const FADE_MOTION = "transition-opacity duration-150 ease-out";

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

function useRafScroller(streamRef) {
  const followRef = useRef(true);
  const rafRef = useRef(null);

  const isNearBottom = useCallback(() => {
    const node = streamRef.current;
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }, [streamRef]);

  const markUserScroll = useCallback(() => {
    followRef.current = isNearBottom();
  }, [isNearBottom]);

  const scrollToBottom = useCallback(
    (force = false) => {
      if (!force && !followRef.current) return;
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const node = streamRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      });
    },
    [streamRef],
  );

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return { isNearBottom, markUserScroll, scrollToBottom, followRef };
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

function ConversationRail({
  chats,
  activeChatId,
  models,
  onNewChat,
  onLoadChat,
  onRenameChat,
  onDeleteChat,
  mobileOpen,
  onCloseMobile,
  collapsed,
  onCollapse,
}) {
  const [railScrolling, setRailScrolling] = useState(false);
  const [renamingChatId, setRenamingChatId] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
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

  const historyItems =
    chats.length === 0 ? (
      <div className="px-3 py-8 text-pretty text-sm leading-6 text-zinc-500">
        Your conversations will appear here.
      </div>
    ) : (
      chats.map((chat) => {
        const renaming = renamingChatId === chat.id;

        return (
          <div
            key={chat.id}
            className={cx(
              "group grid select-none grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-2xl border border-transparent px-2 py-2 transition-[background-color,border-color,box-shadow] duration-150 ease-out",
              chat.id === activeChatId
                ? "bg-white/[0.08] shadow-[var(--shadow-border)]"
                : "hover:bg-white/[0.045] hover:shadow-[var(--shadow-border)]",
            )}
          >
            {renaming ? (
              <div className="min-h-10 min-w-0 rounded-xl px-1 py-1">
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
                <div className="mt-0.5 truncate text-xs text-zinc-500">
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
                  "min-h-10 min-w-0 rounded-xl px-1 py-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
                  CONTROL_MOTION,
                )}
              >
                <div className="truncate text-balance text-sm font-medium text-zinc-100">
                  {chat.title}
                </div>
                <div className="mt-0.5 truncate text-xs text-zinc-500">
                  {promptModelName(models, chat.model)}
                </div>
              </button>
            )}
            <div className="flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                title="Rename chat"
                aria-label={`Rename ${chat.title}`}
                onClick={() => startRename(chat)}
                className={cx(
                  "grid h-8 w-8 place-items-center rounded-full text-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
                  CONTROL_MOTION,
                  "hover:bg-white/[0.06] hover:text-zinc-200",
                )}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                title="Delete chat"
                aria-label={`Delete ${chat.title}`}
                onClick={() => onDeleteChat(chat.id)}
                className={cx(
                  "grid h-8 w-8 place-items-center rounded-full text-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/30",
                  CONTROL_MOTION,
                  "hover:bg-red-500/10 hover:text-red-300",
                )}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        );
      })
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
          <div className="mb-4 flex items-center gap-2">
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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatInteger(value) {
  if (!isFiniteNumber(value)) return "Unavailable";
  return new Intl.NumberFormat().format(value);
}

function formatCost(value) {
  if (!isFiniteNumber(value)) return "Unavailable";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 6 : 4,
    maximumFractionDigits: value < 0.01 ? 6 : 4,
  }).format(value);
}

function ContextWindowMeter({ info }) {
  const tooltipId = useId();
  const hasInfo = Boolean(info);
  const percent = hasInfo ? Math.min(Math.max(info.percentFull, 0), 100) : 0;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - percent / 100);
  const ariaLabel = hasInfo
    ? `Context window ${info.displayPercent}, ${info.displayUsage}`
    : "Context window unavailable";

  return (
    <span className="t-tt-wrap context-meter-wrap inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-describedby={tooltipId}
        className={cx(
          "t-tt-trigger grid h-[34px] w-[34px] place-items-center rounded-full text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
          CONTROL_MOTION,
          hasInfo && "text-zinc-400 hover:text-zinc-200",
        )}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="h-[22px] w-[22px] -rotate-90"
        >
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className={hasInfo ? "opacity-20" : "opacity-35"}
          />
          {hasInfo && (
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
              className="opacity-95 transition-[stroke-dashoffset] duration-300 ease-out"
            />
          )}
        </svg>
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="t-tt context-meter-tooltip"
      >
        <span className="block text-zinc-100">
          {hasInfo ? info.displayUsage : "Context window unavailable"}
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
          {editing ? (
            <div className="w-full rounded-[28px] bg-[#2f2f30] px-5 pb-5 pt-4 shadow-[0_0_0_1px_rgba(255,255,255,0.07),0_22px_70px_rgba(0,0,0,0.36)] transition-[background-color,box-shadow] duration-200 ease-out focus-within:bg-[#343435] focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.11),0_22px_70px_rgba(0,0,0,0.38)]">
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
            </div>
          ) : (
            <div className="whitespace-pre-wrap rounded-[22px] bg-blue-500/85 px-4 py-3 text-pretty text-sm leading-6 text-white shadow-lg shadow-blue-950/20">
              {message.content}
            </div>
          )}
          {!editing && (
            <div className={cx("flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100", FADE_MOTION)}>
              <IconButton
                label="Edit prompt"
                className="border-blue-300/20 bg-blue-400/10 text-blue-100 hover:bg-blue-300/20 hover:text-white"
                onClick={startEditing}
              >
                <Pencil size={14} />
              </IconButton>
              <IconButton
                label="Delete prompt"
                className="border-blue-300/20 bg-blue-400/10 text-blue-100 hover:bg-red-500/20 hover:text-red-100"
                onClick={() => onDeleteUserMessage(message)}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <article className="group max-w-none">
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
        <div className={cx("mt-3 flex -translate-x-1 gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100", FADE_MOTION)}>
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
    <div className="min-h-[54vh]" aria-hidden="true" />
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
  onCopy,
  onRegenerate,
  onEditUserMessage,
  onDeleteUserMessage,
}) {
  return (
    <section
      ref={streamRef}
      onScroll={onScroll}
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
}) {
  const canThink = supportsThinking(models, settings.model);
  const textareaRef = useRef(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = 126;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        isStreaming ? onStop() : onSubmit();
      }}
      className="bg-[#08080a]/90 px-4 py-4 backdrop-blur-xl sm:px-8 lg:px-10"
    >
      <div className="mx-auto max-w-4xl">
        <div
          className="rounded-[24px] bg-lift shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_22px_80px_rgba(0,0,0,0.45)] transition-[background-color,box-shadow] duration-500 ease-[cubic-bezier(0.2,0,0,1)] focus-within:bg-[#19191d] focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_20px_72px_rgba(0,0,0,0.42)]"
        >
          <div className="px-4 pt-3">
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
              placeholder="Ask Anything"
              className="block max-h-[126px] min-h-6 w-full resize-none bg-transparent text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
          <div className="flex items-end gap-2 px-2.5 pb-2.5 pt-1.5">
            <div className="ml-auto" />
            <ContextWindowMeter info={contextWindowInfo} />
            {canThink && (
              <button
                type="button"
                onClick={onToggleThinking}
                className={cx(
                  "relative inline-flex h-[34px] items-center gap-1 rounded-full px-2.5 text-[11px] font-medium before:absolute before:-inset-[3px] before:content-[''] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                  CONTROL_MOTION,
                  SOFT_SURFACE,
                  settings.thinking_enabled
                    ? "bg-accent/15 text-blue-200"
                    : "bg-white/[0.035] text-zinc-500 hover:text-zinc-200",
                )}
              >
                Thinking
              </button>
            )}
            <button
              type="button"
              onClick={onOpenSettings}
              className={cx(
                "relative inline-flex h-[34px] min-w-0 max-w-[190px] items-center gap-1 rounded-full bg-white/[0.035] px-2.5 text-[11px] font-medium text-zinc-400 before:absolute before:-inset-[3px] before:content-[''] hover:bg-white/[0.07] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 sm:max-w-[240px]",
                CONTROL_MOTION,
                SOFT_SURFACE,
              )}
            >
              <Settings2 size={12} />
              <span className="truncate">{promptModelName(models, settings.model)}</span>
              {modelLocked && <span className="text-zinc-600">locked</span>}
            </button>
            <button
              type="submit"
              disabled={!isStreaming && (!value.trim() || disabled)}
              className={cx(
                "group relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                CONTROL_MOTION,
                isStreaming
                  ? "text-zinc-950"
                  : "text-zinc-950 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:active:scale-100",
              )}
              aria-label={isStreaming ? "Stop" : "Send"}
              title={isStreaming ? "Stop" : "Send"}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "absolute inset-[3px] rounded-full transition-colors duration-150 ease-out",
                  isStreaming
                    ? "bg-zinc-200"
                    : "bg-accent group-hover:bg-blue-300 group-disabled:bg-zinc-800",
                )}
              />
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
    </form>
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
  settings,
  setSettings,
  defaultModel,
  hideFreeModels,
  nitroMode,
  smoothStreaming,
  modelLocked,
  onPersist,
  onModelSelected,
  onSetDefaultModel,
  onToggleHideFreeModels,
  onToggleNitroMode,
  onToggleSmoothStreaming,
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
  const [openAccordions, setOpenAccordions] = useState({
    cloudChats: true,
    reasoning: true,
    generation: true,
  });
  const fileInputRef = useRef(null);
  const canThink = supportsThinking(models, settings.model);
  const selectedModel = models.find((model) => model.id === settings.model);
  const selectedModelPrice = selectedModel ? priceLabel(selectedModel) : "";
  const keyConnected = Boolean(keyStatus.has_key);
  const activePageIndex = SETTINGS_PAGES.findIndex((page) => page.id === activePage) + 1;
  const selectedCloudChat = chats.find((chat) => chat.id === selectedCloudChatId);
  const activeCloudChat = chats.find((chat) => chat.id === activeChatId);
  const cloudChat = selectedCloudChat || activeCloudChat || chats[0];
  const cloudChatId = cloudChat?.id || "";

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
      })
      .slice(0, 90);
  }, [hideFreeModels, models, query]);

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

  const importExportSection = (
    <section>
      <div className="border-b border-white/[0.08] pb-3">
        <h2 className="flex items-center gap-2 text-balance text-sm font-semibold text-zinc-100">
          <span className="settings-cloud-icon" aria-hidden="true">
            <i className="fi fi-rr-cloud-upload-alt" />
          </span>
          Cloud
        </h2>
        <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
          Share a selected conversation as a JSON file.
        </p>
      </div>

      <Accordion
        id="cloudChats"
        title="Chat"
        open={openAccordions.cloudChats}
        onToggle={toggleAccordion}
        trailing={cloudChat ? promptModelName(models, cloudChat.model) : "None"}
      >
        <SearchClearField
          value={cloudSearch}
          onChange={setCloudSearch}
          placeholder="Search chats"
        />
        <div className="mt-2 max-h-36 space-y-1 overflow-y-auto pr-1">
          {filteredCloudChats.length === 0 ? (
            <div className="rounded-xl bg-black/15 px-3 py-3 text-pretty text-xs leading-5 text-zinc-500 shadow-[var(--shadow-border)]">
              {chats.length === 0 ? "No chats yet." : "No matching chats."}
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
                    "grid min-h-10 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2.5 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                    CONTROL_MOTION,
                    selected
                      ? "bg-white/[0.08] text-zinc-100 shadow-[var(--shadow-border)]"
                      : "text-zinc-300 hover:bg-white/[0.045] hover:text-zinc-100",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {chat.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-zinc-500">
                      {promptModelName(models, chat.model)}
                    </span>
                  </span>
                  {selected && <Check size={14} className="text-zinc-200" />}
                </button>
              );
            })
          )}
        </div>
      </Accordion>

      <section className="border-b border-white/[0.08] py-3">
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
          "min-h-6 px-1 py-2 text-xs leading-5 text-zinc-500 transition-[opacity,filter,transform] duration-150 ease-out",
          transferMessage
            ? "translate-y-0 opacity-100 blur-0"
            : "-translate-y-1 opacity-0 blur-[2px]",
        )}
      >
        {transferMessage || "\u00a0"}
      </p>
    </section>
  );

  const modelList = (
    <section className="flex min-h-0 flex-1 flex-col rounded-2xl bg-white/[0.035] shadow-[var(--shadow-border)]">
      <div className="p-3 pb-2.5">
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
        <div className="flex h-10 items-center gap-2 rounded-xl bg-black/20 px-3 text-zinc-500 shadow-[var(--shadow-border)] transition-[background-color,box-shadow] duration-150 ease-out focus-within:bg-black/25 focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.16)]">
          <Search size={15} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] tabular-nums text-zinc-500">
            {filteredModels.length}
          </span>
        </div>
        {modelLocked && (
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-600">
            Model selection is locked after the first message in a chat.
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3 pt-1">
        {filteredModels.length === 0 ? (
          <div className="rounded-[18px] bg-black/15 p-4 text-pretty text-sm leading-6 text-zinc-500 shadow-[var(--shadow-border)]">
            {models.length === 0 ? "Save an API key to load models." : "No matching models."}
          </div>
        ) : (
          filteredModels.map((model) => {
            const isSelected = model.id === settings.model;
            const modelPrice = priceLabel(model);
            return (
            <div
              key={model.id}
              className={cx(
                "min-h-14 w-full rounded-xl border p-2.5",
                isSelected
                  ? "border-white/[0.14] bg-white/[0.07] shadow-[var(--shadow-border-hover)]"
                  : "border-transparent bg-black/15 shadow-[var(--shadow-border)] hover:bg-white/[0.05] hover:shadow-[var(--shadow-border-hover)]",
              )}
            >
              <button
                type="button"
                disabled={modelLocked}
                onClick={() => selectModel(model)}
                className={cx(
                  "block w-full min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                  CONTROL_MOTION,
                  modelLocked && !isSelected && "cursor-not-allowed opacity-45 active:scale-100",
                )}
              >
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-zinc-100">
                  <span className="truncate">{model.name}</span>
                  {modelPrice && (
                    <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-xs font-medium leading-none tabular-nums text-zinc-400 shadow-[var(--shadow-border)]">
                      {modelPrice}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-xs text-zinc-500">
                  {model.id}
                </span>
              </button>
            </div>
          );
          })
        )}
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
        Choose how much extra reasoning the model should use.
      </p>
      <SlidingTabs
        options={REASONING_EFFORTS}
        value={settings.reasoning_effort}
        onChange={(value) => commit({ reasoning_effort: value })}
        getValue={(effort) => effort.value}
        getLabel={(effort) => effort.shortLabel || effort.label}
        ariaLabel="Reasoning effort"
        disabled={!canThink}
        className="w-full"
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
        Tune response variation and the maximum reply budget.
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
            <span className="text-zinc-400">Max tokens</span>
            <span className="min-w-16 rounded-full bg-white/[0.055] px-2 py-0.5 text-center tabular-nums text-zinc-200 shadow-[var(--shadow-border)]">
              {settings.max_tokens}
            </span>
          </div>
          <input
            type="range"
            min="256"
            max="128000"
            step="1000"
            value={settings.max_tokens}
            onChange={(event) => updateSetting({ max_tokens: Number(event.target.value) })}
            onMouseUp={() => onPersist(settings)}
            onTouchEnd={() => onPersist(settings)}
            style={{ "--range-progress": rangeProgress(settings.max_tokens, 256, 128000) }}
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
            {SETTINGS_PAGES.map((page) => {
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
                {SETTINGS_PAGES.find((page) => page.id === activePage)?.label || "Settings"}
              </h1>
              <div className="md:hidden">
                <IconButton label="Close settings" onClick={onClose}>
                  <X size={17} />
                </IconButton>
              </div>
            </div>
            <SlidingTabs
              options={SETTINGS_PAGES}
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
              className="settings-scroll-page t-page space-y-0 overflow-y-auto px-4 py-3 md:px-4 md:py-3"
              data-page-id="3"
              aria-label="UI settings"
            >
              {smoothTextSection}
            </section>
            <section
              className="settings-scroll-page t-page space-y-0 overflow-y-auto px-4 py-3 md:px-4 md:py-3"
              data-page-id="4"
              aria-label="Cloud settings"
            >
              {importExportSection}
            </section>
            <section
              className="settings-scroll-page t-page space-y-0 overflow-y-auto px-4 py-3 md:px-4 md:py-3"
              data-page-id="5"
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

  useEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return undefined;

    function moveToActive(animate) {
      const activeTab =
        bar.querySelector('[aria-selected="true"]') ||
        bar.querySelector(".t-tab");
      if (!activeTab) return;

      if (!animate) {
        const previousTransition = pill.style.transition;
        pill.style.transition = "none";
        pill.style.transform = `translateX(${activeTab.offsetLeft}px)`;
        pill.style.width = `${activeTab.offsetWidth}px`;
        void pill.offsetWidth;
        pill.style.transition = previousTransition;
        return;
      }

      pill.style.transform = `translateX(${activeTab.offsetLeft}px)`;
      pill.style.width = `${activeTab.offsetWidth}px`;
    }

    function handleResize() {
      moveToActive(false);
    }

    requestAnimationFrame(() => {
      moveToActive(measuredRef.current);
      measuredRef.current = true;
    });
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [options, value]);

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

function Toast({ message }) {
  return <StatusPill message={message || ""} />;
}

function StatusPill({ message }) {
  return (
    <div
      aria-live="polite"
      className={cx(
        "pointer-events-none fixed right-4 top-4 z-[70] max-w-[calc(100vw-2rem)] rounded-full bg-white/[0.035] px-3 py-1.5 text-xs font-medium text-zinc-500 shadow-[var(--shadow-border)] backdrop-blur-xl transition-[opacity,filter,transform] duration-200 ease-out sm:right-6 sm:top-6",
        message
          ? "translate-y-0 opacity-100 blur-0"
          : "translate-y-[-8px] opacity-0 blur-[4px]",
      )}
    >
      {message || "\u00a0"}
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

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
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
    </div>
  );
}

function App() {
  const localAppSettings = readLocalAppSettings();
  const [chats, setChats] = useState([]);
  const [messages, setMessages] = useState([]);
  const [models, setModels] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [settings, setSettings] = useState(newSettings);
  const [defaultModel, setDefaultModel] = useState(DEFAULT_MODEL);
  const [hideFreeModels, setHideFreeModels] = useState(Boolean(localAppSettings.hide_free_models));
  const [nitroMode, setNitroMode] = useState(Boolean(localAppSettings.nitro_mode));
  const [smoothStreaming, setSmoothStreaming] = useState(Boolean(localAppSettings.smooth_streaming));
  const [keyStatus, setKeyStatus] = useState({ has_key: false });
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState(null);
  const [reasoningStreamingMessageId, setReasoningStreamingMessageId] = useState(null);
  const [reasoningDurations, setReasoningDurations] = useState({});
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [toast, setToast] = useState("");
  const abortRef = useRef(null);
  const reasoningStartedAtRef = useRef({});
  const streamRef = useRef(null);
  const { isNearBottom, markUserScroll, scrollToBottom, followRef } =
    useRafScroller(streamRef);

  const modelLocked = Boolean(activeChatId && messages.length > 0);
  const contextWindowInfo = useMemo(() => {
    const selectedModel = models.find((model) => model.id === settings.model);
    const contextLimit = getModelContextLimit(selectedModel);
    const latestAssistantWithUsage = [...messages]
      .reverse()
      .find((message) => {
        if (message.role !== "assistant") return false;
        if (toFiniteNumber(message.total_tokens) !== null) return true;
        return (
          toFiniteNumber(message.prompt_tokens) !== null &&
          toFiniteNumber(message.completion_tokens) !== null
        );
      });
    const totalTokens = toFiniteNumber(latestAssistantWithUsage?.total_tokens);
    const promptTokens = toFiniteNumber(latestAssistantWithUsage?.prompt_tokens);
    const completionTokens = toFiniteNumber(latestAssistantWithUsage?.completion_tokens);
    const contextTokens =
      totalTokens ?? (
        promptTokens !== null && completionTokens !== null
          ? promptTokens + completionTokens
          : null
      );

    return getContextWindowInfo(contextTokens, contextLimit);
  }, [messages, models, settings.model]);

  function showToast(message) {
    setToast(message);
    window.clearTimeout(showToast.timeoutId);
    showToast.timeoutId = window.setTimeout(() => setToast(""), 2600);
  }

  useEffect(() => {
    if (!status) return undefined;
    const timeoutId = window.setTimeout(() => setStatus(""), 2600);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  const loadChats = useCallback(async () => {
    const payload = await api("/api/chats");
    setChats(payload.chats || []);
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const payload = await api("/api/models");
      const loaded = payload.models || [];
      setModels(loaded);
      setSettings((current) => {
        const currentModel = loaded.find((model) => model.id === current.model);
        if (
          currentModel &&
          (activeChatId || !hideFreeModels || !isFreeModel(currentModel))
        ) {
          return current;
        }
        const selectableModels = hideFreeModels
          ? loaded.filter((model) => !isFreeModel(model))
          : loaded;
        const fallbackModel = selectableModels.some((model) => model.id === defaultModel)
          ? defaultModel
          : selectableModels[0]?.id || loaded[0]?.id || DEFAULT_MODEL;
        return { ...current, model: fallbackModel };
      });
    } catch (error) {
      setStatus(error.message);
    }
  }, [activeChatId, defaultModel, hideFreeModels]);

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
      setHideFreeModels(nextHideFreeModels);
      setNitroMode(nextNitroMode);
      setSmoothStreaming(nextSmoothStreaming);
      writeLocalAppSettings({
        hide_free_models: nextHideFreeModels,
        nitro_mode: nextNitroMode,
        smooth_streaming: nextSmoothStreaming,
      });
      setSettings((current) => (
        activeChatId
          ? { ...current, nitro_mode: nextNitroMode }
          : { ...current, model: nextDefaultModel, nitro_mode: nextNitroMode }
      ));
    } catch (error) {
      setStatus(error.message);
    }
  }, [activeChatId]);

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
  }, [loadAppSettings, loadChats, loadKeyStatus, loadModels]);

  useEffect(() => {
    scrollToBottom(true);
  }, [activeChatId, scrollToBottom]);

  function applyChat(chat, nextMessages) {
    setActiveChatId(chat.id);
    setMessages(nextMessages || []);
    setSettings({
      model: chat.model,
      temperature: chat.temperature,
      max_tokens: chat.max_tokens,
      system_prompt: chat.system_prompt || DEFAULT_SYSTEM_PROMPT,
      thinking_enabled: Boolean(chat.thinking_enabled),
      reasoning_effort: chat.reasoning_effort || "medium",
      nitro_mode: nitroMode,
    });
  }

  async function loadChat(chatId) {
    const payload = await api(`/api/chats/${chatId}`);
    applyChat(payload.chat, payload.messages || []);
  }

  async function persistSettings(nextSettings = settings) {
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

  function resetChat() {
    const selectableModels = hideFreeModels
      ? models.filter((model) => !isFreeModel(model))
      : models;
    const nextModel = selectableModels.some((model) => model.id === defaultModel)
      ? defaultModel
      : selectableModels[0]?.id || defaultModel;
    setActiveChatId(null);
    setMessages([]);
    setSettings((current) => ({
      ...newSettings,
      model: nextModel || current.model,
      nitro_mode: nitroMode,
    }));
    setPrompt("");
    setStatus("");
  }

  async function updateDefaultModel(modelId) {
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ default_model: modelId }),
      });
      const nextDefaultModel = payload.default_model || modelId;
      setDefaultModel(nextDefaultModel);
      if (!activeChatId) {
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

  async function createChat() {
    const payload = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify(settings),
    });
    applyChat(payload.chat, []);
    await loadChats();
    return payload.chat;
  }

  async function ensureChat() {
    if (activeChatId) return activeChatId;
    return (await createChat()).id;
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
          if (chatId === activeChatId) resetChat();
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
      await api(`/api/chats/${chatId}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      await loadChats();
    } catch (error) {
      setStatus(error.message);
      throw error;
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

  async function readStream(response, assistantId, savedAssistantId = assistantId) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const smoothBuffers = { content: "", reasoning: "" };
    let smoothFrame = null;

    function applyStreamText(nextContent, nextReasoning) {
      if (!nextContent && !nextReasoning) return;
      setMessages((current) =>
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

    try {
      const chatId = await ensureChat();
      const shouldAddUser = !regenerateMessageId;
      const userMessage = {
        id: `local-user-${crypto.randomUUID()}`,
        chat_id: chatId,
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      };
      const assistantId = `local-assistant-${crypto.randomUUID()}`;
      currentAssistantId = assistantId;
      const assistantMessage = {
        id: assistantId,
        chat_id: chatId,
        role: "assistant",
        content: "",
        reasoning: "",
        created_at: new Date().toISOString(),
      };

      followRef.current = true;
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
      scrollToBottom(true);

      const response = await fetch(`/api/chats/${chatId}/messages/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          ...settings,
          message: text,
          regenerate_message_id: regenerateMessageId,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(await responseErrorDetail(response));
      }

      const savedAssistantId = response.headers.get("X-Assistant-Message-Id") || assistantId;
      await readStream(response, assistantId, savedAssistantId);
      await loadChats();
      await loadChat(chatId);
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus("Response stopped");
      } else {
        setStatus(error.message);
        setMessages((current) =>
          current.map((message) =>
            message.id === currentAssistantId
              ? { ...message, content: error.message }
              : message,
          ),
        );
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
      const payload = await api(`/api/chats/${activeChatId}/messages/${message.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content }),
      });
      applyChat(payload.chat, payload.messages || []);
      setStatus("Prompt updated. Regenerating...");
      void sendMessage(content, message.id);
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
      if (activeChatId) persistSettings(next);
      return next;
    });
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#070708] text-ink">
      <ConversationRail
        chats={chats}
        activeChatId={activeChatId}
        models={models}
        onNewChat={resetChat}
        onLoadChat={loadChat}
        onRenameChat={renameChat}
        onDeleteChat={deleteChat}
        mobileOpen={railOpen}
        onCloseMobile={() => setRailOpen(false)}
        collapsed={railCollapsed}
        onCollapse={() => setRailCollapsed(true)}
      />
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
        </header>

        <MessageList
          messages={messages}
          activeChatId={activeChatId}
          streamingMessageId={streamingMessageId}
          reasoningStreamingMessageId={reasoningStreamingMessageId}
          reasoningDurations={reasoningDurations}
          streamRef={streamRef}
          onScroll={markUserScroll}
          onCopy={copyMessage}
          onRegenerate={regenerate}
          onEditUserMessage={editUserMessage}
          onDeleteUserMessage={deleteUserMessage}
        />

        <Composer
          value={prompt}
          setValue={setPrompt}
          disabled={!keyStatus.has_key}
          isStreaming={isStreaming}
          settings={settings}
          models={models}
          contextWindowInfo={contextWindowInfo}
          modelLocked={modelLocked}
          onSubmit={() => sendMessage()}
          onStop={stopStream}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleThinking={toggleThinking}
        />
      </main>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        keyStatus={keyStatus}
        onSaveKey={saveKey}
        chats={chats}
        activeChatId={activeChatId}
        models={models}
        settings={settings}
        setSettings={setSettings}
        defaultModel={defaultModel}
        hideFreeModels={hideFreeModels}
        nitroMode={nitroMode}
        smoothStreaming={smoothStreaming}
        modelLocked={modelLocked}
        onPersist={persistSettings}
        onModelSelected={(name) => showToast(`Model selected: ${name}`)}
        onSetDefaultModel={updateDefaultModel}
        onToggleHideFreeModels={updateHideFreeModels}
        onToggleNitroMode={updateNitroMode}
        onToggleSmoothStreaming={updateSmoothStreaming}
        onExportChats={exportChats}
        onImportChats={importChats}
      />
      <ConfirmModal
        dialog={confirmDialog}
        onClose={() => setConfirmDialog(null)}
      />
      <StatusPill message={status} />
      <Toast message={toast} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
