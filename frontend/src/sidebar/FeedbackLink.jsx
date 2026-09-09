import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { X } from "lucide-react";
import { MarkdownContent } from "../chat/MarkdownContent.jsx";
import { api } from "../api.js";

const FEEDBACK_FORM_URL = "https://forms.gle/gTth2TcXLYAArvGm6";

const GITHUB_RELEASES_LATEST_URL = "https://api.github.com/repos/echo1097/routerchat/releases/latest";

function ChangelogModal({ open, onClose }) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [status, setStatus] = useState("idle");
  const [release, setRelease] = useState(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      requestAnimationFrame(() => panelRef.current?.focus());
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

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    setStatus("loading");

    fetch(GITHUB_RELEASES_LATEST_URL, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        setRelease(data);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!rendered) return null;

  const isOpen = phase === "open";
  const releaseBody = release?.body;

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close changelog"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Changelog"
        tabIndex={-1}
        className={cx(
          "t-modal relative z-10 flex max-h-[min(640px,calc(100dvh-2rem))] w-full max-w-[560px] flex-col overflow-hidden rounded-[26px] bg-[#191919] text-neutral-100 outline-none [box-shadow:var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <button
          type="button"
          onClick={onClose}
          className={cx(
            "absolute right-3 top-3 z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full text-neutral-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 sm:right-4 sm:top-4",
            CONTROL_MOTION,
          )}
          aria-label="Close changelog"
        >
          <X size={17} />
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-5 sm:px-6 sm:pt-6">
          {status === "loading" && (
            <p className="text-sm leading-5 text-neutral-500">Loading latest release…</p>
          )}
          {status === "error" && (
            <p className="text-sm leading-5 text-neutral-500">
              Couldn't load the changelog right now. Try again later.
            </p>
          )}
          {status === "ready" && (
            <div className="text-[13px] leading-6 text-neutral-300">
              <MarkdownContent>
                {releaseBody || "No description provided for this release."}
              </MarkdownContent>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

let changelogAutoCheckStarted = false;

export function FeedbackLink() {
  const [changelogOpen, setChangelogOpen] = useState(false);

  useEffect(() => {
    if (changelogAutoCheckStarted) return;
    changelogAutoCheckStarted = true;

    api("/api/changelog/status")
      .then((status) => {
        if (!status?.should_show) return;
        setChangelogOpen(true);
        return api("/api/changelog/seen", { method: "POST" });
      })
      .catch(() => {});
  }, []);

  return (
    <>
      <div className="flex w-full items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => setChangelogOpen(true)}
          className={cx(
            "flex h-9 flex-1 items-center justify-center rounded-xl px-2 text-[13px] font-medium text-neutral-500 hover:bg-white/[0.045] hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
            CONTROL_MOTION,
          )}
        >
          Changelog
        </button>
        <a
          href={FEEDBACK_FORM_URL}
          target="_blank"
          rel="noreferrer"
          className={cx(
            "flex h-9 flex-1 items-center justify-center rounded-xl px-2 text-[13px] font-medium text-neutral-500 hover:bg-white/[0.045] hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
            CONTROL_MOTION,
          )}
        >
          Feedback
        </a>
      </div>
      <ChangelogModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />
    </>
  );
}
