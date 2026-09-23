import { useState, useRef } from "react";
import { cx } from "../uiShared.js";
import { MaskIcon } from "../components/IconButton.jsx";
import { EyeOff } from "lucide-react";
import { SidebarGroup } from "./SidebarGroup.jsx";
import { SidebarShell } from "./SidebarShell.jsx";
import { SidebarActionButton } from "./SidebarActionButton.jsx";
import {
  SIDEBAR_ROW,
  SIDEBAR_ROW_IDLE,
  SIDEBAR_ROW_BUTTON,
  SIDEBAR_RENAME_INPUT,
} from "./sidebarStyles.js";
import { StoryHistoryActions, ChapterHistoryActions } from "./HistoryActions.jsx";
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
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [importingStory, setImportingStory] = useState(false);
  const renameInputRef = useRef(null);
  const importInputRef = useRef(null);
  const skipRenameCommitRef = useRef(false);

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
      <SidebarShell
        mode="write"
        previousChatMode={previousChatMode}
        onChatModeChange={onChatModeChange}
        mobileOpen={mobileOpen}
        onCloseMobile={onCloseMobile}
        collapsed={collapsed}
        onCollapse={onCollapse}
        onSearch={() => setSearchOpen(true)}
        searchLabel="Search stories"
        closeLabel="Close stories"
        listClassName="space-y-3"
        actions={(
          <div>
            <SidebarActionButton
              tourId="write-home-button"
              icon={<i className="fi fi-rr-home text-[16px] leading-none" />}
              label="Home"
              disabled={navigationLocked}
              onClick={() => {
                if (navigationLocked) return;
                onGoHome();
                onCloseMobile();
              }}
            />
            <SidebarActionButton
              icon={<MaskIcon src="/icons/newbook.png" size={18} />}
              label="New story"
              disabled={navigationLocked}
              onClick={() => {
                if (navigationLocked) return;
                onNewStory();
                onCloseMobile();
              }}
            />
            <SidebarActionButton
              icon={<MaskIcon src="/icons/file-import.png" size={16} />}
              label={importingStory ? "Importing story" : "Import story"}
              disabled={navigationLocked || importingStory}
              onClick={() => importInputRef.current?.click()}
            />
            <input
              ref={importInputRef}
              type="file"
              aria-label="Import story file"
              accept="application/json,.json"
              className="hidden"
              onChange={importStoryFile}
            />
          </div>
        )}
      >
        {stories.length === 0 ? (
          <div className="px-2.5 py-6 text-pretty text-[13px] leading-5 text-[#858585]">
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
                <div key={story.id} className="flex flex-col gap-px">
                  <div
                    data-tour={active ? "write-story-rail" : undefined}
                    className={cx(SIDEBAR_ROW, SIDEBAR_ROW_IDLE)}
                  >
                    {renamingStory ? (
                      <div className="flex h-9 min-w-0 items-center px-1">
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
                          className={cx(SIDEBAR_RENAME_INPUT, "h-6 text-[14px]")}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-current={active ? "true" : undefined}
                        onClick={() => {
                          if (navigationLocked) return;
                          onSelectStory(story.id);
                          onCloseMobile();
                        }}
                        disabled={navigationLocked}
                        className={cx(SIDEBAR_ROW_BUTTON, "flex h-9 items-center")}
                      >
                        <span
                          className={cx(
                            "truncate text-[14px] leading-[18px]",
                            active
                              ? "font-medium text-white"
                              : "text-neutral-300 group-hover:text-neutral-100",
                          )}
                        >
                          {story.title}
                        </span>
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
      </SidebarShell>

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
