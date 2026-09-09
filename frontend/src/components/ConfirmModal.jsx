import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { cx, CONTROL_MOTION } from "../uiShared.js";

export function ConfirmModal({ dialog, onClose }) {
  const [renderedDialog, setRenderedDialog] = useState(dialog);
  const [phase, setPhase] = useState(dialog ? "open" : "closed");
  const [busy, setBusy] = useState(false);
  const [nameOverflowing, setNameOverflowing] = useState(false);
  const cancelRef = useRef(null);
  const chatNameRef = useRef(null);

  useEffect(() => {
    if (dialog) {
      setRenderedDialog(dialog);
      setPhase("open");
      setBusy(false);
      requestAnimationFrame(() => cancelRef.current?.focus());
      return undefined;
    }

    if (!renderedDialog) return undefined;

    setPhase("closing");
    const closeMs =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--modal-close-dur"),
      ) || 150;
    const timeoutId = window.setTimeout(() => {
      setRenderedDialog(null);
      setPhase("closed");
      setBusy(false);
    }, closeMs);
    return () => window.clearTimeout(timeoutId);
  }, [dialog, renderedDialog]);

  useEffect(() => {
    if (!renderedDialog) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape" && !busy) onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, renderedDialog]);

  useEffect(() => {
    if (!renderedDialog?.chatTitle) {
      setNameOverflowing(false);
      return undefined;
    }

    const node = chatNameRef.current;
    if (!node) return undefined;

    function measure() {
      setNameOverflowing(node.scrollWidth > node.clientWidth + 1);
    }

    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [renderedDialog?.chatTitle]);

  if (!renderedDialog) return null;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    const closeOnConfirm = Boolean(renderedDialog.closeOnConfirm);
    if (closeOnConfirm) onClose();

    try {
      await renderedDialog.onConfirm();
      if (!closeOnConfirm) onClose();
    } catch {
      if (!closeOnConfirm) setBusy(false);
    }
  }

  async function runSecondary() {
    if (busy) return;
    setBusy(true);
    try {
      await renderedDialog.onSecondary();
      onClose();
    } catch {
      setBusy(false);
    }
  }

  const open = phase === "open";

  return createPortal(
    <div className="fixed inset-0 z-[100] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close dialog"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-modal-title"
        className={cx(
          "t-modal relative z-10 w-fit max-w-[calc(100vw-2rem)] rounded-[24px] bg-[#181818] p-4 text-neutral-100 [box-shadow:var(--shadow-surface)] sm:max-w-[560px]",
          open ? "is-open" : "is-closing",
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <h2
            id="delete-modal-title"
            className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden text-base font-semibold text-neutral-100"
          >
            <span className="shrink-0">{renderedDialog.title || "Delete chat"}</span>
            {renderedDialog.chatTitle && (
              <span className="delete-chat-name" title={renderedDialog.chatTitle}>
                <span
                  ref={chatNameRef}
                  className={cx(
                    "delete-chat-name-text",
                    nameOverflowing && "is-overflowing",
                  )}
                >
                  {renderedDialog.chatTitle}
                </span>
              </span>
            )}
          </h2>
        </div>
        {renderedDialog.body && (
          <p className="mt-2 text-sm text-neutral-400">{renderedDialog.body}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
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
          {renderedDialog.secondaryLabel && renderedDialog.onSecondary && (
            <button
              type="button"
              disabled={busy}
              onClick={runSecondary}
              className={cx(
                "h-10 rounded-full bg-white/[0.05] px-4 text-sm font-medium text-red-300 hover:bg-red-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200/40 disabled:cursor-not-allowed disabled:opacity-55",
                CONTROL_MOTION,
              )}
            >
              {renderedDialog.secondaryLabel}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className={cx(
              "h-10 rounded-full px-4 text-sm font-semibold text-neutral-950 focus:outline-none disabled:cursor-not-allowed disabled:opacity-55",

              renderedDialog.tone === "neutral"
                ? "bg-neutral-100 hover:bg-white focus-visible:ring-2 focus-visible:ring-white/40"
                : "bg-red-400 hover:bg-red-300 focus-visible:ring-2 focus-visible:ring-red-200/60",
              CONTROL_MOTION,
            )}
          >
            {busy
              ? renderedDialog.busyLabel || "Deleting"
              : renderedDialog.confirmLabel || "Delete"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
