import { useState, useRef } from "react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { promptModelName } from "../modelFormatting.js";
import { ChatHistoryActions, FolderActions } from "./HistoryActions.jsx";
import { MaskIcon } from "../components/IconButton.jsx";
import { SidebarGroup } from "./SidebarGroup.jsx";
import { SidebarShell } from "./SidebarShell.jsx";
import { SidebarActionButton } from "./SidebarActionButton.jsx";
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
  const skipRenameCommitRef = useRef(false);
  const skipFolderRenameCommitRef = useRef(false);

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
      <SidebarShell
        mode={chatMode}
        previousChatMode={previousChatMode}
        onChatModeChange={onChatModeChange}
        mobileOpen={mobileOpen}
        onCloseMobile={onCloseMobile}
        collapsed={collapsed}
        onCollapse={onCollapse}
        onSearch={() => setSearchOpen(true)}
        searchLabel="Search chats"
        closeLabel="Close chats"
        collapseTourId="collapse-sidebar-button"
        listClassName="space-y-1"
        actions={(
          <div>
            <SidebarActionButton
              icon={<MaskIcon src="/icons/new-message.png" size={20} />}
              label="New chat"
              onClick={() => {
                onNewChat();
                onCloseMobile();
              }}
            />
            <SidebarActionButton
              icon={<MaskIcon src="/icons/folder.png" size={20} />}
              label="New folder"
              onClick={() => setNewFolderOpen(true)}
            />
          </div>
        )}
      >
        {historyItems}
      </SidebarShell>

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
