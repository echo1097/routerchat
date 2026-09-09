import { useState, useRef, useEffect } from "react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { APP_VERSION } from "../appInfo.js";
import { MaskIcon } from "../components/IconButton.jsx";
import { X, EyeOff } from "lucide-react";
import { SlidingTabs } from "../components/SlidingTabs.jsx";
import { CHAT_MODES } from "../settings/settingsDefaults.js";
import { SidebarGroup } from "./SidebarGroup.jsx";
import { StoryHistoryActions, ChapterHistoryActions } from "./HistoryActions.jsx";
import { FeedbackLink } from "./FeedbackLink.jsx";
import { SidebarSearchModal } from "./SidebarSearchModal.jsx";

export function StoryRail({
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
