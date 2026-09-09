import { cx, CONTROL_MOTION, FADE_MOTION } from "../uiShared.js";
import { useState, useRef, useEffect, memo } from "react";
import { formatInteger, formatCost, formatThoughtDuration } from "../textFormatting.js";
import { ChevronDown, Copy, Pencil, Trash2, RefreshCw } from "lucide-react";
import { StatusLabel } from "../components/StatusLabel.jsx";
import ThinkingContent from "../ThinkingContent.jsx";
import { uncitedSources } from "../websearch/citations.js";
import { useStreamReveal } from "../streamingText.js";
import AttachmentChips from "../attachments/AttachmentChips.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import SourcePills from "../websearch/SourcePills.jsx";
import { EmptyChatState } from "./EmptyChatState.jsx";

function AssistantActionButton({ label, children, ...props }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
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
          "inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
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

const AssistantStatusLine = memo(function AssistantStatusLine({
  reasoning,
  reasoningStreaming,
  waiting,
  durationMs,
  searching = false,
}) {
  const [open, setOpen] = useState(false);

  const hasReasoning = Boolean(reasoning);
  if (!hasReasoning && !waiting && !searching) return null;

  const label = searching
    ? "Searching"
    : !hasReasoning
      ? "Working"
      : reasoningStreaming || !durationMs
        ? "Thinking"
        : `Thought for ${formatThoughtDuration(durationMs)}`;

  const shimmering = searching || reasoningStreaming || (!hasReasoning && waiting);

  return (
    <div className="mb-4 max-w-3xl">
      <button
        type="button"
        onClick={hasReasoning ? () => setOpen((value) => !value) : undefined}
        aria-expanded={hasReasoning ? open : undefined}
        disabled={!hasReasoning}
        className={cx(
          "inline-flex min-h-7 items-center rounded-md py-0 pr-2 text-xs font-medium text-neutral-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
          CONTROL_MOTION,
          hasReasoning ? "hover:text-neutral-300" : "cursor-default",
        )}
      >
        <span
          aria-hidden={!hasReasoning}
          className={cx(
            "-ml-1 mr-1 inline-flex shrink-0 items-center justify-center overflow-hidden",
            "transition-[width,opacity] duration-200 ease-out",
            hasReasoning ? "w-[15px] opacity-100" : "w-0 opacity-0",
          )}
        >
          <ChevronDown
            size={15}
            className={cx("transition-transform duration-150 ease-out", !open && "-rotate-90")}
          />
        </span>
        <StatusLabel label={label} shimmering={shimmering} />
      </button>
      {hasReasoning && open && (
        <div className="mt-3 ml-[3px] border-l border-white/10 pl-[11px] text-pretty text-sm leading-7 text-neutral-500">
          <ThinkingContent>{reasoning}</ThinkingContent>
        </div>
      )}
    </div>
  );
});

const MessageItem = memo(function MessageItem({
  message,
  streaming,
  smoothStreaming,
  reasoningStreaming,
  reasoningDurationMs,
  searching,
  onCopy,
  onRegenerate,
  onEditUserMessage,
  onDeleteUserMessage,
}) {
  const isUser = message.role === "user";
  const messageAttachments = message.attachments || [];
  const messageSources = uncitedSources(message.content, message.sources);
  const articleRef = useRef(null);
  const bodyRef = useRef(null);
  const settledRef = useRef(0);
  const paceWords = Boolean(streaming && smoothStreaming);
  const { text: visibleContent, revealing } = useStreamReveal(
    bodyRef,
    paceWords,
    message.content || "",
    settledRef,
  );
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
          {!editing && messageAttachments.length > 0 && (
            <AttachmentChips attachments={messageAttachments} compact />
          )}
          <div
            className={cx(
              editing
                ? "prompt-edit-surface w-full rounded-[28px] px-5 pb-5 pt-4"
                : "chat-user-prompt whitespace-pre-wrap rounded-[22px] bg-neutral-200 px-4 py-3 text-pretty text-sm leading-6 text-neutral-950",
              !editing && !(message.content || "").trim() && "hidden",
            )}
          >
            {editing ? (
              <>
                <textarea
                  value={draft}
                  rows={Math.min(8, Math.max(3, draft.split("\n").length))}
                  onChange={(event) => setDraft(event.target.value)}
                  data-1p-ignore="true"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.metaKey) {
                      event.preventDefault();
                      saveEdit();
                    }
                    if (event.key === "Escape") {
                      cancelEditing();
                    }
                  }}
                  className="block max-h-[260px] min-h-[108px] w-full resize-none bg-transparent text-base leading-7 text-neutral-50 outline-none placeholder:text-neutral-500 sm:text-[17px]"
                />
                <div className="mt-5 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={cancelEditing}
                    className={cx(
                      "inline-flex min-h-11 items-center rounded-full px-5 text-sm font-medium text-neutral-100 shadow-[0_0_0_1px_rgba(255,255,255,0.13)] hover:bg-white/[0.055] hover:shadow-[0_0_0_1px_rgba(255,255,255,0.2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
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
                      "inline-flex min-h-11 items-center rounded-full bg-white px-6 text-sm font-semibold text-neutral-950 hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:bg-white/35 disabled:text-neutral-700 disabled:active:scale-100",
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
                label="Copy prompt"
                onClick={() => onCopy(message)}
              >
                <Copy size={15} />
              </AssistantActionButton>
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
      <AssistantStatusLine
        reasoning={message.reasoning}
        reasoningStreaming={reasoningStreaming}
        waiting={!message.content}
        durationMs={reasoningDurationMs}
        searching={searching}
      />
      <div ref={bodyRef} className="max-w-3xl text-[15px] leading-7 text-neutral-100">
        {message.content ? (
          <MarkdownContent streaming={revealing} settledRef={settledRef}>
            {visibleContent}
          </MarkdownContent>
        ) : null}
      </div>
      {message.content && !streaming && !revealing && (
        <SourcePills sources={messageSources} className="mt-4 max-w-3xl" />
      )}
      {message.content && !streaming && !revealing && (
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

export function MessageList({
  messages,
  activeChatId,
  streamingMessageId,
  smoothStreaming,
  reasoningStreamingMessageId,
  reasoningDurations,
  searchingMessageId,
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
              smoothStreaming={smoothStreaming}
              reasoningStreaming={message.id === reasoningStreamingMessageId}
              reasoningDurationMs={reasoningDurations[message.id]}
              searching={message.id === searchingMessageId}
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
