import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { X } from "lucide-react";

export function SystemPromptModal({ open, value, onSave, onClose }) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [draft, setDraft] = useState(value || "");
  const [saveState, setSaveState] = useState("saved");
  const closeRef = useRef(null);
  const textareaRef = useRef(null);
  const latestSavedRef = useRef(value || "");
  const draftRef = useRef(value || "");
  const saveTimeoutRef = useRef(null);
  const saveRunRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const nextValue = value || "";
    setDraft(nextValue);
    draftRef.current = nextValue;
    latestSavedRef.current = nextValue;
    setSaveState("saved");
  }, [open, value]);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
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

  useEffect(
    () => () => {
      window.clearTimeout(saveTimeoutRef.current);
    },
    [],
  );

  async function savePrompt(nextValue, savedLabel = "saved") {
    if (!onSave) return;
    if (nextValue === latestSavedRef.current) {
      setSaveState("saved");
      return;
    }

    const runId = saveRunRef.current + 1;
    saveRunRef.current = runId;
    setSaveState("saving");

    try {
      await onSave(nextValue);
      if (runId !== saveRunRef.current) return;
      latestSavedRef.current = nextValue;
      setSaveState(savedLabel);
      window.setTimeout(() => {
        if (saveRunRef.current === runId && draftRef.current === latestSavedRef.current) {
          setSaveState("saved");
        }
      }, 1400);
    } catch {
      if (runId === saveRunRef.current) {
        setSaveState("save failed");
      }
    }
  }

  function queueAutosave(nextValue) {
    window.clearTimeout(saveTimeoutRef.current);
    if (nextValue === latestSavedRef.current) {
      setSaveState("saved");
      return;
    }

    setSaveState("unsaved");
    saveTimeoutRef.current = window.setTimeout(() => {
      void savePrompt(draftRef.current, "autosaved");
    }, 600);
  }

  function updateDraft(nextValue) {
    setDraft(nextValue);
    draftRef.current = nextValue;
    queueAutosave(nextValue);
  }

  function saveNow() {
    window.clearTimeout(saveTimeoutRef.current);
    void savePrompt(draftRef.current, "saved");
  }

  function clearPrompt() {
    updateDraft("");
  }

  if (!rendered) return null;

  const isOpen = phase === "open";
  const canSave = saveState !== "saving" && draft !== latestSavedRef.current;
  const saveStateLabel = saveState.replace(/\b\w/g, (letter) => letter.toUpperCase());

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close system prompt"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <section
        data-tour="write-system-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-prompt-title"
        className={cx(
          "t-modal relative z-10 flex max-h-[min(620px,calc(100dvh-2rem))] w-full max-w-[560px] flex-col overflow-hidden rounded-[24px] bg-[#181818] text-neutral-100 [box-shadow:var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <header className="flex items-center justify-between gap-4 px-4 pb-3 pt-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 id="system-prompt-title" className="text-balance text-base font-semibold leading-6 text-neutral-100">
                System prompt
              </h2>
              <span
                className={cx(
                  "inline-flex h-6 items-center rounded-full bg-white/[0.045] px-2.5 text-base font-semibold leading-6 shadow-[var(--shadow-border)]",
                  saveState === "save failed"
                    ? "text-red-300"
                    : saveState === "saving" || saveState === "unsaved"
                      ? "text-neutral-400"
                      : "text-emerald-300",
                )}
              >
                {saveStateLabel}
              </span>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className={cx(
              "grid h-10 w-10 shrink-0 place-items-center rounded-full text-neutral-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
              CONTROL_MOTION,
            )}
            aria-label="Close system prompt"
          >
            <X size={17} />
          </button>
        </header>
        <div className="min-h-0 flex-1 px-4 pb-2">
          <div className="prompt-edit-surface h-[min(340px,calc(100dvh-17rem))] min-h-[220px] rounded-[18px] px-4 py-3">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              placeholder="No story system prompt"
              data-1p-ignore="true"
              className="block h-full w-full resize-none overflow-y-auto bg-transparent text-sm leading-6 text-neutral-100 outline-none placeholder:text-neutral-500"
            />
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-3 px-4 pb-2">
          <div className="flex items-center gap-2">
            {draft && (
              <button
                type="button"
                onClick={clearPrompt}
                className={cx(
                  "inline-flex h-8 items-center justify-center rounded-full px-3 text-sm font-medium text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                  CONTROL_MOTION,
                )}
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={saveNow}
              disabled={!canSave}
              className={cx(
                "inline-flex h-8 items-center justify-center rounded-full px-4 text-sm font-semibold text-neutral-100 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:active:scale-100",
                CONTROL_MOTION,
              )}
            >
              {saveState === "saving" ? "Saving" : "Save"}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
