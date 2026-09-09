import { useState } from "react";
import { OverflowActions } from "../components/OverflowActions.jsx";
import { cx } from "../uiShared.js";
import { Pencil, X, Trash2, Eye, EyeOff } from "lucide-react";
import { MaskIcon } from "../components/IconButton.jsx";

export function ChatHistoryActions({
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

export function FolderActions({ folder, onRename, onDelete, onNewChat }) {
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

export function StoryHistoryActions({ story, onRename, onExport, onDelete, exportDisabled = false }) {
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

export function ChapterHistoryActions({ chapter, onRename, onDelete, onToggleContext }) {
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
