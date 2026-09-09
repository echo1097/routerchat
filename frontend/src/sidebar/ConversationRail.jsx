import { useState, useRef, useEffect } from "react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { promptModelName } from "../modelFormatting.js";
import { ChatHistoryActions, FolderActions } from "./HistoryActions.jsx";
import { MaskIcon } from "../components/IconButton.jsx";
import { SidebarGroup } from "./SidebarGroup.jsx";
import { APP_VERSION } from "../appInfo.js";
import { X } from "lucide-react";
import { SlidingTabs } from "../components/SlidingTabs.jsx";
import { CHAT_MODES } from "../settings/settingsDefaults.js";
import { FeedbackLink } from "./FeedbackLink.jsx";
import { SidebarSearchModal } from "./SidebarSearchModal.jsx";
import { NamePromptModal } from "../components/NamePromptModal.jsx";

export function ConversationRail({
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
