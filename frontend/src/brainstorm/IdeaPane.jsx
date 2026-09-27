import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Edit3, GitBranch, Trash2, X } from "lucide-react";
import { CONTROL_MOTION, cx } from "../uiShared.js";
import { useCopyAction } from "./brainstormShared.jsx";

export default function IdeaPane({
  open,
  idea,
  siblingIndex,
  siblingCount,
  isBranch,
  operationInProgress,
  onPrevious,
  onNext,
  onClose,
  onToggleBranch,
  onSave,
  onDelete,
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(idea?.title || "");
  const [content, setContent] = useState(idea?.content || "");
  const [saving, setSaving] = useState(false);
  const titleInputRef = useRef(null);
  const [copied, copyIdea] = useCopyAction(() => `${idea?.title}\n-\n${idea?.content}`);
  const ideaId = idea?.id;

  useEffect(() => {
    setEditing(false);
  }, [ideaId]);

  useEffect(() => {
    if (editing || !idea) return;
    setTitle(idea.title);
    setContent(idea.content);
  }, [editing, idea]);

  useEffect(() => {
    if (editing) titleInputRef.current?.focus();
  }, [editing]);

  async function saveEdit() {
    const nextTitle = title.trim();
    const nextContent = content.trim();
    if (!nextTitle || !nextContent || saving) return;

    setSaving(true);
    try {
      await onSave({ title: nextTitle, content: nextContent });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  const isOpen = Boolean(open && idea);
  const canSave = Boolean(title.trim() && content.trim()) && !saving;

  return (
    <aside
      className={cx("brainstorm-pane", isOpen && "is-open")}
      aria-label="Idea"
      aria-hidden={!isOpen}
      inert={isOpen ? undefined : ""}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (editing) setEditing(false);
        else onClose();
      }}
    >
      {idea && (
        <div className="brainstorm-pane-inner">
          <div className="brainstorm-pane-head">
            <div className="brainstorm-pane-stepper">
              <button
                type="button"
                className={cx("brainstorm-pane-icon", CONTROL_MOTION)}
                onClick={onPrevious}
                disabled={siblingIndex <= 0}
                aria-label="Previous idea"
                title="Previous idea"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="brainstorm-pane-count tabular-nums">
                Idea {siblingIndex + 1} of {siblingCount}
              </span>
              <button
                type="button"
                className={cx("brainstorm-pane-icon", CONTROL_MOTION)}
                onClick={onNext}
                disabled={siblingIndex >= siblingCount - 1}
                aria-label="Next idea"
                title="Next idea"
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <button
              type="button"
              className={cx("brainstorm-pane-icon", CONTROL_MOTION)}
              onClick={onClose}
              aria-label="Close idea"
              title="Close idea"
            >
              <X size={16} />
            </button>
          </div>

          <div key={idea.id} className="brainstorm-pane-scroll">
            {editing ? (
              <form
                className="brainstorm-pane-edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveEdit();
                }}
              >
                <input
                  ref={titleInputRef}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  aria-label="Idea title"
                  data-1p-ignore="true"
                />
                <textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  aria-label="Idea details"
                  data-1p-ignore="true"
                  rows={9}
                />
                <div className="brainstorm-pane-tools">
                  <button type="button" className={cx("brainstorm-pill", CONTROL_MOTION)} onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  <button type="submit" className={cx("brainstorm-pill is-primary", CONTROL_MOTION)} disabled={!canSave}>
                    {saving ? "Saving" : "Save idea"}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <h2 className="brainstorm-pane-title">{idea.title}</h2>
                <p className="brainstorm-pane-body">{idea.content}</p>
                <div className="brainstorm-pane-tools">
                  <button type="button" className={cx("brainstorm-pill", CONTROL_MOTION)} onClick={copyIdea}>
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button type="button" className={cx("brainstorm-pill", CONTROL_MOTION)} onClick={() => setEditing(true)}>
                    <Edit3 size={14} />
                    Edit
                  </button>
                  <button
                    type="button"
                    className={cx("brainstorm-pill is-danger", CONTROL_MOTION)}
                    onClick={onDelete}
                    disabled={operationInProgress}
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="brainstorm-pane-foot">
            <button
              type="button"
              className={cx("brainstorm-pill is-wide", !isBranch && "is-primary", CONTROL_MOTION)}
              onClick={onToggleBranch}
              aria-pressed={isBranch}
            >
              {isBranch ? <Check size={15} strokeWidth={2.4} /> : <GitBranch size={15} />}
              {isBranch ? "Branching from this idea" : "Branch from this idea"}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
