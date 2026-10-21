import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { X } from "lucide-react";

const FIELDS = [
  {
    key: "scenario",
    label: "Scenario",
    hint: "Where everyone is, what just happened, what is at stake. {{char}} and {{user}} work here.",
    placeholder: "A diner at 3am. Nobody has said the thing yet.",
    rows: 7,
  },
  {
    key: "author_note",
    label: "Author's note",
    hint: "Slipped in near the end of the context every turn, so it steers the next reply rather than the whole scene.",
    placeholder: "Keep the tension up. Nobody apologises yet.",
    rows: 3,
  },
];

export function SceneModal({ open, scenario, authorNote, onSave, onClose }) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [draft, setDraft] = useState({ scenario: "", author_note: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const firstFieldRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setDraft({ scenario: scenario || "", author_note: authorNote || "" });
    setError("");
  }, [open, scenario, authorNote]);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      requestAnimationFrame(() => firstFieldRef.current?.focus());
      return undefined;
    }

    if (!rendered) return undefined;

    setPhase("closing");
    const closeMs = parseFloat(
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

  async function saveScene() {
    if (saving) return;

    try {
      setSaving(true);
      setError("");
      await onSave(draft);
      onClose();
    } catch (saveError) {
      setError(saveError.message || "Could not save the scene.");
    } finally {
      setSaving(false);
    }
  }

  if (!rendered) return null;

  const isOpen = phase === "open";
  const dirty =
    draft.scenario !== (scenario || "") || draft.author_note !== (authorNote || "");

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close scene"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="scene-title"
        className={cx(
          "t-modal relative z-10 flex max-h-[min(660px,calc(100dvh-2rem))] w-full max-w-[560px] flex-col overflow-hidden rounded-[24px] bg-[#181818] text-neutral-100 [box-shadow:var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <header className="flex items-center justify-between gap-4 px-4 pb-3 pt-4">
          <h2 id="scene-title" className="text-balance text-base font-semibold leading-6 text-neutral-100">
            Scene
          </h2>
          <button
            type="button"
            onClick={onClose}
            className={cx(
              "grid h-10 w-10 shrink-0 place-items-center rounded-full text-neutral-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
              CONTROL_MOTION,
            )}
            aria-label="Close scene"
          >
            <X size={17} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-2">
          {FIELDS.map((field, index) => (
            <label key={field.key} className="block">
              <span className="mb-1.5 block text-sm font-medium text-neutral-300">{field.label}</span>
              <div className="prompt-edit-surface rounded-[18px] px-4 py-3">
                <textarea
                  ref={index === 0 ? firstFieldRef : null}
                  value={draft[field.key]}
                  rows={field.rows}
                  onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                  placeholder={field.placeholder}
                  data-1p-ignore="true"
                  className="block w-full resize-none bg-transparent text-sm leading-6 text-neutral-100 outline-none placeholder:text-neutral-500"
                />
              </div>
              <span className="mt-1.5 block text-xs leading-5 text-neutral-500">{field.hint}</span>
            </label>
          ))}

          {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 pb-4 pt-2">
          <button
            type="button"
            onClick={onClose}
            className={cx(
              "inline-flex h-8 items-center justify-center rounded-full px-3 text-sm font-medium text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
              CONTROL_MOTION,
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={saveScene}
            disabled={saving || !dirty}
            className={cx(
              "inline-flex h-8 items-center justify-center rounded-full px-4 text-sm font-semibold text-neutral-100 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:active:scale-100",
              CONTROL_MOTION,
            )}
          >
            {saving ? "Saving" : "Save"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
