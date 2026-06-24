import React, {
  memo,
  useCallback,
  useEffect,
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
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";

const DEFAULT_MODEL = "anthropic/claude-3.5-sonnet";
const DEFAULT_SYSTEM_PROMPT =
  "Respond concisely and carefully. Ask only when needed and prefer concrete next steps.";

const newSettings = {
  model: DEFAULT_MODEL,
  temperature: 0.7,
  max_tokens: 30000,
  system_prompt: DEFAULT_SYSTEM_PROMPT,
  thinking_enabled: false,
  reasoning_effort: "medium",
};

const REASONING_EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).detail || detail;
    } catch {
      detail = await response.text();
    }
    throw new Error(detail);
  }

  return response.json();
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

function priceLabel(model) {
  const prompt = Number(model.pricing?.prompt || 0) * 1000000;
  const completion = Number(model.pricing?.completion || 0) * 1000000;
  if ((!prompt && !completion) || prompt < 0 || completion < 0) return "";
  return `$${prompt.toFixed(prompt >= 1 ? 0 : 2)} / $${completion.toFixed(
    completion >= 1 ? 0 : 2,
  )}`;
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

const ThinkingBlock = memo(function ThinkingBlock({ reasoning, streaming }) {
  const [open, setOpen] = useState(false);

  if (!reasoning) return null;

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
        <span className={streaming ? "t-shimmer" : undefined} data-text="Thinking">
          Thinking
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
            <div className="w-full rounded-[24px] bg-blue-500/20 p-3 shadow-[var(--shadow-surface)]">
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
                className="max-h-[220px] min-h-[92px] w-full resize-none rounded-xl bg-black/20 px-3 py-2 text-sm leading-6 text-white shadow-[var(--shadow-border)] outline-none transition-[box-shadow] duration-150 ease-out placeholder:text-blue-100/60 focus:shadow-[0_0_0_1px_rgba(255,255,255,0.16)]"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelEditing}
                  className={cx(
                    "inline-flex min-h-10 items-center rounded-full px-3 text-xs font-medium text-blue-100 shadow-[var(--shadow-border)] hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200/35",
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
                    "inline-flex min-h-10 items-center rounded-full bg-white px-3 text-xs font-semibold text-zinc-950 hover:bg-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-100/60 disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-zinc-700 disabled:active:scale-100",
                    CONTROL_MOTION,
                  )}
                >
                  {saving ? "Saving" : "Save"}
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
      <ThinkingBlock reasoning={message.reasoning} streaming={streaming} />
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
          className="rounded-[28px] bg-lift shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_22px_80px_rgba(0,0,0,0.45)] transition-[background-color,box-shadow] duration-500 ease-[cubic-bezier(0.2,0,0,1)] focus-within:bg-[#19191d] focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_20px_72px_rgba(0,0,0,0.42)]"
        >
          <div className="px-5 pt-4">
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
              className="block max-h-[126px] min-h-7 w-full resize-none bg-transparent text-[15px] leading-7 text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
          <div className="flex items-end gap-2 px-3 pb-3 pt-2">
            <div className="ml-auto" />
            {canThink && (
              <button
                type="button"
                onClick={onToggleThinking}
                className={cx(
                  "inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
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
                "inline-flex h-10 min-w-0 max-w-[190px] items-center gap-1.5 rounded-full bg-white/[0.035] px-3 text-[11px] font-medium text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 sm:max-w-[240px]",
                CONTROL_MOTION,
                SOFT_SURFACE,
              )}
            >
              <Settings2 size={13} />
              <span className="truncate">{promptModelName(models, settings.model)}</span>
              {modelLocked && <span className="text-zinc-600">locked</span>}
            </button>
            <button
              type="submit"
              disabled={!isStreaming && (!value.trim() || disabled)}
              className={cx(
                "relative inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                CONTROL_MOTION,
                isStreaming
                  ? "bg-zinc-200 text-zinc-950"
                  : "bg-accent text-zinc-950 hover:bg-blue-300 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-600 disabled:active:scale-100",
              )}
              aria-label={isStreaming ? "Stop" : "Send"}
              title={isStreaming ? "Stop" : "Send"}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "absolute inset-0 grid place-items-center transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
                  isStreaming
                    ? "scale-100 opacity-100 blur-0"
                    : "scale-[0.25] opacity-0 blur-[4px]",
                )}
              >
                <Square size={15} />
              </span>
              <span
                aria-hidden="true"
                className={cx(
                  "absolute inset-0 grid place-items-center transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
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
  models,
  settings,
  setSettings,
  modelLocked,
  onPersist,
  onModelSelected,
}) {
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const canThink = supportsThinking(models, settings.model);
  const selectedModel = models.find((model) => model.id === settings.model);
  const selectedModelPrice = selectedModel ? priceLabel(selectedModel) : "";
  const keyConnected = Boolean(keyStatus.has_key);

  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return models
      .filter((model) => {
        if (!normalized) return true;
        return [model.name, model.id, model.description]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalized));
      })
      .slice(0, 90);
  }, [models, query]);

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

  return (
    <>
      <div
        className={cx(
          "fixed inset-0 z-40 bg-black/45 opacity-0 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-200 ease-out",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none",
        )}
        onClick={onClose}
      />
      <aside
        className={cx(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-[460px] flex-col bg-[#0d0d10] shadow-[var(--shadow-surface)] transition-transform duration-200 ease-out sm:inset-y-3 sm:right-3 sm:max-h-[calc(100vh-1.5rem)] sm:rounded-[28px]",
          open ? "translate-x-0" : "translate-x-[calc(100%+1rem)]",
        )}
        aria-hidden={!open}
      >
        <div className="p-4 pb-3 sm:p-5 sm:pb-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-balance text-lg font-semibold tracking-[-0.01em] text-zinc-100">
                Settings
              </div>
            </div>
            <IconButton label="Close settings" onClick={onClose}>
              <X size={17} />
            </IconButton>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-5 sm:px-5">
          <section className="rounded-[24px] bg-white/[0.035] p-3 shadow-[var(--shadow-border)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-balance text-sm font-semibold text-zinc-100">
                  OpenRouter key
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
                </h2>
              </div>
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-or-v1-..."
                className="h-11 min-w-0 flex-1 rounded-2xl bg-black/20 px-4 text-sm text-zinc-100 shadow-[var(--shadow-border)] outline-none transition-[background-color,box-shadow] duration-150 ease-out placeholder:text-zinc-600 focus:bg-black/25 focus:shadow-[0_0_0_1px_rgba(255,255,255,0.16)]"
              />
              <button
                type="button"
                onClick={saveKey}
                disabled={saving || !apiKey.trim()}
                className={cx(
                  "h-11 rounded-2xl bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 disabled:shadow-[var(--shadow-border)] disabled:active:scale-100",
                  CONTROL_MOTION,
                )}
              >
                {saving ? "Saving" : "Save"}
              </button>
            </div>
          </section>

          <section className="rounded-[24px] bg-white/[0.035] shadow-[var(--shadow-border)]">
            <div className="p-3 pb-2">
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
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {selectedModel?.name || settings.model}
                  </p>
                </div>
                {selectedModelPrice && (
                  <span className="shrink-0 rounded-full bg-accent/10 px-2.5 py-1 text-[11px] font-medium tabular-nums text-blue-200 shadow-[0_0_0_1px_rgba(96,165,250,0.22)]">
                    {selectedModelPrice}
                  </span>
                )}
              </div>
              <div className="flex h-11 items-center gap-2 rounded-2xl bg-black/20 px-3 text-zinc-500 shadow-[var(--shadow-border)] transition-[background-color,box-shadow] duration-150 ease-out focus-within:bg-black/25 focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.16)]">
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
            <div className="max-h-[360px] space-y-2 overflow-y-auto px-3 pb-3 pt-1">
              {filteredModels.length === 0 ? (
                <div className="rounded-[18px] bg-black/15 p-4 text-pretty text-sm leading-6 text-zinc-500 shadow-[var(--shadow-border)]">
                  {models.length === 0 ? "Save an API key to load models." : "No matching models."}
                </div>
              ) : (
                filteredModels.map((model) => (
                  <button
                    type="button"
                    key={model.id}
                    disabled={modelLocked}
                    onClick={() => selectModel(model)}
                    className={cx(
                      "grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                      CONTROL_MOTION,
                      model.id === settings.model
                        ? "border-accent/55 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(96,165,250,0.18),0_10px_24px_rgba(37,99,235,0.10)]"
                        : "border-transparent bg-black/15 shadow-[var(--shadow-border)] hover:bg-white/[0.05] hover:shadow-[var(--shadow-border-hover)]",
                      modelLocked && model.id !== settings.model && "cursor-not-allowed opacity-45 active:scale-100",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-zinc-100">
                        {model.name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-zinc-500">
                        {model.id}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {priceLabel(model) && (
                        <span className="rounded-full bg-white/[0.06] px-2 py-1 text-[11px] font-medium tabular-nums text-zinc-500 shadow-[var(--shadow-border)]">
                          {priceLabel(model)}
                        </span>
                      )}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="space-y-4 rounded-[24px] bg-white/[0.035] p-3 shadow-[var(--shadow-border)]">
            <div>
              <div className="mb-2 flex items-center justify-between gap-3 text-xs font-medium">
                <div>
                  <h2 className="text-balance text-sm font-semibold text-zinc-100">
                    Reasoning
                  </h2>
                  <p className="mt-0.5 text-pretty text-xs leading-5 text-zinc-500">
                    Choose how much extra reasoning the model should use.
                  </p>
                </div>
                {!canThink && (
                  <span className="rounded-full bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-600 shadow-[var(--shadow-border)]">
                    Unavailable
                  </span>
                )}
              </div>
              <div className={cx("grid grid-cols-2 gap-2 sm:grid-cols-4", !canThink && "opacity-55")}>
                {REASONING_EFFORTS.map((effort) => (
                  <button
                    key={effort.value}
                    type="button"
                    disabled={!canThink}
                    onClick={() => commit({ reasoning_effort: effort.value })}
                    className={cx(
                      "min-h-10 rounded-full text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                      CONTROL_MOTION,
                      settings.reasoning_effort === effort.value
                        ? "bg-accent/15 text-blue-200 shadow-[0_0_0_1px_rgba(96,165,250,0.45)]"
                        : "bg-white/[0.035] text-zinc-500 shadow-[var(--shadow-border)] hover:bg-white/[0.07] hover:text-zinc-100 hover:shadow-[var(--shadow-border-hover)]",
                      !canThink && "cursor-not-allowed hover:bg-white/[0.035] hover:text-zinc-500 active:scale-100",
                    )}
                  >
                    {effort.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-[24px] bg-white/[0.035] p-3 shadow-[var(--shadow-border)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-balance text-sm font-semibold text-zinc-100">
                  Generation
                </h2>
                <p className="mt-0.5 text-pretty text-xs leading-5 text-zinc-500">
                  Tune response variation and the maximum reply budget.
                </p>
              </div>
            </div>
            <div className="rounded-[18px] bg-black/15 p-3 shadow-[var(--shadow-border)]">
              <div className="mb-3 flex items-center justify-between text-xs font-medium">
                <span className="text-zinc-400">Temperature</span>
                <span className="rounded-full bg-white/[0.05] px-2 py-0.5 tabular-nums text-zinc-200 shadow-[var(--shadow-border)]">
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
                className="w-full accent-accent"
              />
            </div>
            <div className="rounded-[18px] bg-black/15 p-3 shadow-[var(--shadow-border)]">
              <div className="mb-3 flex items-center justify-between text-xs font-medium">
                <span className="text-zinc-400">Max tokens</span>
                <span className="rounded-full bg-white/[0.05] px-2 py-0.5 tabular-nums text-zinc-200 shadow-[var(--shadow-border)]">
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
                className="w-full accent-accent"
              />
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}

function Toast({ message }) {
  return <StatusPill message={message ? "Model selected" : ""} />;
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
            <span className="shrink-0">Delete chat</span>
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
          <div className="flex shrink-0 justify-end gap-2">
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
        </div>
      </section>
    </div>
  );
}

function App() {
  const [chats, setChats] = useState([]);
  const [messages, setMessages] = useState([]);
  const [models, setModels] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [settings, setSettings] = useState(newSettings);
  const [keyStatus, setKeyStatus] = useState({ has_key: false });
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [toast, setToast] = useState("");
  const abortRef = useRef(null);
  const streamRef = useRef(null);
  const { isNearBottom, markUserScroll, scrollToBottom, followRef } =
    useRafScroller(streamRef);

  const modelLocked = Boolean(activeChatId && messages.length > 0);

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
        if (loaded.some((model) => model.id === current.model)) return current;
        return { ...current, model: loaded[0]?.id || DEFAULT_MODEL };
      });
    } catch (error) {
      setStatus(error.message);
    }
  }, []);

  const loadKeyStatus = useCallback(async () => {
    try {
      setKeyStatus(await api("/api/settings/key-status"));
    } catch (error) {
      setStatus(error.message);
    }
  }, []);

  useEffect(() => {
    loadKeyStatus();
    loadModels();
    loadChats();
  }, [loadChats, loadKeyStatus, loadModels]);

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
    setActiveChatId(null);
    setMessages([]);
    setSettings((current) => ({
      ...newSettings,
      model: current.model,
    }));
    setPrompt("");
    setStatus("");
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
      body: `Delete "${chat.title}"? This cannot be undone.`,
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

  async function readStream(response, assistantId) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

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
        setMessages((current) =>
          current.map((message) => {
            if (message.id !== assistantId) return message;
            if (event.type === "reasoning") {
              return { ...message, reasoning: `${message.reasoning || ""}${event.value}` };
            }
            if (event.type === "usage") {
              return { ...message, ...(event.value || {}) };
            }
            return { ...message, content: `${message.content || ""}${event.value}` };
          }),
        );
        scrollToBottom();
      }
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
        let detail = response.statusText;
        try {
          detail = (await response.json()).detail || detail;
        } catch {
          detail = await response.text();
        }
        throw new Error(detail);
      }

      await readStream(response, assistantId);
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
        models={models}
        settings={settings}
        setSettings={setSettings}
        modelLocked={modelLocked}
        onPersist={persistSettings}
        onModelSelected={(name) => showToast(name)}
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
