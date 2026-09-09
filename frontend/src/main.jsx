import { cx, CONTROL_MOTION, FADE_MOTION } from "./uiShared.js";
import { useState, useRef, useEffect, useMemo, useCallback, memo } from "react";
import {
  formatInteger,
  formatCost,
  truncatePromptText,
  formatThoughtDuration,
  exportFileName,
  shortTitle,
  storyExportFileName,
} from "./textFormatting.js";
import { OverflowActions } from "./components/OverflowActions.jsx";
import {
  Pencil,
  X,
  Trash2,
  Eye,
  EyeOff,
  PanelLeftOpen,
  ChevronDown,
  Copy,
  RefreshCw,
  Menu,
} from "lucide-react";
import { MaskIcon, IconButton } from "./components/IconButton.jsx";
import { createPortal } from "react-dom";
import { MarkdownContent } from "./chat/MarkdownContent.jsx";
import { api, responseErrorDetail } from "./api.js";
import {
  promptModelName,
  getModelContextLimit,
  toFiniteNumber,
  getContextWindowInfo,
  isFreeModel,
} from "./modelFormatting.js";
import { APP_VERSION } from "./appInfo.js";
import { SlidingTabs } from "./components/SlidingTabs.jsx";
import { CHAT_MODES, newSettings, DEFAULT_MODEL } from "./settings/settingsDefaults.js";
import { NamePromptModal } from "./components/NamePromptModal.jsx";
import { StatusLabel } from "./components/StatusLabel.jsx";
import ThinkingContent from "./ThinkingContent.jsx";
import { uncitedSources } from "./websearch/citations.js";
import { useStreamReveal } from "./streamingText.js";
import AttachmentChips from "./attachments/AttachmentChips.jsx";
import SourcePills from "./websearch/SourcePills.jsx";
import {
  readLocalAppSettings,
  pickOpeningMessage,
  PENDING_CHAPTER_DRAFTS_STORAGE_KEY,
  readLocalChatFolders,
  clearLocalChatFolders,
  writeLocalAppSettings,
} from "./localStorage.js";
import { parseRoute, storyRoute, routePath, chatRoute } from "./routing.js";
import { useTour } from "./tour/useTour.js";
import { WRITE_TOUR_STEPS } from "./tour/tourSteps.js";
import { useNotifications } from "./notifications/useNotifications.js";
import { useAttachments } from "./attachments/useAttachments.js";
import {
  supportsImageInput,
  requiresThinking,
  effectiveThinkingEnabled,
  reasoningEffortLabel,
} from "./modelReasoning.js";
import { createNavigationCoordinator } from "./writing/navigationCoordinator.js";
import { createSaveCoordinator } from "./writing/saveCoordinator.js";
import { storyApi } from "./writing/storyApi.js";
import { useRafScroller } from "./streamScroll.js";
import {
  chapterRunTargetsOpenChapter,
  loadSettledGeneration,
  chapterGenerationEventMatchesRun,
  parseStreamingEditPreview,
  nextEditPreview,
  chapterUpdateMatchesRun,
  chapterFromUpdateEvent,
  chapterRepairContext,
  chapterGenerationErrorMessage,
  chapterGenerationErrorIsRepairable,
  chapterAppliedEditSummary,
} from "./writing/chapterGenerationEvents.js";
import { updateLorebookStream } from "./lorebook/lorebookUpdateApi.js";
import { repairLorebook as repairLorebookStream } from "./lorebook/repairLorebookApi.js";
import { generateLorebookEntry as generateLorebookEntryStream } from "./lorebook/generateEntryApi.js";
import { useFileDrop } from "./attachments/useFileDrop.js";
import HelpTourButton from "./HelpTourButton.jsx";
import StoryBrainstorm from "./brainstorm/StoryBrainstorm.jsx";
import { ContextWindowMeter } from "./components/ContextWindowMeter.jsx";
import { StoryWorkspace } from "./writing/StoryWorkspace.jsx";
import { LOREBOOK_PHASE_LABELS } from "./writing/WriteOperationStatus.jsx";
import { WriteLanding } from "./writing/WriteLanding.jsx";
import { Composer } from "./composer/Composer.jsx";
import { SettingsDrawer } from "./settings/SettingsDrawer.jsx";
import { ConfirmModal } from "./components/ConfirmModal.jsx";
import { NewStoryModal } from "./writing/NewStoryModal.jsx";
import NotificationStack from "./notifications/NotificationStack.jsx";
import TourOverlay from "./tour/TourOverlay.jsx";
import { TosLoadingScreen, TosUnavailableScreen, TosGateModal } from "./TosGate.jsx";
import { createRoot } from "react-dom/client";
import "./styles.css";

const FEEDBACK_FORM_URL = "https://forms.gle/gTth2TcXLYAArvGm6";

const GITHUB_RELEASES_LATEST_URL = "https://api.github.com/repos/echo1097/routerchat/releases/latest";

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

function ChatHistoryActions({
  chat,
  isFirst,
  forceVisible,
  folders,
  renameDisabled,
  onRename,
  onDelete,
  onExport,
  onTogglePin,
  onMoveToFolder,
}) {
  const [moveOpen, setMoveOpen] = useState(false);
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
            disabled={renameDisabled}
            title={renameDisabled ? "Waiting for the chat name" : undefined}
            onClick={() => {
              closeMenu();
              onRename(chat);
            }}
            className={cx(
              "chat-history-menu-item focus:outline-none",
              renameDisabled
                ? "cursor-not-allowed text-neutral-600"
                : "text-neutral-200 hover:bg-white/[0.07] focus:bg-white/[0.07]",
            )}
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
            className="chat-history-menu-item text-neutral-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            <i className="fi fi-rr-thumbtack text-[14px] leading-none" aria-hidden="true" />
            {chat.pinned ? "Unpin chat" : "Pin chat"}
          </button>
          <button
            type="button"
            role="menuitem"
            aria-expanded={moveOpen}
            onClick={() => setMoveOpen((current) => !current)}
            className="chat-history-menu-item text-neutral-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            <MaskIcon src="/icons/folder.png" size={14} />
            Move to folder
          </button>
          {moveOpen && (
            <div className="border-l border-white/10 pl-2">
              {folders.length === 0 && (
                <div className="px-2 py-1.5 text-[12px] leading-4 text-neutral-500">
                  No folders yet
                </div>
              )}
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoveOpen(false);
                    closeMenu();
                    onMoveToFolder(chat, folder.id);
                  }}
                  className={cx(
                    "chat-history-menu-item hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none",
                    chat.folder_id === folder.id ? "text-white" : "text-neutral-300",
                  )}
                >
                  <MaskIcon src="/icons/folder.png" size={13} />
                  <span className="truncate">{folder.name}</span>
                </button>
              ))}
              {chat.folder_id && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoveOpen(false);
                    closeMenu();
                    onMoveToFolder(chat, null);
                  }}
                  className="chat-history-menu-item text-neutral-300 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
                >
                  <X size={13} />
                  Remove from folder
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onExport(chat);
            }}
            className="chat-history-menu-item text-neutral-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
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

function FolderActions({ folder, onRename, onDelete, onNewChat }) {
  return (
    <OverflowActions
      id={`folder-${folder.id}`}
      title={folder.name}
      label="Folder actions"
      menuWidth={196}
    >
      {(closeMenu) => (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onNewChat(folder.id);
            }}
            className="chat-history-menu-item text-neutral-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            <MaskIcon src="/icons/new-message.png" size={14} />
            New chat here
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onRename(folder);
            }}
            className="chat-history-menu-item text-neutral-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            <Pencil size={14} />
            Edit name
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onDelete(folder);
            }}
            className="chat-history-menu-item text-red-300 hover:bg-red-500/10 focus:bg-red-500/10 focus:outline-none"
          >
            <Trash2 size={14} />
            Delete folder
          </button>
        </>
      )}
    </OverflowActions>
  );
}

