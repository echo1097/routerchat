import { useState, useId, useRef, useEffect } from "react";
import { cx, CONTROL_MOTION } from "../uiShared.js";

export function NamePromptModal({
  open,
  onClose,
  onCreate,
  heading,
  description,
  placeholder,
  inputLabel,
  submitLabel,
  dialogLabel,
}) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const titleInputId = useId();
  const headingId = useId();
  const titleRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      setTitle("");
      setBusy(false);
      requestAnimationFrame(() => titleRef.current?.focus());
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
      setBusy(false);
    }, closeMs);
    return () => window.clearTimeout(timeoutId);
  }, [open, rendered]);

  useEffect(() => {
    if (!rendered) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape" && !busy) onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, rendered]);

  if (!rendered) return null;

  const nextName = title.trim();
  const canCreate = nextName.length > 0 && !busy;
  const isOpen = phase === "open";

  async function createItem(event) {
    event.preventDefault();
    if (!canCreate) return;

    setBusy(true);
    try {
      await onCreate(nextName);
      onClose();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label={dialogLabel}
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onSubmit={createItem}
        className={cx(
          "t-modal relative z-10 w-full max-w-[420px] rounded-[24px] bg-[#181818] p-4 text-neutral-100 [box-shadow:var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <div>
          <h2
            id={headingId}
            className="text-balance text-base font-semibold text-neutral-100"
          >
            {heading}
          </h2>
          <p className="mt-2 text-pretty text-sm leading-6 text-neutral-400">
            {description}
          </p>
        </div>
        <input
          ref={titleRef}
          id={titleInputId}
          type="text"
          value={title}
          disabled={busy}
          maxLength={120}
          data-1p-ignore="true"
          onChange={(event) => setTitle(event.target.value)}
          placeholder={placeholder}
          aria-label={inputLabel}
          className="mt-4 h-11 w-full rounded-2xl bg-black/25 px-3.5 text-sm font-medium text-neutral-100 shadow-[var(--shadow-border)] outline-none placeholder:text-neutral-600 focus:shadow-[var(--shadow-border-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className={cx(
              "h-10 rounded-full bg-white/[0.05] px-4 text-sm font-medium text-neutral-300 hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15 disabled:cursor-not-allowed disabled:opacity-55",
              CONTROL_MOTION,
            )}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className={cx(
              "h-10 rounded-full bg-neutral-100 px-4 text-sm font-semibold text-neutral-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-55",
              CONTROL_MOTION,
            )}
          >
            {busy ? "Creating" : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