function StoryHistoryActions({ story, onRename, onExport, onDelete, exportDisabled = false }) {
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
            className="chat-history-menu-item text-neutral-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
          >
            <Pencil size={14} />
            Edit name
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={exportDisabled}
            title={exportDisabled ? "Wait for writing to finish" : undefined}
            onClick={() => {
              if (exportDisabled) return;
              closeMenu();
              onExport(story);
            }}
            className={cx(
              "chat-history-menu-item focus:outline-none",
              exportDisabled
                ? "cursor-not-allowed text-neutral-600"
                : "text-neutral-200 hover:bg-white/[0.07] focus:bg-white/[0.07]",
            )}
          >
            <i className="fi fi-rr-file-export text-[14px] leading-none" aria-hidden="true" />
            Export
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
            className="chat-history-menu-item text-neutral-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
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
            className="chat-history-menu-item text-neutral-200 hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
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

function SidebarSearchModal({
  open,
  items,
  onSelect,
  onClose,
  label = "Search chats",
  emptyText = "Your conversations will appear here.",
  noMatchText = "No chats match that search.",
  fallbackTitle = "Untitled chat",
}) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
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

  const recentItems = useMemo(() => {
    const sorted = [...items].sort((first, second) => {
      const firstTime = Date.parse(first.updated_at || first.created_at || "") || 0;
      const secondTime = Date.parse(second.updated_at || second.created_at || "") || 0;
      return secondTime - firstTime;
    });

    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return sorted;

    return sorted.filter((item) => (item.title || "").toLowerCase().includes(trimmed));
  }, [items, query]);

  if (!rendered) return null;

  const isOpen = phase === "open";

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close search"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cx(
          "t-modal relative z-10 flex max-h-[min(620px,calc(100dvh-3rem))] w-full max-w-[560px] flex-col overflow-hidden rounded-[26px] bg-[#191919] text-neutral-100 [box-shadow:var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <header className="flex shrink-0 items-center gap-4 px-6 pb-2 pt-5">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search..."
            data-1p-ignore="true"
            className="min-w-0 flex-1 bg-transparent text-[19px] font-normal leading-7 text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
          />
          <button
            type="button"
            aria-label="Close search"
            title="Close search"
            onClick={onClose}
            className={cx(
              "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
              CONTROL_MOTION,
            )}
          >
            <X size={20} />
          </button>
        </header>

        <div className="chat-rail-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2">
          {recentItems.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[15px] leading-6 text-neutral-500">
              {query.trim() ? "Results" : "Last opened"}
            </div>
          )}

          {recentItems.length === 0 ? (
            <div className="px-3 py-6 text-sm leading-6 text-neutral-500">
              {query.trim() ? noMatchText : emptyText}
            </div>
          ) : (
            <div className="space-y-0.5">
              {recentItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className={cx(
                    "flex w-full items-center rounded-xl px-3 py-2.5 text-left text-[15px] leading-6 text-neutral-100 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                    CONTROL_MOTION,
                  )}
                >
                  <span className="truncate">{item.title || fallbackTitle}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ChangelogModal({ open, onClose }) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [status, setStatus] = useState("idle");
  const [release, setRelease] = useState(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      requestAnimationFrame(() => panelRef.current?.focus());
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

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    setStatus("loading");

    fetch(GITHUB_RELEASES_LATEST_URL, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        setRelease(data);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!rendered) return null;

  const isOpen = phase === "open";
  const releaseBody = release?.body;

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close changelog"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Changelog"
        tabIndex={-1}
        className={cx(
          "t-modal relative z-10 flex max-h-[min(640px,calc(100dvh-2rem))] w-full max-w-[560px] flex-col overflow-hidden rounded-[26px] bg-[#191919] text-neutral-100 outline-none [box-shadow:var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <button
          type="button"
          onClick={onClose}
          className={cx(
            "absolute right-3 top-3 z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full text-neutral-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 sm:right-4 sm:top-4",
            CONTROL_MOTION,
          )}
          aria-label="Close changelog"
        >
          <X size={17} />
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-5 sm:px-6 sm:pt-6">
          {status === "loading" && (
            <p className="text-sm leading-5 text-neutral-500">Loading latest release…</p>
          )}
          {status === "error" && (
            <p className="text-sm leading-5 text-neutral-500">
              Couldn't load the changelog right now. Try again later.
            </p>
          )}
          {status === "ready" && (
            <div className="text-[13px] leading-6 text-neutral-300">
              <MarkdownContent>
                {releaseBody || "No description provided for this release."}
              </MarkdownContent>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

let changelogAutoCheckStarted = false;

function FeedbackLink() {
  const [changelogOpen, setChangelogOpen] = useState(false);

  useEffect(() => {
    if (changelogAutoCheckStarted) return;
    changelogAutoCheckStarted = true;

    api("/api/changelog/status")
      .then((status) => {
        if (!status?.should_show) return;
        setChangelogOpen(true);
        return api("/api/changelog/seen", { method: "POST" });
      })
      .catch(() => {});
  }, []);

  return (
    <>
      <div className="flex w-full items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => setChangelogOpen(true)}
          className={cx(
            "flex h-9 flex-1 items-center justify-center rounded-xl px-2 text-[13px] font-medium text-neutral-500 hover:bg-white/[0.045] hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
            CONTROL_MOTION,
          )}
        >
          Changelog
        </button>
        <a
          href={FEEDBACK_FORM_URL}
          target="_blank"
          rel="noreferrer"
          className={cx(
            "flex h-9 flex-1 items-center justify-center rounded-xl px-2 text-[13px] font-medium text-neutral-500 hover:bg-white/[0.045] hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
            CONTROL_MOTION,
          )}
        >
          Feedback
        </a>
      </div>
      <ChangelogModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />
    </>
  );
}

function SidebarGroup({ label, open, onToggle, children, dropProps = {}, dropActive = false }) {
  const panelId = `${label.toLowerCase()}-chat-history`;

  return (
    <section
      className={cx(
        "t-acc chat-history-group rounded-2xl border border-transparent px-1 transition-[background-color,border-color,box-shadow] duration-150 ease-out",
        dropActive && "border-white/20 bg-white/[0.07]",
      )}
      data-open={String(open)}
      {...dropProps}
    >
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
          {children}
        </div>
      </div>
    </section>
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
  namingChatId,
  folders,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveChatToFolder,
  onNewChatInFolder,
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
  const [railScrolled, setRailScrolled] = useState(false);
  const [railHasMoreBelow, setRailHasMoreBelow] = useState(false);
  const [renamingChatId, setRenamingChatId] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [foldersOpen, setFoldersOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState(null);
  const [folderRenameDraft, setFolderRenameDraft] = useState("");
  const [expandedFolderIds, setExpandedFolderIds] = useState([]);
  const [dragChatId, setDragChatId] = useState(null);
  const [dropFolderId, setDropFolderId] = useState(null);
  const [recentsDropActive, setRecentsDropActive] = useState(false);
  const railScrollTimeoutRef = useRef(null);
  const railRef = useRef(null);
  const skipRenameCommitRef = useRef(false);
  const skipFolderRenameCommitRef = useRef(false);

  useEffect(
    () => () => {
      if (railScrollTimeoutRef.current) {
        window.clearTimeout(railScrollTimeoutRef.current);
      }
    },
    [],
  );

  function updateRailEdges(element) {
    const bottomOffset = element.scrollHeight - element.clientHeight - element.scrollTop;
    setRailScrolled(element.scrollTop > 2);
    setRailHasMoreBelow(bottomOffset > 2);
  }

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const frameId = requestAnimationFrame(() => updateRailEdges(rail));
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => updateRailEdges(rail));
    resizeObserver?.observe(rail);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
    };
  }, [chats.length, folders.length, pinnedOpen, recentsOpen, foldersOpen, expandedFolderIds]);

  function handleRailScroll(event) {
    updateRailEdges(event.currentTarget);
    setRailScrolling(true);
    window.clearTimeout(railScrollTimeoutRef.current);
    railScrollTimeoutRef.current = window.setTimeout(
      () => setRailScrolling(false),
      650,
    );
  }

  function startRename(chat) {
    if (chat.id === namingChatId) return;
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

  async function createFolder(name) {
    const folder = await onCreateFolder(name);
    setFoldersOpen(true);
    if (folder?.id) setExpandedFolderIds((current) => [...current, folder.id]);
  }

  function toggleFolderExpanded(folderId) {
    setExpandedFolderIds((current) => (
      current.includes(folderId)
        ? current.filter((id) => id !== folderId)
        : [...current, folderId]
    ));
  }

  function startFolderRename(folder) {
    skipFolderRenameCommitRef.current = false;
    setRenamingFolderId(folder.id);
    setFolderRenameDraft(folder.name || "");
  }

  function cancelFolderRename() {
    skipFolderRenameCommitRef.current = true;
    setRenamingFolderId(null);
    setFolderRenameDraft("");
  }

  async function commitFolderRename(folder) {
    if (skipFolderRenameCommitRef.current) {
      skipFolderRenameCommitRef.current = false;
      return;
    }
    const nextName = folderRenameDraft.trim();
    setRenamingFolderId(null);
    setFolderRenameDraft("");
    if (nextName && nextName !== folder.name) {
      await onRenameFolder(folder.id, nextName);
    }
  }

  function handleChatDrop(folderId) {
    const chat = chats.find((item) => item.id === dragChatId);
    setDragChatId(null);
    setDropFolderId(null);
    setRecentsDropActive(false);
    if (!chat) return;
    if (folderId) setExpandedFolderIds((current) => (
      current.includes(folderId) ? current : [...current, folderId]
    ));
    void onMoveChatToFolder(chat, folderId);
  }

  const pinnedChats = chats.filter((chat) => chat.pinned);
  const recentChats = chats.filter((chat) => !chat.pinned && !chat.folder_id);
  const draggedFolderChat = chats.find((chat) => chat.id === dragChatId && chat.folder_id);

  function renderChatRows(groupChats, startIndex = 0) {
    return groupChats.map((chat, chatIndex) => {
      const renaming = renamingChatId === chat.id;
      const index = startIndex + chatIndex;

      return (
        <div
          key={chat.id}
          draggable={!renaming}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", chat.id);
            setDragChatId(chat.id);
          }}
          onDragEnd={() => {
            setDragChatId(null);
            setDropFolderId(null);
            setRecentsDropActive(false);
          }}
          className={cx(
            "group relative grid select-none grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-2xl border border-transparent px-2 py-1 transition-[background-color,border-color,box-shadow] duration-150 ease-out",
            chat.id === activeChatId
              ? "bg-white/[0.08] shadow-[var(--shadow-border)]"
              : "hover:bg-white/[0.045] hover:shadow-[var(--shadow-border)]",
            dragChatId === chat.id && "opacity-45",
          )}
        >
          {renaming ? (
            <div className="min-h-8 min-w-0 rounded-xl px-1 py-0.5">
              <input
                autoFocus
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                data-1p-ignore="true"
                onBlur={() => commitRename(chat)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                className="block h-6 w-full min-w-0 rounded-md bg-white/[0.06] px-1.5 text-sm font-medium text-neutral-100 outline-none shadow-[var(--shadow-border)]"
              />
              <div className="truncate text-[11px] leading-3 text-neutral-500">
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
              <div className="truncate text-balance text-sm font-medium leading-4 text-neutral-100">
                {chat.title}
              </div>
              <div className="truncate text-[11px] leading-3 text-neutral-500">
                {promptModelName(models, chat.model)}
              </div>
            </button>
          )}
          <ChatHistoryActions
            chat={chat}
            isFirst={index === 0}
            forceVisible={index === 0 && highlightFirstChatActions}
            folders={folders}
            renameDisabled={chat.id === namingChatId}
            onRename={startRename}
            onDelete={onDeleteChat}
            onExport={onExportChat}
            onTogglePin={onTogglePinChat}
            onMoveToFolder={onMoveChatToFolder}
          />
        </div>
      );
    });
  }

  function renderFolderRows() {
    return folders.map((folder) => {
      const renaming = renamingFolderId === folder.id;
      const expanded = expandedFolderIds.includes(folder.id);
      const folderChats = chats.filter((chat) => chat.folder_id === folder.id);

      return (
        <div key={folder.id}>
        <div
          onDragOver={(event) => {
            if (!dragChatId) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropFolderId(folder.id);
          }}
          onDragLeave={() => setDropFolderId((current) => (current === folder.id ? null : current))}
          onDrop={(event) => {
            event.preventDefault();
            handleChatDrop(folder.id);
          }}
          className={cx(
            "group relative grid select-none grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-2xl border border-transparent px-2 py-1 transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:bg-white/[0.045] hover:shadow-[var(--shadow-border)]",
            dropFolderId === folder.id && "border-white/20 bg-white/[0.07]",
          )}
        >
          {renaming ? (
            <div className="flex min-h-8 min-w-0 items-center gap-2 rounded-xl px-1 py-0.5">
              <MaskIcon src="/icons/folder.png" size={16} className="text-neutral-300" />
              <input
                autoFocus
                value={folderRenameDraft}
                onChange={(event) => setFolderRenameDraft(event.target.value)}
                data-1p-ignore="true"
                onBlur={() => commitFolderRename(folder)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelFolderRename();
                  }
                }}
                className="block h-6 w-full min-w-0 rounded-md bg-white/[0.06] px-1.5 text-sm font-medium text-neutral-100 outline-none shadow-[var(--shadow-border)]"
              />
            </div>
          ) : (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => toggleFolderExpanded(folder.id)}
              className={cx(
                "flex min-h-8 min-w-0 items-center gap-2 rounded-xl px-1 py-0.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
                CONTROL_MOTION,
              )}
            >
              <MaskIcon src="/icons/folder.png" size={16} className="text-neutral-300" />
              <span className="truncate text-sm font-medium leading-4 text-neutral-100">
                {folder.name}
              </span>
              {folderChats.length > 0 && (
                <span className="shrink-0 text-[11px] leading-3 text-neutral-500">
                  {folderChats.length}
                </span>
              )}
            </button>
          )}
          <FolderActions
            folder={folder}
            onRename={startFolderRename}
            onDelete={onDeleteFolder}
            onNewChat={onNewChatInFolder}
          />
        </div>

        {expanded && (
          <div className="mt-1 space-y-1 border-l border-white/10 pl-2">
            {folderChats.length > 0 ? (
              renderChatRows(folderChats, 1)
            ) : (
              <div className="px-2 py-2 text-[12px] leading-4 text-neutral-500">
                Drag a chat here, or use New chat in this folder.
              </div>
            )}
          </div>
        )}
        </div>
      );
    });
  }

  function renderHistoryGroup(label, groupChats, open, onToggle, startIndex = 0) {
    return renderGroupShell(label, open, onToggle, renderChatRows(groupChats, startIndex));
  }

  function renderGroupShell(label, open, onToggle, children, dropProps = {}, dropActive = false) {
    return (
      <SidebarGroup
        label={label}
        open={open}
        onToggle={onToggle}
        dropProps={dropProps}
        dropActive={dropActive}
      >
        {children}
      </SidebarGroup>
    );
  }

  const folderGroup = folders.length > 0 && renderGroupShell(
    "Folders",
    foldersOpen,
    () => setFoldersOpen((current) => !current),
    renderFolderRows(),
  );

  const historyItems =
    chats.length === 0 ? (
      <div className="space-y-4">
        {folderGroup}
        <div className="px-3 py-8 text-pretty text-sm leading-6 text-neutral-500">
          {chatMode === "write"
            ? "Your stories will appear here."
            : "Your conversations will appear here."}
        </div>
      </div>
    ) : (
      <div className="space-y-4">
        {pinnedChats.length > 0 && renderHistoryGroup(
          "Pinned",
          pinnedChats,
          pinnedOpen,
          () => setPinnedOpen((current) => !current),
        )}
        {folderGroup}
        {renderGroupShell(
          "Recents",
          recentsOpen,
          () => setRecentsOpen((current) => !current),
          renderChatRows(recentChats, pinnedChats.length),
          {
            onDragOver: (event) => {
              if (!draggedFolderChat) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setRecentsDropActive(true);
            },
            onDragLeave: () => setRecentsDropActive(false),
            onDrop: (event) => {
              event.preventDefault();
              setRecentsDropActive(false);
              handleChatDrop(null);
            },
          },
          recentsDropActive,
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
          "chat-sidebar t-resize fixed inset-y-0 left-0 z-40 flex w-[292px] flex-col overflow-hidden border-r border-line bg-[#080808] lg:static lg:z-auto lg:translate-x-0",
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
          <div className="mb-4 flex items-center justify-between gap-2 pl-2">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-[19px] font-bold tracking-[-0.015em] text-white">
                RouterChat
              </span>
              <span className="shrink-0 text-[19px] font-bold tracking-[-0.015em] text-neutral-500">
                {APP_VERSION}
              </span>
            </div>

            <div className="flex shrink-0 items-center">
              <button
                type="button"
                aria-label="Search chats"
                title="Search chats"
                onClick={() => setSearchOpen(true)}
                className={cx(
                  "hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 lg:inline-flex",
                  CONTROL_MOTION,
                )}
              >
                <MaskIcon src="/icons/search.png" size={19} />
              </button>
              <button
                type="button"
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                data-tour="collapse-sidebar-button"
                onClick={onCollapse}
                className={cx(
                  "hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 lg:inline-flex",
                  CONTROL_MOTION,
                )}
              >
                <MaskIcon src="/icons/sidebar.png" size={15.5} />
              </button>
              <button
                type="button"
                aria-label="Close chats"
                title="Close chats"
                onClick={onCloseMobile}
                className={cx(
                  "inline-flex h-10 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 lg:hidden",
                  CONTROL_MOTION,
                )}
              >
                <X size={19} />
              </button>
            </div>
          </div>

          <div className="mb-3.5 flex justify-center">
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

          <div>
            <button
              type="button"
              onClick={() => {
                onNewChat();
                onCloseMobile();
              }}
              className={cx(
                "flex h-9 w-full items-center gap-3 rounded-xl bg-transparent px-2 text-[15px] font-medium text-white hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                CONTROL_MOTION,
              )}
            >
              <MaskIcon src="/icons/new-message.png" size={20} className="text-neutral-200" />
              New chat
            </button>

            <button
              type="button"
              onClick={() => setNewFolderOpen(true)}
              className={cx(
                "flex h-9 w-full items-center gap-3 rounded-xl bg-transparent px-2 text-[15px] font-medium text-white hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                CONTROL_MOTION,
              )}
            >
              <MaskIcon src="/icons/folder.png" size={20} className="text-neutral-200" />
              New folder
            </button>
          </div>

          <div className="relative min-h-0 flex-1">
            <nav
              ref={railRef}
              onScroll={handleRailScroll}
              className={cx(
                "chat-rail-scrollbar h-full space-y-1 overflow-y-auto pr-1",
                railScrolling && "is-scrolling",
              )}
            >
              {historyItems}
            </nav>
            <div
              aria-hidden="true"
              className={cx(
                "sidebar-list-fade pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-[#080808]/95 to-transparent transition-opacity duration-150 ease-out",
                railScrolled ? "opacity-100" : "opacity-0",
              )}
            />
            <div
              aria-hidden="true"
              className={cx(
                "sidebar-list-fade pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-[#080808]/95 to-transparent transition-opacity duration-150 ease-out",
                railHasMoreBelow ? "opacity-100" : "opacity-0",
              )}
            />
          </div>

          <footer className="mt-1 -mb-2">
            <FeedbackLink />
          </footer>
        </div>
      </aside>

      <SidebarSearchModal
        open={searchOpen}
        items={chats}
        onSelect={(chatId) => {
          setSearchOpen(false);
          onLoadChat(chatId);
          onCloseMobile();
        }}
        onClose={() => setSearchOpen(false)}
      />

      <NamePromptModal
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        onCreate={createFolder}
        heading="Name your new folder"
        description="You can rename your folder from the sidebar at any time"
        placeholder="Folder name"
        inputLabel="Folder name"
        submitLabel="Create folder"
        dialogLabel="Close new folder dialog"
      />
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
          "sidebar-reveal-button absolute left-3 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-[#181818]/95 text-neutral-300 [box-shadow:var(--shadow-surface)] backdrop-blur-xl hover:border-white/15 hover:bg-white/[0.09] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
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
    const scrollerTop = scroller.getBoundingClientRect().top;

    const messageNodes = Array.from(scroller.querySelectorAll("[data-message-id]"));

    const baseItems = promptMessages.map((message, index) => {
      const node = messageNodes.find(
        (messageNode) => messageNode.dataset.messageId === String(message.id),
      );
      if (!node) return null;

      const nodeTop = node.getBoundingClientRect().top;
      const scrollTop = Math.min(
        Math.max(scroller.scrollTop + nodeTop - scrollerTop - 24, 0),
        maxScroll,
      );
      const previewText = truncatePromptText(message.content);

      return {
        id: message.id,
        index,
        scrollTop,
        previewText,
      };
    }).filter(Boolean);

    if (baseItems.length === 0) {
      setRailItems([]);
      setActivePromptId(null);
      return;
    }

    let activeIndex = 0;
    let nextActiveId = baseItems[0]?.id || null;
    for (const [itemIndex, item] of baseItems.entries()) {
      if (item.scrollTop <= activeLine) {
        nextActiveId = item.id;
        activeIndex = itemIndex;
      }
    }

    const maxVisibleCount = Math.max(Math.floor(railHeight / promptGap), 1);
    const visibleCount = Math.min(baseItems.length, maxVisibleCount);
    const visibleCenter = (visibleCount - 1) / 2;
    const maxStartIndex = Math.max(baseItems.length - visibleCount, 0);
    const startIndex = Math.min(
      Math.max(Math.round(activeIndex - visibleCenter), 0),
      maxStartIndex,
    );
    const visibleItems = baseItems.slice(startIndex, startIndex + visibleCount);

    const nextItems = visibleItems.map((item, visibleIndex) => ({
      ...item,
      top: railCenter + (visibleIndex - visibleCenter) * promptGap,
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
    if (scroller.firstElementChild) {
      observer.observe(scroller.firstElementChild);
    }

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

    const messageNode = Array.from(
      scroller.querySelectorAll('[data-message-role="user"]'),
    ).find((node) => node.dataset.messageId === String(item.id));
    if (!messageNode) return;

    const scrollerTop = scroller.getBoundingClientRect().top;
    const messageTop = messageNode.getBoundingClientRect().top;
    const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
    const scrollTop = Math.min(
      Math.max(scroller.scrollTop + messageTop - scrollerTop - 24, 0),
      maxScroll,
    );
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const nearbyPrompt = (
      Math.abs(scrollTop - scroller.scrollTop) <= scroller.clientHeight * 2
    );

    scroller.scrollTo({
      top: scrollTop,
      behavior: !reducedMotion && nearbyPrompt ? "smooth" : "auto",
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

function EmptyChatState() {
  return (
    <div className="min-h-[100dvh]" aria-hidden="true" />
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
          ? "text-neutral-100"
          : "text-neutral-400 hover:text-neutral-100",
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
      className="pointer-events-none absolute left-4 top-16 z-20 flex h-10 w-10 items-center justify-center text-[18px] leading-none text-neutral-100 sm:left-8 sm:top-4 lg:left-10"
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
  onNewStory,
  onImportStory,
  onRenameStory,
  onExportStory,
  onRenameChapter,
  onDeleteStory,
  onDeleteChapter,
  onToggleChapterContext,
  previousChatMode,
  onChatModeChange,
  navigationLocked = false,
}) {
  const [railScrolling, setRailScrolling] = useState(false);
  const [railScrolled, setRailScrolled] = useState(false);
  const [railHasMoreBelow, setRailHasMoreBelow] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [importingStory, setImportingStory] = useState(false);
  const renameInputRef = useRef(null);
  const importInputRef = useRef(null);
  const skipRenameCommitRef = useRef(false);
  const railRef = useRef(null);
  const railScrollTimeoutRef = useRef(null);

  function updateRailEdges(element) {
    const bottomOffset = element.scrollHeight - element.clientHeight - element.scrollTop;
    setRailScrolled(element.scrollTop > 2);
    setRailHasMoreBelow(bottomOffset > 2);
  }

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const frameId = requestAnimationFrame(() => updateRailEdges(rail));
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => updateRailEdges(rail));
    resizeObserver?.observe(rail);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
    };
  }, [stories.length, chapters.length, activeStoryId, recentsOpen]);

  useEffect(
    () => () => {
      if (railScrollTimeoutRef.current) {
        window.clearTimeout(railScrollTimeoutRef.current);
      }
    },
    [],
  );

  function handleRailScroll(event) {
    updateRailEdges(event.currentTarget);
    setRailScrolling(true);
    window.clearTimeout(railScrollTimeoutRef.current);
    railScrollTimeoutRef.current = window.setTimeout(
      () => setRailScrolling(false),
      650,
    );
  }

  function startRename(entityType, item) {
    skipRenameCommitRef.current = false;
    setRenameTarget({ entityType, id: item.id });
    setRenameDraft(item.title || "");
  }

  function cancelRename() {
    skipRenameCommitRef.current = true;
    setRenameTarget(null);
    setRenameDraft("");
  }

  async function commitRename(entityType, item) {
    if (skipRenameCommitRef.current) {
      skipRenameCommitRef.current = false;
      return;
    }

    const nextTitle = renameDraft.trim();
    if (!nextTitle || nextTitle === item.title) {
      setRenameTarget(null);
      setRenameDraft("");
      return;
    }

    try {
      if (entityType === "story") {
        await onRenameStory(item, nextTitle);
      } else {
        await onRenameChapter(item, nextTitle);
      }
      setRenameTarget(null);
      setRenameDraft("");
    } catch {
      requestAnimationFrame(() => renameInputRef.current?.focus());
    }
  }

  async function importStoryFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImportingStory(true);
    try {
      const imported = await onImportStory(file);
      if (imported) onCloseMobile();
    } finally {
      setImportingStory(false);
    }
  }

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
          "chat-sidebar t-resize fixed inset-y-0 left-0 z-40 flex w-[292px] flex-col overflow-hidden border-r border-line bg-[#080808] lg:static lg:z-auto lg:translate-x-0",
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
          <div className="mb-4 flex items-center justify-between gap-2 pl-2">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-[19px] font-bold tracking-[-0.015em] text-white">
                RouterChat
              </span>
              <span className="shrink-0 text-[19px] font-bold tracking-[-0.015em] text-neutral-500">
                {APP_VERSION}
              </span>
            </div>

            <div className="flex shrink-0 items-center">
              <button
                type="button"
                aria-label="Search stories"
                title="Search stories"
                onClick={() => setSearchOpen(true)}
                className={cx(
                  "hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 lg:inline-flex",
                  CONTROL_MOTION,
                )}
              >
                <MaskIcon src="/icons/search.png" size={19} />
              </button>
              <button
                type="button"
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                onClick={onCollapse}
                className={cx(
                  "hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 lg:inline-flex",
                  CONTROL_MOTION,
                )}
              >
                <MaskIcon src="/icons/sidebar.png" size={15.5} />
              </button>
              <button
                type="button"
                aria-label="Close stories"
                title="Close stories"
                onClick={onCloseMobile}
                className={cx(
                  "inline-flex h-10 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 lg:hidden",
                  CONTROL_MOTION,
                )}
              >
                <X size={19} />
              </button>
            </div>
          </div>

          <div className="mb-3.5 flex justify-center">
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

          <div className="mb-4">
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
                "flex h-9 w-full items-center gap-3 rounded-xl bg-transparent px-2 text-[15px] font-medium text-white hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-55",
                CONTROL_MOTION,
              )}
            >
              <span
                aria-hidden="true"
                className="grid h-5 w-5 shrink-0 place-items-center text-[17px] leading-none text-neutral-200"
              >
                <i className="fi fi-rr-home" />
              </span>
              Home
            </button>

            <button
              type="button"
              onClick={() => {
                if (navigationLocked) return;
                onNewStory();
                onCloseMobile();
              }}
              disabled={navigationLocked}
              className={cx(
                "flex h-9 w-full items-center gap-3 rounded-xl bg-transparent px-2 text-[15px] font-medium text-white hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-55",
                CONTROL_MOTION,
              )}
            >
              <MaskIcon src="/icons/newbook.png" size={20} className="text-neutral-200" />
              New story
            </button>

            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              disabled={navigationLocked || importingStory}
              className={cx(
                "flex h-9 w-full items-center gap-3 rounded-xl bg-transparent px-2 text-[15px] font-medium text-white hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-55",
                CONTROL_MOTION,
              )}
            >
              <span className="grid h-5 w-5 shrink-0 place-items-center">
                <MaskIcon src="/icons/file-import.png" size={17} className="text-neutral-200" />
              </span>
              {importingStory ? "Importing story" : "Import story"}
            </button>
            <input
              ref={importInputRef}
              type="file"
              aria-label="Import story file"
              accept="application/json,.json"
              className="hidden"
              onChange={importStoryFile}
            />
          </div>

          <div className="relative min-h-0 flex-1">
            <nav
              ref={railRef}
              onScroll={handleRailScroll}
              className={cx(
                "chat-rail-scrollbar h-full space-y-3 overflow-y-auto pr-1",
                railScrolling && "is-scrolling",
              )}
            >
              {stories.length === 0 ? (
              <div className="px-3 py-8 text-pretty text-sm leading-6 text-neutral-500">
                Your stories will appear here.
              </div>
            ) : (
              <SidebarGroup
                label="Recents"
                open={recentsOpen}
                onToggle={() => setRecentsOpen((current) => !current)}
              >
                {stories.map((story) => {
                  const active = story.id === activeStoryId;
                  const renamingStory =
                    renameTarget?.entityType === "story" && renameTarget.id === story.id;
                  return (
                    <div key={story.id} className="space-y-1">
                      <div
                        data-tour={active ? "write-story-rail" : undefined}
                        className={cx(
                          "group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-2xl border border-transparent px-2 py-1",
                          active ? "bg-white/[0.08] shadow-[var(--shadow-border)]" : "hover:bg-white/[0.045]",
                        )}
                      >
                        {renamingStory ? (
                          <div className="min-h-8 min-w-0 rounded-xl px-1 py-0.5">
                            <input
                              ref={renameInputRef}
                              autoFocus
                              aria-label="Rename story"
                              data-1p-ignore="true"
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onBlur={() => commitRename("story", story)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") event.currentTarget.blur();
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelRename();
                                }
                              }}
                              className="block h-7 w-full min-w-0 rounded-md bg-white/[0.06] px-1.5 text-sm font-medium text-neutral-100 outline-none shadow-[var(--shadow-border)]"
                            />
                          </div>
                        ) : (
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
                            <div className="truncate text-sm font-medium leading-4 text-neutral-100">
                              {story.title}
                            </div>
                          </button>
                        )}
                        <StoryHistoryActions
                          story={story}
                          onRename={(item) => startRename("story", item)}
                          onExport={onExportStory}
                          onDelete={onDeleteStory}
                          exportDisabled={navigationLocked}
                        />
                      </div>

                      {active && (
                        <div className="ml-3 space-y-1 border-l border-white/10 pl-2">
                          <button
                            type="button"
                            data-tour="write-new-chapter-button"
                            onClick={onCreateChapter}
                            disabled={navigationLocked}
                            className="mb-1 flex h-8 w-full items-center justify-center rounded-xl text-xs font-medium text-neutral-400 hover:bg-white/[0.045] hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15"
                          >
                            New chapter
                          </button>
                          {chapters.length === 0 ? (
                            <div className="px-2 py-3 text-xs leading-5 text-neutral-600">
                              No chapters yet.
                            </div>
                          ) : (
                            chapters.map((chapter) => {
                              const renamingChapter =
                                renameTarget?.entityType === "chapter"
                                && renameTarget.id === chapter.id;
                              return (
                                <div
                                  key={chapter.id}
                                  className={cx(
                                    "group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-xl px-2 py-1",
                                    chapter.id === activeChapterId
                                      ? chapter.disabled
                                        ? "bg-white/[0.075] text-neutral-400"
                                        : "bg-white/[0.075] text-neutral-100"
                                      : chapter.disabled
                                        ? "text-neutral-600 hover:bg-white/[0.04] hover:text-neutral-300"
                                        : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-100",
                                  )}
                                >
                                  {renamingChapter ? (
                                    <input
                                      ref={renameInputRef}
                                      autoFocus
                                      aria-label="Rename chapter"
                                      data-1p-ignore="true"
                                      value={renameDraft}
                                      onChange={(event) => setRenameDraft(event.target.value)}
                                      onBlur={() => commitRename("chapter", chapter)}
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter") event.currentTarget.blur();
                                        if (event.key === "Escape") {
                                          event.preventDefault();
                                          cancelRename();
                                        }
                                      }}
                                      className="block h-6 w-full min-w-0 rounded-md bg-white/[0.06] px-1.5 text-xs font-medium text-neutral-100 outline-none shadow-[var(--shadow-border)]"
                                    />
                                  ) : (
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
                                      <span className="min-w-0 flex-1 truncate">
                                        {chapter.title}
                                      </span>
                                      {chapter.disabled && (
                                        <EyeOff
                                          size={13}
                                          className="shrink-0 text-neutral-500"
                                          aria-hidden="true"
                                        />
                                      )}
                                    </button>
                                  )}
                                  <ChapterHistoryActions
                                    chapter={chapter}
                                    onRename={(item) => startRename("chapter", item)}
                                    onDelete={onDeleteChapter}
                                    onToggleContext={onToggleChapterContext}
                                  />
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </SidebarGroup>
              )}
            </nav>
            <div
              aria-hidden="true"
              className={cx(
                "sidebar-list-fade pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-[#080808]/95 to-transparent transition-opacity duration-150 ease-out",
                railScrolled ? "opacity-100" : "opacity-0",
              )}
            />
            <div
              aria-hidden="true"
              className={cx(
                "sidebar-list-fade pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-[#080808]/95 to-transparent transition-opacity duration-150 ease-out",
                railHasMoreBelow ? "opacity-100" : "opacity-0",
              )}
            />
          </div>

          <footer className="mt-1 -mb-2">
            <FeedbackLink />
          </footer>
        </div>
      </aside>

      <SidebarSearchModal
        open={searchOpen}
        items={stories}
        label="Search stories"
        emptyText="Your stories will appear here."
        noMatchText="No stories match that search."
        fallbackTitle="Untitled story"
        onSelect={(storyId) => {
          setSearchOpen(false);
          if (navigationLocked) return;
          onSelectStory(storyId);
          onCloseMobile();
        }}
        onClose={() => setSearchOpen(false)}
      />
    </>
  );
}

function App() {
  const localAppSettings = readLocalAppSettings();
  const [chats, setChats] = useState([]);
  const [folders, setFolders] = useState([]);
  const [messages, setMessages] = useState([]);
  const [stories, setStories] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [lorebookEntries, setLorebookEntries] = useState([]);
  const [lorebookUpdating, setLorebookUpdating] = useState(false);
  const [brainstormNodes, setBrainstormNodes] = useState([]);
  const [brainstormEdges, setBrainstormEdges] = useState([]);
  const [brainstormViewport, setBrainstormViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [brainstormPrompt, setBrainstormPrompt] = useState("");
  const [latestBrainstormGeneration, setLatestBrainstormGeneration] = useState(null);
  const [activeStoryId, setActiveStoryId] = useState(null);
  const [activeChapterId, setActiveChapterId] = useState(null);
  const [storyWorkspaceView, setStoryWorkspaceView] = useState("chapter");
  const [chapterContent, setChapterContent] = useState("");
  const [chapterSaveState, setChapterSaveState] = useState("");
  const [storyGenerationStatus, setStoryGenerationStatus] = useState("");
  //true only while a new chapter is streaming prose into the canvas, edit runs never touch it
  const [canvasStreaming, setCanvasStreaming] = useState(false);
  const [writeReasoning, setWriteReasoning] = useState({ text: "", streaming: false, durationMs: null });
  //the lorebook thinks in its own pass, so it gets its own reasoning rather than sharing the chapter's
  const [lorebookReasoning, setLorebookReasoning] = useState({ text: "", streaming: false, durationMs: null });
  const [lorebookThinking, setLorebookThinking] = useState(false);
  //"working" until the model's first token lands, then "thinking" while it reasons, then "updating" while it streams the json
  const [lorebookPhase, setLorebookPhase] = useState("");
  const [writeEditPreview, setWriteEditPreview] = useState(null);
  const [latestStoryGeneration, setLatestStoryGeneration] = useState(null);
  const [writeGenerationMode, setWriteGenerationMode] = useState("edit");
  const [writeHistoryEntries, setWriteHistoryEntries] = useState([]);
  const [models, setModels] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [temporaryChat, setTemporaryChat] = useState(false);
  const [tempChatId, setTempChatId] = useState(null);
  const [settings, setSettings] = useState(newSettings);
  const [defaultModel, setDefaultModel] = useState(DEFAULT_MODEL);
  const [generateChatName, setGenerateChatName] = useState(
    Boolean(localAppSettings.generate_chat_name),
  );
  const [namingChatId, setNamingChatId] = useState(null);
  const [hideFreeModels, setHideFreeModels] = useState(Boolean(localAppSettings.hide_free_models));
  const [nitroMode, setNitroMode] = useState(Boolean(localAppSettings.nitro_mode));
  const [cheapestMode, setCheapestMode] = useState(Boolean(localAppSettings.cheapest_mode));
  const [privacyMode, setPrivacyMode] = useState(Boolean(localAppSettings.privacy_mode));
  const [zdrMode, setZdrMode] = useState(Boolean(localAppSettings.zdr_mode));
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

  //the rails are separate components, so the outgoing mode has to survive until the new one mounts and reads it
  useEffect(() => {
    if (!previousChatMode || previousChatMode === chatMode) return;
    setPreviousChatMode(null);
  }, [chatMode, previousChatMode]);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState(null);
  const [reasoningStreamingMessageId, setReasoningStreamingMessageId] = useState(null);
  const [searchingMessageId, setSearchingMessageId] = useState(null);
  const [reasoningDurations, setReasoningDurations] = useState({});
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [newStoryDialogOpen, setNewStoryDialogOpen] = useState(false);
  const [temporaryTourStory, setTemporaryTourStory] = useState(null);
  const tour = useTour();
  const writeTour = useTour(WRITE_TOUR_STEPS);
  const { notifications, setStatus, showToast } = useNotifications();
  const promptAttachments = useAttachments({
    allowImages: supportsImageInput(models, settings.model),
    onError: showToast,
  });
  const [tourForceThinking, setTourForceThinking] = useState(false);
  const [tourSampleChatActive, setTourSampleChatActive] = useState(false);
  const abortRef = useRef(null);
  const writeGenerationRunRef = useRef(null);
  //held until the run settles so the retry offer never lands mid stream
  const pendingRepairRef = useRef(null);
  const generateStoryChapterRef = useRef(null);
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
  const lorebookReasoningStartedAtRef = useRef(null);
  const streamRef = useRef(null);
  const previousRailStateRef = useRef(null);
  const brainstormViewportTimeoutRef = useRef(null);
  const brainstormPromptNodeIdRef = useRef(null);
  const chapterContentRef = useRef("");
  const chaptersRef = useRef([]);
  const activeStoryIdRef = useRef(null);
  const activeChapterIdRef = useRef(null);
  const chapterCanvasScrollPositionsRef = useRef(new Map());
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
        };
        setChapterSaveState(labels[snapshot.state] || "");
        if (snapshot.state === "failed" && snapshot.error) {
          setStatus(snapshot.error.message);
        }
      },
    });
  }

  const chapterSaveCoordinator = chapterSaveCoordinatorRef.current;

  function chapterCanvasScrollKey(storyId, chapterId) {
    return `${storyId}/${chapterId}`;
  }

  function chapterCanvasScrollPosition(storyId, chapterId) {
    if (!storyId || !chapterId) return 0;
    return chapterCanvasScrollPositionsRef.current.get(
      chapterCanvasScrollKey(storyId, chapterId),
    ) || 0;
  }

  function rememberChapterCanvasScroll(storyId, chapterId, scrollTop) {
    if (!storyId || !chapterId || !Number.isFinite(scrollTop)) return;
    chapterCanvasScrollPositionsRef.current.set(
      chapterCanvasScrollKey(storyId, chapterId),
      scrollTop,
    );
  }

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
      const draftBaseRevision = Number.isInteger(draft.baseRevision)
        ? draft.baseRevision
        : chapter.revision;
      //a stored draft the server has already moved past is not worth restoring, it would only fight whatever moved it
      const draftIsStale = Number(draftBaseRevision) < Number(chapter.revision);
      if (!chapterSaveCoordinator.getDraft(draft.storyId, draft.chapterId) && !draftIsStale) {
        if (chapter.content !== draft.content) {
          chapterSaveCoordinator.queueDraft(
            draft.storyId,
            draft.chapterId,
            String(draft.content || ""),
            draftBaseRevision,
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
      web_search_enabled: false,
      nitro_mode: nitroMode,
      lorebook_auto: Boolean(story.lorebook_auto),
      lorebook_model: story.lorebook_model || "",
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

  function generationRunTargetsOpenChapter(run) {
    return chapterRunTargetsOpenChapter(
      run,
      activeStoryIdRef.current,
      activeChapterIdRef.current,
    );
  }

  async function reconcileGenerationRun(run) {
    if (run.navigationIntent !== currentNavigationIntent()) return;
    const payload = await loadSettledGeneration(run, {
      getStatus: (currentRun) => storyApi.getGenerationStatus(currentRun),
      getStory: (storyId) => storyApi.getStory(storyId),
      isCurrent: () => generationRunOwnsVisibleWorkspace(run),
    });
    if (!payload) return;
    const nextChapters = payload.chapters || [];
    nextChapters.forEach((chapter) => chapterSaveCoordinator.rememberServerChapter(chapter));

    if (activeStoryIdRef.current !== run.storyId) return;
    const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
    setChapters(visibleChapters);
    setLorebookEntries(payload.lorebook || []);
    setLatestStoryGeneration(payload.latest_generation || null);

    if (!generationRunTargetsOpenChapter(run)) return;
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

  const loadFolders = useCallback(async () => {
    const payload = await api("/api/folders");
    let nextFolders = payload.folders || [];

    //folders used to live in localStorage before they had a table, so lift those over once and forget the key
    const legacyFolders = readLocalChatFolders();
    if (legacyFolders.length > 0) {
      try {
        if (nextFolders.length === 0) {
          for (const folder of legacyFolders) {
            await api("/api/folders", {
              method: "POST",
              body: JSON.stringify({ name: folder.name }),
            });
          }
          nextFolders = (await api("/api/folders")).folders || [];
        }
        clearLocalChatFolders();
      } catch {
        //a failed lift is not worth blocking the sidebar, the key stays put so the next load can retry
      }
    }

    setFolders(nextFolders);
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
          return requiresThinking(loaded, current.model)
            ? { ...current, thinking_enabled: true }
            : current;
        }
        const selectableModels = hideFreeModels
          ? loaded.filter((model) => !isFreeModel(model))
          : loaded;
        const savedDefaultModel = defaultModelRef.current;
        const fallbackModel = selectableModels.some((model) => model.id === savedDefaultModel)
          ? savedDefaultModel
          : selectableModels[0]?.id || loaded[0]?.id || DEFAULT_MODEL;
        return {
          ...current,
          model: fallbackModel,
          thinking_enabled: requiresThinking(loaded, fallbackModel)
            ? true
            : current.thinking_enabled,
        };
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
      const nextGenerateChatName =
        typeof payload.generate_chat_name === "boolean"
          ? payload.generate_chat_name
          : Boolean(readLocalAppSettings().generate_chat_name);
      const nextNitroMode =
        typeof payload.nitro_mode === "boolean"
          ? payload.nitro_mode
          : Boolean(readLocalAppSettings().nitro_mode);
      const nextSmoothStreaming =
        typeof payload.smooth_streaming === "boolean"
          ? payload.smooth_streaming
          : Boolean(readLocalAppSettings().smooth_streaming);
      const nextCheapestMode =
        typeof payload.cheapest_mode === "boolean"
          ? payload.cheapest_mode
          : Boolean(readLocalAppSettings().cheapest_mode);
      const nextPrivacyMode =
        typeof payload.privacy_mode === "boolean"
          ? payload.privacy_mode
          : Boolean(readLocalAppSettings().privacy_mode);
      const nextZdrMode =
        typeof payload.zdr_mode === "boolean"
          ? payload.zdr_mode
          : Boolean(readLocalAppSettings().zdr_mode);
      setDefaultModel(nextDefaultModel);
      defaultModelRef.current = nextDefaultModel;
      setGenerateChatName(nextGenerateChatName);
      setHideFreeModels(nextHideFreeModels);
      setNitroMode(nextNitroMode);
      setSmoothStreaming(nextSmoothStreaming);
      setCheapestMode(nextCheapestMode);
      setPrivacyMode(nextPrivacyMode);
      setZdrMode(nextZdrMode);
      writeLocalAppSettings({
        generate_chat_name: nextGenerateChatName,
        hide_free_models: nextHideFreeModels,
        nitro_mode: nextNitroMode,
        smooth_streaming: nextSmoothStreaming,
        cheapest_mode: nextCheapestMode,
        privacy_mode: nextPrivacyMode,
        zdr_mode: nextZdrMode,
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
    loadFolders();
    loadStories();
  }, [loadAppSettings, loadChats, loadFolders, loadKeyStatus, loadModels, loadStories]);

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
      thinking_enabled: effectiveThinkingEnabled(
        models, chat.model, Boolean(chat.thinking_enabled),
      ),
      reasoning_effort: chat.reasoning_effort || "medium",
      web_search_enabled: Boolean(chat.web_search_enabled),
      nitro_mode: nitroMode,
      lorebook_auto: false, //chats have no lorebook, this just keeps the object shape steady across modes
      lorebook_model: "",
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
      //a conflict now settles itself in the coordinator, the chapter is already back in sync so only a real failure earns a label
      if (error.code !== "chapter_revision_conflict") setChapterSaveState("Save failed");
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
    setCanvasStreaming(false);
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

  async function updateGenerateChatName(value) {
    setGenerateChatName(value);
    writeLocalAppSettings({ generate_chat_name: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ generate_chat_name: value }),
      });
      //an older backend drops unknown fields and still answers 200, so a missing key is a stale server
      if (typeof payload.generate_chat_name !== "boolean") {
        setStatus("Saved locally. Restart the server to use generated chat names.");
        return;
      }
      setGenerateChatName(payload.generate_chat_name);
      writeLocalAppSettings({ generate_chat_name: payload.generate_chat_name });
      showToast(value ? "Chat names will be generated" : "Chat name generation off");
    } catch (error) {
      setGenerateChatName(value);
      writeLocalAppSettings({ generate_chat_name: value });
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  async function updateNitroMode(value) {
    applyRoutingSettings(null, { nitro: value, cheapest: value ? false : cheapestMode });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ nitro_mode: value }),
      });
      applyRoutingSettings(payload, { nitro: value, cheapest: value ? false : cheapestMode });
      showToast(value ? "Turbo enabled" : "Turbo disabled");
    } catch (error) {
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  function applyRoutingSettings(payload, fallback) {
    const nextNitro =
      typeof payload?.nitro_mode === "boolean" ? payload.nitro_mode : fallback.nitro;
    const nextCheapest =
      typeof payload?.cheapest_mode === "boolean" ? payload.cheapest_mode : fallback.cheapest;
    setNitroMode(nextNitro);
    setCheapestMode(nextCheapest);
    setSettings((current) => ({ ...current, nitro_mode: nextNitro }));
    writeLocalAppSettings({ nitro_mode: nextNitro, cheapest_mode: nextCheapest });
  }

  async function updateCheapestMode(value) {
    //turbo and cheapest are opposite sort orders, so one always wins over the other
    applyRoutingSettings(null, { nitro: value ? false : nitroMode, cheapest: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ cheapest_mode: value }),
      });
      applyRoutingSettings(payload, { nitro: value ? false : nitroMode, cheapest: value });
      showToast(value ? "Cheapest first enabled" : "Cheapest first disabled");
    } catch (error) {
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  async function updatePrivacyMode(value) {
    setPrivacyMode(value);
    writeLocalAppSettings({ privacy_mode: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ privacy_mode: value }),
      });
      const nextValue =
        typeof payload.privacy_mode === "boolean" ? payload.privacy_mode : value;
      setPrivacyMode(nextValue);
      writeLocalAppSettings({ privacy_mode: nextValue });
      showToast(value ? "Privacy mode enabled" : "Privacy mode disabled");
    } catch (error) {
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  async function updateZdrMode(value) {
    setZdrMode(value);
    writeLocalAppSettings({ zdr_mode: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ zdr_mode: value }),
      });
      const nextValue = typeof payload.zdr_mode === "boolean" ? payload.zdr_mode : value;
      setZdrMode(nextValue);
      writeLocalAppSettings({ zdr_mode: nextValue });
      showToast(value ? "Zero data retention enabled" : "Zero data retention disabled");
    } catch (error) {
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
    showToast(`Exported ${shortTitle(chat?.title) || "chat"}`);
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
    showToast(
      `Imported ${result.imported_chats || 0} chats and ${result.imported_messages || 0} messages`,
    );
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

  async function createFolder(name) {
    try {
      const payload = await api("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      await loadFolders();
      showToast(`Folder "${payload.folder.name}" created`);
      return payload.folder;
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function renameFolder(folderId, name) {
    try {
      await api(`/api/folders/${folderId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      await loadFolders();
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  function deleteFolder(folder) {
    const folderChats = chats.filter((chat) => chat.folder_id === folder.id);
    setConfirmDialog({
      title: "Delete folder?",
      chatTitle: folder.name,
      body: folderChats.length
        ? `The ${folderChats.length} ${folderChats.length === 1 ? "chat" : "chats"} inside will move back to Recents.`
        : "This cannot be undone.",
      confirmLabel: "Delete folder",
      secondaryLabel: folderChats.length ? "Delete folder and chats" : null,
      onSecondary: async () => {
        await removeFolder(folder, true);
      },
      onConfirm: async () => {
        await removeFolder(folder, false);
      },
    });
  }

  async function removeFolder(folder, deleteChats) {
    try {
      await api(`/api/folders/${folder.id}?delete_chats=${deleteChats ? "true" : "false"}`, {
        method: "DELETE",
      });
      await loadFolders();
      await loadChats();
      if (deleteChats && chats.some((chat) => chat.folder_id === folder.id && chat.id === activeChatId)) {
        await resetChat();
      }
      showToast(deleteChats ? "Folder and chats deleted" : "Folder deleted");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function moveChatToFolder(chat, folderId) {
    const previousFolderId = chat.folder_id || null;
    const nextFolderId = folderId || null;
    if (previousFolderId === nextFolderId) return;

    setChats((current) => current.map((item) => (
      item.id === chat.id ? { ...item, folder_id: nextFolderId } : item
    )));

    try {
      await api(`/api/chats/${chat.id}`, {
        method: "PATCH",
        body: JSON.stringify({ folder_id: nextFolderId || "" }),
      });
      await loadChats();
      await loadFolders();
      const folder = folders.find((item) => item.id === nextFolderId);
      showToast(folder ? `Moved to ${folder.name}` : "Removed from folder");
    } catch (error) {
      setChats((current) => current.map((item) => (
        item.id === chat.id ? { ...item, folder_id: previousFolderId } : item
      )));
      setStatus(error.message);
    }
  }

  async function createChatInFolder(folderId) {
    try {
      const payload = await api("/api/chats", {
        method: "POST",
        body: JSON.stringify({
          ...settings,
          chat_system_prompt: settings.system_prompt,
          folder_id: folderId,
        }),
      });
      applyChat(payload.chat, []);
      await navigateToChat(payload.chat);
      await loadChats();
      await loadFolders();
      return payload.chat;
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

    function clearSearching() {
      setSearchingMessageId((current) => (current === assistantId ? null : current));
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
          if (event.type === "sources") {
            const foundSources = event.value || [];
            setMessageList((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? { ...message, sources: foundSources }
                  : message,
              ),
            );
            continue;
          }
          if (event.type === "reasoning") {
            clearSearching();
            startReasoningTimer();
            setReasoningStreamingMessageId(assistantId);
            queueSmoothText("reasoning", String(event.value || ""));
            continue;
          }
          clearSearching();
          clearReasoningStreaming();
          queueSmoothText("content", String(event.value || ""));
        }
      }
      if (buffered.trim()) {
        clearReasoningStreaming();
        queueSmoothText("content", buffered);
      }
    } finally {
      flushNow();
      clearSearching();
      clearReasoningStreaming();
    }
  }

  async function sendMessage(text = prompt.trim(), regenerateMessageId = null) {
    const sentAttachmentIds = regenerateMessageId ? [] : promptAttachments.attachmentIds();
    const sentAttachments = regenerateMessageId ? [] : promptAttachments.attachments;
    if (isStreaming || (!text && sentAttachmentIds.length === 0)) return;
    setIsStreaming(true);
    setStatus("");
    abortRef.current = new AbortController();
    let currentAssistantId = null;
    let conversationId = null;
    let currentTempMode = false;
    //the name comes from the opening prompt, so a regenerate of that same turn is not a new chat
    const shouldName = generateChatName && !regenerateMessageId && messages.length === 0;

    try {
      const tempMode = temporaryChat && (!activeChatId || activeChatId === tempChatId);
      currentTempMode = tempMode;
      conversationId = tempMode ? await ensureTemporaryChat() : await ensureChat();
      if (shouldName) {
        setNamingChatId(conversationId);
      }
      const shouldAddUser = !regenerateMessageId;
      const userMessage = {
        id: `local-user-${crypto.randomUUID()}`,
        chat_id: conversationId,
        role: "user",
        content: text,
        attachments: sentAttachments,
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
      setSearchingMessageId(settings.web_search_enabled ? assistantId : null);
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
      promptAttachments.releaseAttachments();

      const response = await fetch(`/api/chats/${conversationId}/messages/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          ...settings,
          chat_system_prompt: settings.system_prompt,
          message: text,
          regenerate_message_id: regenerateMessageId,
          attachment_ids: sentAttachmentIds,
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
      if (shouldName) {
        await nameChat(conversationId, tempMode);
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
      setSearchingMessageId(null);
      if (currentAssistantId) {
        delete reasoningStartedAtRef.current[currentAssistantId];
      }
      abortRef.current = null;
      //a stopped or failed run never reaches the naming call, so the lock has to lift here too
      setNamingChatId(null);
    }
  }

  //the route always answers with a title, so a rejection here is the network rather than the model
  async function nameChat(chatId, tempMode) {
    try {
      const payload = await api(`/api/chats/${chatId}/title`, { method: "POST" });
      if (!tempMode) {
        await loadChats();
      }
      if (chatId === activeChatId && payload.chat) {
        await navigateToChat(payload.chat, { replace: true });
      }
    } catch (error) {
      //a chat that keeps its fallback title is not worth interrupting the reply for, but a silent
      //failure here is impossible to tell apart from the feature never running at all
      console.error("chat naming failed", error);
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

  function toggleWebSearch() {
    setSettings((current) => {
      const next = { ...current, web_search_enabled: !current.web_search_enabled };
      if (activeConversationId) persistSettings(next);
      return next;
    });
  }

  function toggleThinking() {
    setSettings((current) => {
      if (requiresThinking(models, current.model)) return current;
      const next = { ...current, thinking_enabled: !current.thinking_enabled };
      if (activeConversationId) persistSettings(next);
      return next;
    });
  }

  function setLorebookAutoMode(autoEnabled) {
    setSettings((current) => {
      const next = { ...current, lorebook_auto: autoEnabled };
      if (activeStoryId) persistSettings(next);
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
    if (mode !== chatMode) setPreviousChatMode(chatMode);
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
        lorebook_auto: settings.lorebook_auto,
        lorebook_model: settings.lorebook_model,
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
          lorebook_auto: settings.lorebook_auto,
          lorebook_model: settings.lorebook_model,
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
      writeRoute(storyRoute(story.id, chapter.id, "chapter"));
      showToast("Story created");
      showToast("Remember to update your Lorebook!");
    } catch (error) {
      setStatus(error.message);
    }
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
      //a conflict now settles itself in the coordinator, the chapter is already back in sync so only a real failure earns a label
      if (error.code !== "chapter_revision_conflict") setChapterSaveState("Save failed");
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

  async function exportStoryItem(story) {
    if (!story?.id || rejectWriteNavigationDuringGeneration()) return;

    try {
      if (story.id === activeStoryIdRef.current) {
        await chapterSaveCoordinator.flush(story.id);
      }

      const response = await fetch(
        `/api/stories/${encodeURIComponent(story.id)}/export`,
      );
      if (!response.ok) {
        throw new Error(await responseErrorDetail(response));
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = storyExportFileName(story);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast(`Exported ${shortTitle(story.title) || "story"}`);
    } catch (error) {
      setStatus(error.message || "Story export failed");
    }
  }

  async function importStoryFile(file) {
    if (!file || rejectWriteNavigationDuringGeneration()) return;

    try {
      const text = await file.text();
      const archive = JSON.parse(text);
      const imported = await storyApi.importStory(archive);
      await loadStories();

      const navigationIntent = beginNavigationIntent();
      const result = await loadStoryBundle(
        imported.story_id,
        imported.first_chapter_id,
        { navigationIntent },
      );
      if (!result || !navigationIntentIsCurrent(navigationIntent)) return;

      commitStoryBundle(result);
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(result.story.id, result.chapter?.id || null, "chapter"));
      showToast(`Imported ${shortTitle(result.story.title) || "story"}`);
      return true;
    } catch (error) {
      setStatus(error.message || "Story import failed");
      return false;
    }
  }

  async function renameStoryItem(story, title) {
    try {
      await storyApi.updateStory(story.id, { title });
      await loadStories();
      if (story.id === activeStoryIdRef.current) {
        const navigationIntent = beginNavigationIntent();
        const result = await loadStoryBundle(
          story.id,
          activeChapterIdRef.current,
          { navigationIntent },
        );
        if (result && navigationIntentIsCurrent(navigationIntent)) {
          commitStoryBundle(result);
        }
      }
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function renameChapterItem(chapter, title) {
    const storyId = activeStoryIdRef.current;
    if (!storyId) return;

    try {
      await flushChapterSave(storyId, chapter.id);
      const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
        storyId,
        chapter.id,
      ) || chapter;
      const updated = await storyApi.updateChapter(storyId, chapter.id, {
        title,
        revision: confirmedChapter.revision,
      });
      chapterSaveCoordinator.rememberServerChapter(updated);
      setChapters((current) =>
        current.map((item) => (
          item.id === updated.id ? chapterWithCoordinatorState(updated) : item
        )),
      );
    } catch (error) {
      setStatus(error.message);
      throw error;
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

  function startLorebookThinking() {
    lorebookReasoningStartedAtRef.current = null;
    setLorebookReasoning({ text: "", streaming: false, durationMs: null });
    setLorebookThinking(true);
    setLorebookPhase("working");
  }

  function appendLorebookReasoning(chunk) {
    if (!lorebookReasoningStartedAtRef.current) {
      lorebookReasoningStartedAtRef.current = performance.now();
    }
    setLorebookReasoning((current) => ({
      text: `${current.text || ""}${String(chunk || "")}`,
      streaming: true,
      durationMs: null,
    }));
    setLorebookPhase("thinking");
  }

  //the model stopped reasoning and is now streaming the actual lorebook json
  function markLorebookUpdating() {
    const startedAt = lorebookReasoningStartedAtRef.current;
    if (startedAt) {
      setLorebookReasoning((current) => ({
        ...current,
        streaming: false,
        durationMs: performance.now() - startedAt,
      }));
    }
    setLorebookPhase("updating");
  }

  function finishLorebookThinking() {
    const startedAt = lorebookReasoningStartedAtRef.current;
    lorebookReasoningStartedAtRef.current = null;
    setLorebookThinking(false);
    setLorebookPhase("");
    setLorebookReasoning((current) => ({
      ...current,
      streaming: false,
      durationMs: startedAt ? performance.now() - startedAt : current.durationMs,
    }));
  }

  async function updateLorebookNow() {
    if (!activeStoryId || !activeChapterId || isStreaming || lorebookUpdating) return;

    try {
      setLorebookUpdating(true);
      startLorebookThinking();
      //the editor autosaves, so push any pending draft before the server reads the chapter
      await flushChapterSave(activeStoryId, activeChapterId);
      const result = await updateLorebookStream({
        storyId: activeStoryId,
        chapterId: activeChapterId,
        onEvent: (event) => {
          if (event.type === "reasoning") appendLorebookReasoning(event.value);
          if (event.type === "content") markLorebookUpdating();
        },
      });

      setLorebookEntries(result.entries || []);
      (result.history || []).forEach(appendWriteHistoryEntry);

      const appliedUpdates = Array.isArray(result.applied) ? result.applied : [];
      const skippedUpdates = Array.isArray(result.skipped) ? result.skipped : [];
      if (result.error) {
        setStatus("Lorebook update failed");
      } else if (skippedUpdates.length) {
        showToast("Lorebook updated; some edits were skipped");
      } else {
        showToast(appliedUpdates.length ? "Lorebook updated" : "Nothing new to save");
      }
    } catch (error) {
      setStatus(error.message);
    } finally {
      finishLorebookThinking();
      setLorebookUpdating(false);
    }
  }

  async function repairTimeline(currentTimeline, onEvent) {
    if (!activeStoryId || isStreaming || lorebookUpdating) {
      throw new Error("Finish the current writing task first.");
    }

    try {
      setLorebookUpdating(true);
      setStatus("");
      const result = await storyApi.repairTimeline({
        storyId: activeStoryId,
        currentTimeline,
        onEvent,
      });
      const repairedEntry = result.entry;

      setLorebookEntries((currentEntries) => {
        const entryExists = currentEntries.some((entry) => entry.id === repairedEntry.id);
        if (!entryExists) return [repairedEntry, ...currentEntries];
        return currentEntries.map((entry) => (
          entry.id === repairedEntry.id ? repairedEntry : entry
        ));
      });
      return result;
    } finally {
      setLorebookUpdating(false);
    }
  }

  async function repairLorebook(onEvent) {
    if (!activeStoryId || isStreaming || lorebookUpdating) {
      throw new Error("Finish the current writing task first.");
    }

    try {
      setLorebookUpdating(true);
      setStatus("");
      const result = await repairLorebookStream({ storyId: activeStoryId, onEvent });

      //the rebuild replaces every visible entry with brand new rows, so swap the whole list rather than merging
      setLorebookEntries(result.entries);
      return result;
    } finally {
      setLorebookUpdating(false);
    }
  }

  async function generateLorebookEntry(category, brief, onEvent, chapterId = null) {
    if (!activeStoryId || isStreaming || lorebookUpdating) {
      throw new Error("Finish the current writing task first.");
    }

    if (category === "synopsis" && chapterId) {
      await flushChapterSave(activeStoryId, chapterId);
    }

    //nothing is saved here, the draft goes back to the editor and the author decides
    return generateLorebookEntryStream({
      storyId: activeStoryId,
      category,
      brief,
      chapterId,
      onEvent,
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
        node.id === updated.id
          ? {
              ...node,
              ...updated,
              // the row the server hands back knows nothing about the live stream, so dont let it
              // clobber what we have been accumulating
              generation_phase: node.generation_phase,
              reasoning: updated.reasoning ?? node.reasoning,
            }
          : node
      )));
    } catch (error) {
      setStatus(error.message);
      await loadBrainstormBundle(activeStoryId);
      throw error;
    }
  }

  async function deleteBrainstormNode(nodeId, hasDescendants = false, skipConfirm = false) {
    if (!activeStoryId || isStreaming) return;
    const nodeType = brainstormNodes.find((node) => node.id === nodeId)?.node_type;
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
        if (!skipConfirm) {
          showToast(hasDescendants ? "Branch deleted" : `${nodeType === "prompt" ? "Prompt" : "Idea"} deleted`);
        }
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
    if (isStreaming || !text || !activeStoryId) return false;
    const brainstormThinkingEnabled = effectiveThinkingEnabled(
      models,
      settings.model,
      settings.thinking_enabled,
    );
    setIsStreaming(true);
    setStatus("");
    setBrainstormPrompt("");
    const abortController = new AbortController();
    abortRef.current = abortController;
    let streamError = "";
    let hasGeneratedIdeas = false;

    try {
      await storyApi.generateBrainstorm({
        storyId: activeStoryId,
        prompt: text,
        selectedIdeaIds,
        ideaCount,
        settings,
        signal: abortController.signal,
        onEvent: (event) => {
          if (event.type === "prompt") {
            const value = event.value || {};
            if (value.node) {
              brainstormPromptNodeIdRef.current = value.node.id;
              setBrainstormNodes((current) => [
                ...current.filter((node) => node.id !== value.node.id),
                {
                  ...value.node,
                  generation_phase: value.node.generation_phase || "waiting",
                  reasoning: value.node.reasoning || "",
                },
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
            const promptNodeId = brainstormPromptNodeIdRef.current;
            const reasoningValue = String(event.value || "");
            if (!promptNodeId || !reasoningValue) return;
            setBrainstormNodes((current) => current.map((node) => (
              node.id === promptNodeId
                ? {
                    ...node,
                    generation_phase: node.generation_phase === "working"
                      ? node.generation_phase
                      : "thinking",
                    reasoning: `${node.reasoning || ""}${reasoningValue}`,
                  }
                : node
            )));
            return;
          }
          if (event.type === "working") {
            const promptNodeId = brainstormPromptNodeIdRef.current;
            if (!promptNodeId) return;
            setBrainstormNodes((current) => current.map((node) => (
              node.id === promptNodeId
                ? { ...node, generation_phase: "working" }
                : node
            )));
            return;
          }
          if (event.type === "ideas") {
            const value = event.value || {};
            hasGeneratedIdeas = Array.isArray(value.nodes) && value.nodes.some(
              (node) => node.node_type === "idea",
            );
            const promptNodeId = brainstormPromptNodeIdRef.current;
            setBrainstormNodes((current) => [
              ...current.map((node) => (
                node.id === promptNodeId
                  ? {
                      ...node,
                      status: "complete",
                      generation_phase: "complete",
                      duration_ms: value.duration_ms,
                    }
                  : node
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
      if (abortController.signal.aborted) {
        setStatus("Brainstorm stopped");
        return false;
      }
      if (streamError) return false;
      if (!hasGeneratedIdeas) {
        setStatus("Brainstorming ended before any ideas were received. Try again.");
        return false;
      }

      showToast("Ideas added");
      return true;
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus("Brainstorm stopped");
      } else {
        setStatus(error.message);
      }
      return false;
    } finally {
      brainstormPromptNodeIdRef.current = null;
      abortRef.current = null;
      try {
        await loadBrainstormBundle(activeStoryId);
      } catch (error) {
        setStatus(error.message);
      }
      setIsStreaming(false);
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

  async function generateStoryChapter(text = prompt.trim(), repairContext = null, repairAttachmentIds = null) {
    const sentAttachmentIds = repairAttachmentIds || promptAttachments.attachmentIds();
    const hasPrompt = Boolean(text) || sentAttachmentIds.length > 0;
    if (isStreaming || hasActiveWriteGeneration() || lorebookUpdating || !hasPrompt || !activeStoryId || !activeChapterId) return;
    const selectedGenerationMode = repairContext ? "edit" : writeGenerationMode;
    const abortController = new AbortController();
    const run = {
      runId: crypto.randomUUID(),
      storyId: activeStoryId,
      chapterId: activeChapterId,
      baseRevision: 0,
      generationMode: selectedGenerationMode,
      status: "preparing",
      abortController,
      startedAt: Date.now(),
      navigationIntent: currentNavigationIntent(),
    };
    writeGenerationRunRef.current = run;
    pendingRepairRef.current = null;
    abortRef.current = abortController;
    setIsStreaming(true);
    setStoryGenerationStatus("Preparing");
    setWriteReasoning({ text: "", streaming: false, durationMs: null });
    setLorebookReasoning({ text: "", streaming: false, durationMs: null });
    setLorebookThinking(false);
    setWriteEditPreview(null);
    writeReasoningStartedAtRef.current = null;
    writeReasoningStreamingRef.current = false;
    lorebookReasoningStartedAtRef.current = null;
    setStatus("");
    let generatedText = "";
    let streamFailed = false;
    let terminalStatus = "completed";
    let targetChapterId = run.chapterId;
    let targetChapterContent = "";
    let targetChapterRevision = 0;

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
      run.generationMode = selectedGenerationMode === "edit" && !targetChapterContent.trim()
        ? "new"
        : selectedGenerationMode;
      setPrompt("");
      if (!repairContext) promptAttachments.releaseAttachments();
      if (selectedGenerationMode === "new") {
        const chapter = await storyApi.createChapter(run.storyId, {
          title: `Chapter ${chapters.length + 1}`,
        });
        const nextChapters = await storyApi.listChapters(run.storyId);
        nextChapters.forEach((chapterItem) => chapterSaveCoordinator.rememberServerChapter(chapterItem));
        targetChapterId = chapter.id;
        run.chapterId = chapter.id;
        run.baseRevision = chapter.revision;
        run.generationMode = "new";
        targetChapterContent = "";
        targetChapterRevision = chapter.revision;
        setChapters(nextChapters.map(chapterWithCoordinatorState));
        setActiveChapterId(chapter.id);
        setChapterContent("");
        setWriteHistoryEntries(chapter.history || []);
        chapterContentRef.current = "";
        setStoryWorkspaceView("chapter");
        writeRoute(storyRoute(run.storyId, chapter.id, "chapter"));
      }

      run.status = "streaming";
      setStoryGenerationStatus(repairContext ? "Fixing the edit" : "Working");
      abortController.signal.throwIfAborted();
      run.generationId = crypto.randomUUID();
      await storyApi.generateChapter({
        storyId: run.storyId,
        chapterId: targetChapterId,
        prompt: text,
        settings,
        generationMode: run.generationMode,
        chapterRevision: targetChapterRevision,
        generationRunId: run.runId,
        generationStatusId: run.generationId,
        repairContext,
        attachmentIds: sentAttachmentIds,
        signal: abortController.signal,
        onEvent: (event) => {
          if (!chapterGenerationEventMatchesRun(event, run)) return;
          if (!generationRunOwnsVisibleWorkspace(run)) return;
          if (event.generationId) run.generationId = event.generationId;
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
            if (run.generationMode === "new") {
              setCanvasStreaming(true);
              setChapterContent(generatedText);
              chapterContentRef.current = generatedText;
            } else {
              const preview = parseStreamingEditPreview(generatedText);
              setWriteEditPreview((current) => nextEditPreview(current, preview));
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
            if (generationRunTargetsOpenChapter(run)) {
              setChapterContent(nextContent);
              chapterContentRef.current = nextContent;
            }

            //the applied edits are already committed above, so the offer below can only ever add to them
            const skipped = Array.isArray(result.rejected) ? result.rejected : [];
            const appliedCount = (result.edits || []).length;
            if (skipped.length || result.truncated) {
              //a truncated run has no rejected list to count, the edits it never got to write simply are not here
              setStatus(skipped.length
                ? `Applied ${appliedCount} of ${appliedCount + skipped.length} edits — ${skipped.length} skipped.`
                : run.generationMode === "new"
                  ? "The connection dropped before the response finished, but what was written so far was saved."
                  : `Applied ${appliedCount} edits before the response hit the token limit.`);
              if (result.repairable) {
                pendingRepairRef.current = {
                  prompt: text,
                  attachmentIds: sentAttachmentIds,
                  context: chapterRepairContext(result, generatedText, appliedCount),
                  appliedCount,
                  skippedCount: skipped.length,
                  truncated: Boolean(result.truncated),
                };
              }
            }
            return;
          }
          if (event.type === "lorebook_start") {
            setStoryGenerationStatus("Working");
            startLorebookThinking();
            return;
          }
          if (event.type === "lorebook_reasoning") {
            setStoryGenerationStatus("Thinking");
            appendLorebookReasoning(event.value);
            return;
          }
          if (event.type === "lorebook_content") {
            setStoryGenerationStatus("Updating Lorebook");
            markLorebookUpdating();
            return;
          }
          if (event.type === "lorebook") {
            finishLorebookThinking();
            const skippedUpdates = Array.isArray(event.value?.skipped) ? event.value.skipped : [];
            if (skippedUpdates.length) {
              showToast("Lorebook updated; some edits were skipped");
            }
            //a run that changed nothing stays quiet, the history line already covers it
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
              if (chapterGenerationErrorIsRepairable(errorValue)) {
                pendingRepairRef.current = {
                  prompt: text,
                  attachmentIds: sentAttachmentIds,
                  context: chapterRepairContext(errorValue, generatedText, 0),
                  appliedCount: 0,
                  skippedCount: 0,
                  truncated: errorValue?.code === "chapter_edit_truncated",
                };
              }
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
      if (error.generationRejected) run.generationId = null;
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
          setStatus(error.message);
        }
      }
      run.status = terminalStatus;
      setIsStreaming(false);
      setStoryGenerationStatus("");
      setCanvasStreaming(false);
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
      //a run that dies mid lorebook would otherwise leave the label shimmering forever
      finishLorebookThinking();
      if (abortRef.current === abortController) abortRef.current = null;
      if (writeGenerationRunRef.current === run) writeGenerationRunRef.current = null;
      setStoryGenerationStatus("");
    }

    //asked only once the run has fully settled, otherwise the modal lands on top of a chapter that is still moving
    const pendingRepair = pendingRepairRef.current;
    pendingRepairRef.current = null;
    if (pendingRepair && !repairContext) offerChapterEditRepair(pendingRepair);
  }

  generateStoryChapterRef.current = generateStoryChapter;

  function offerChapterEditRepair(pendingRepair) {
    const { appliedCount, skippedCount, truncated } = pendingRepair;
    const partial = appliedCount > 0;

    const costNote = "This runs the model again and costs tokens.";
    const appliedSummary = chapterAppliedEditSummary(appliedCount, skippedCount);
    //a truncated run has no skipped count to quote, the edits it never wrote are simply absent
    const partialBody = skippedCount
      ? `${appliedSummary}. `
        + `Retry the ${skippedCount === 1 ? "one that failed" : `${skippedCount} that failed`}? ${costNote}`
      : `${appliedSummary}, `
        + `but the response hit the token limit, so anything it had not written yet is missing. `
        + `Ask for the rest? ${costNote}`;

    setConfirmDialog({
      title: partial
        ? (skippedCount ? "Some edits did not apply" : "The response was cut off")
        : "That edit could not be applied",
      tone: "neutral",
      confirmLabel: "Try again",
      busyLabel: "Retrying",
      body: partial
        ? partialBody
        : (truncated
          ? "The response hit the token limit before a complete edit came through. "
          : "The chapter is unchanged. ")
          + `Retry with the error sent back to the model? ${costNote}`,
      //through the ref, otherwise this closure still sees the isStreaming that was true when the dialog was built and the retry quietly does nothing
      onConfirm: () => {
        void generateStoryChapterRef.current?.(
          pendingRepair.prompt,
          pendingRepair.context,
          pendingRepair.attachmentIds || [],
        );
      },
    });
  }

  const landingMessage = isWritingMode ? writingOpeningMessage : openingMessage;
  const visibleMessages = activeMessages;
  const visibleActiveChatId = activeConversationId;
  const showLandingComposer = isWritingMode ? isEmptyWriting : isEmptyChat;
  const showComposer =
    !(isWritingMode && ["lorebook", "characters", "brainstorm"].includes(storyWorkspaceView) && !showLandingComposer);
  const composerAcceptsFiles =
    showComposer && !(isWritingMode && showLandingComposer) && keyStatus.has_key;
  const filesDraggedOverApp = useFileDrop({
    enabled: composerAcceptsFiles,
    onFiles: promptAttachments.addFiles,
  });

  return (
    <div className="flex h-screen overflow-hidden bg-[#080808] text-ink">
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
          onNewStory={() => {
            if (!isStreaming) setNewStoryDialogOpen(true);
          }}
          onImportStory={importStoryFile}
          onRenameStory={renameStoryItem}
          onExportStory={exportStoryItem}
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
          namingChatId={namingChatId}
          onDeleteChat={deleteChat}
          onExportChat={exportChatFromMenu}
          onTogglePinChat={toggleChatPin}
          folders={folders}
          onCreateFolder={createFolder}
          onRenameFolder={renameFolder}
          onDeleteFolder={deleteFolder}
          onMoveChatToFolder={moveChatToFolder}
          onNewChatInFolder={createChatInFolder}
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
            disabled={!keyStatus.has_key}
            modelLabel={promptModelName(models, settings.model)}
            thinkingEnabled={effectiveThinkingEnabled(
              models, settings.model, settings.thinking_enabled,
            )}
            reasoningRequired={requiresThinking(models, settings.model)}
            thinkingStateLabel={
              effectiveThinkingEnabled(models, settings.model, settings.thinking_enabled)
                ? reasoningEffortLabel(models, settings.model, settings.reasoning_effort)
                : "Instant"
            }
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
            onConfirm={setConfirmDialog}
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
            canvasStreaming={canvasStreaming}
            smoothStreaming={smoothStreaming}
            lorebookStatus={lorebookUpdating ? LOREBOOK_PHASE_LABELS[lorebookPhase] || "Working" : ""}
            writeReasoning={writeReasoning}
            lorebookReasoning={lorebookReasoning}
            lorebookThinking={lorebookThinking}
            writeEditPreview={writeEditPreview}
            canvasScrollPosition={chapterCanvasScrollPosition(activeStoryId, activeChapterId)}
            onOpenRail={() => setRailOpen(true)}
            onOpenLorebook={() => {
              setStoryWorkspaceView("lorebook");
              writeRoute(storyRoute(activeStoryId, activeChapterId, "lorebook"));
            }}
            onBackToChapter={() => {
              setStoryWorkspaceView("chapter");
              writeRoute(storyRoute(activeStoryId, activeChapterId, "chapter"));
            }}
            onCanvasScrollPositionChange={(scrollTop) => {
              rememberChapterCanvasScroll(activeStoryId, activeChapterId, scrollTop);
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
            onRepairTimeline={repairTimeline}
            onRepairLorebook={repairLorebook}
            onGenerateLorebookEntry={generateLorebookEntry}
          />
        ) : !isWritingMode ? (
          <>
            <MessageList
              messages={visibleMessages}
              activeChatId={visibleActiveChatId}
              streamingMessageId={streamingMessageId}
              smoothStreaming={smoothStreaming}
              reasoningStreamingMessageId={reasoningStreamingMessageId}
              searchingMessageId={searchingMessageId}
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
            <WriteLanding openingMessage={landingMessage} />
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
              attachments={promptAttachments.attachments}
              attachmentsUploading={promptAttachments.uploading}
              onAttachFiles={promptAttachments.addFiles}
              onRemoveAttachment={promptAttachments.removeAttachment}
              dragActive={filesDraggedOverApp}
              webSearchEnabled={settings.web_search_enabled}
              onToggleWebSearch={toggleWebSearch}
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
            onUpdateLorebook={updateLorebookNow}
            onSetLorebookAuto={setLorebookAutoMode}
            lorebookUpdating={lorebookUpdating}
            systemPrompt={isWritingMode ? settings.system_prompt : ""}
            onSaveSystemPrompt={isWritingMode ? saveStorySystemPrompt : null}
            forceShowThinking={Boolean(writeTour.currentStep?.forceThinkingVisible)}
            tourUi={writeTour.currentStep?.composerUi || null}
            attachments={promptAttachments.attachments}
            attachmentsUploading={promptAttachments.uploading}
            onAttachFiles={promptAttachments.addFiles}
            onRemoveAttachment={promptAttachments.removeAttachment}
            dragActive={filesDraggedOverApp}
            webSearchEnabled={settings.web_search_enabled}
            onToggleWebSearch={toggleWebSearch}
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
        generateChatName={generateChatName}
        hideFreeModels={hideFreeModels}
        nitroMode={nitroMode}
        cheapestMode={cheapestMode}
        privacyMode={privacyMode}
        zdrMode={zdrMode}
        smoothStreaming={smoothStreaming}
        showPromptNavigationRail={showPromptNavigationRail}
        modelLocked={activeModelLocked}
        onPersist={persistSettings}
        onModelSelected={(name) => showToast(`Model selected: ${name}`)}
        onSetDefaultModel={updateDefaultModel}
        onToggleGenerateChatName={updateGenerateChatName}
        onToggleHideFreeModels={updateHideFreeModels}
        onToggleNitroMode={updateNitroMode}
        onToggleCheapestMode={updateCheapestMode}
        onTogglePrivacyMode={updatePrivacyMode}
        onToggleZdrMode={updateZdrMode}
        onToggleSmoothStreaming={updateSmoothStreaming}
        onTogglePromptNavigationRail={updatePromptNavigationRail}
        onExportChats={exportChats}
        onImportChats={importChats}
        onNotify={showToast}
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

function Root() {
  const [gate, setGate] = useState({ status: "loading", tos: null, message: "" });
  const [acceptError, setAcceptError] = useState("");

  const loadTos = useCallback(async () => {
    setGate((current) => ({ ...current, status: "loading" }));

    try {
      const tos = await api("/api/tos");
      setGate({
        status: tos.accepted ? "accepted" : "blocked",
        tos,
        message: "",
      });
    } catch (error) {
      //anything that isnt a clean "accepted" answer keeps the app shut, including the backend being down
      setGate({
        status: "unavailable",
        tos: null,
        message:
          error?.code === "api_auth_required"
            ? "Open RouterChat through its launcher to authorize this browser."
            : error?.code === "tos_missing"
              ? error.message
              : "Could not reach the RouterChat backend to load the Terms of Service.",
      });
    }
  }, []);

  useEffect(() => {
    loadTos();
  }, [loadTos]);

  const acceptTos = useCallback(async () => {
    setAcceptError("");

    try {
      const accepted = await api("/api/tos/accept", {
        method: "POST",
        body: JSON.stringify({ hash: gate.tos.hash }),
      });
      setGate({ status: "accepted", tos: accepted, message: "" });
    } catch (error) {
      if (error?.code === "tos_stale") {
        //TOS.md changed underneath us, pull the new text instead of letting them through
        setAcceptError(error.message);
        await loadTos();
        return;
      }

      setAcceptError(error?.message || "Could not record your acceptance. Try again.");
    }
  }, [gate.tos, loadTos]);

  if (gate.status === "loading") {
    return <TosLoadingScreen />;
  }

  if (gate.status === "unavailable") {
    return <TosUnavailableScreen message={gate.message} onRetry={loadTos} />;
  }

  if (gate.status === "blocked") {
    return <TosGateModal tos={gate.tos} onAccept={acceptTos} error={acceptError} />;
  }

  return <App />;
}

createRoot(document.getElementById("root")).render(<Root />);
