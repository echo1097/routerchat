import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { FileWarning, Loader2, LockKeyhole, Unplug } from "lucide-react";

import { cx, CONTROL_MOTION } from "./uiShared.js";
import { MARKDOWN_IMAGE_COMPONENT } from "./markdownImage.jsx";

//fractional scroll heights and browser zoom lie to you by a pixel or two, so dont demand an exact landing
const SCROLL_TOLERANCE = 4;

const TOS_MARKDOWN_COMPONENTS = {
  ...MARKDOWN_IMAGE_COMPONENT,
  h1: ({ node, ...props }) => (
    <h1 className="mb-2 mt-8 text-xl font-semibold text-ink first:mt-0" {...props} />
  ),
  h2: ({ node, ...props }) => (
    <h2 className="mb-2 mt-8 text-[15px] font-semibold text-ink first:mt-0" {...props} />
  ),
  h3: ({ node, ...props }) => (
    <h3 className="mb-2 mt-6 text-sm font-semibold text-neutral-200" {...props} />
  ),
  p: ({ node, ...props }) => <p className="mb-4 text-pretty last:mb-0" {...props} />,
  strong: ({ node, ...props }) => <strong className="font-semibold text-ink" {...props} />,
  a: ({ node, ...props }) => (
    <a
      className="text-accent underline decoration-accent/30 underline-offset-4"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  ul: ({ node, ...props }) => <ul className="my-4 list-disc space-y-2 pl-5" {...props} />,
  ol: ({ node, ...props }) => <ol className="my-4 list-decimal space-y-2 pl-5" {...props} />,
  li: ({ node, ...props }) => <li className="text-pretty" {...props} />,
  hr: ({ node, ...props }) => <hr className="my-8 border-line" {...props} />,
  code: ({ node, ...props }) => (
    <code className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[0.92em] text-neutral-100" {...props} />
  ),
};

function versionLabel(date, hash) {
  if (date) return date;
  //no parseable "Last updated" line, fall back to something that at least identifies the version
  return hash ? `version ${hash.slice(0, 12)}` : "unknown version";
}

function FullScreen({ children }) {
  return (
    <div className="grid h-screen w-screen place-items-center overflow-hidden bg-[#080808] px-4 py-6 text-ink">
      {children}
    </div>
  );
}

export function TosLoadingScreen() {
  return (
    <FullScreen>
      <div className="flex items-center gap-3 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
        <span>Loading terms</span>
      </div>
    </FullScreen>
  );
}

const UNAVAILABLE_REASONS = {
  auth: {
    icon: LockKeyhole,
    title: "This browser isn't authorized",
    detail: "RouterChat only talks to the window its launcher opens, so this tab can't load the Terms of Service.",
    fix: "Close and relaunch RouterChat then try again.",
    code: "api_auth_required",
  },
  missing: {
    icon: FileWarning,
    title: "Terms of Service missing",
    detail: "RouterChat can't run without its terms, and TOS.md couldn't be read.",
    fix: (
      <>
        Put <code className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.9em] text-neutral-100">TOS.md</code> back in the project root, then try again.
      </>
    ),
    code: "tos_missing",
  },
  offline: {
    icon: Unplug,
    title: "Can't reach RouterChat",
    detail: "The RouterChat backend isn't responding, so the Terms of Service couldn't load.",
    fix: "Make sure RouterChat is running, then try again.",
    code: "backend_unreachable",
  },
};

function checkedTime(failedAt) {
  return new Date(failedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function TosUnavailableScreen({ reason, onRetry, retrying, failedAt }) {
  const content = UNAVAILABLE_REASONS[reason] || UNAVAILABLE_REASONS.offline;
  const Icon = content.icon;

  return (
    <FullScreen>
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tos-unavailable-title"
        aria-describedby="tos-unavailable-detail"
        className="w-full max-w-md overflow-hidden rounded-3xl bg-panel [box-shadow:var(--shadow-surface)]"
      >
        <div className="px-6 pb-6 pt-7 sm:px-8 sm:pt-8">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-amber-400/[0.09] text-amber-300 ring-1 ring-inset ring-amber-300/15">
            <Icon className="h-[22px] w-[22px]" strokeWidth={1.75} aria-hidden="true" />
          </span>

          <h1
            id="tos-unavailable-title"
            className="mt-5 text-balance text-xl font-semibold tracking-[-0.01em] text-ink"
          >
            {content.title}
          </h1>

          <p id="tos-unavailable-detail" className="mt-2 text-pretty text-sm leading-6 text-muted">
            {content.detail}
          </p>

          <p className="mt-4 text-pretty text-sm font-medium leading-6 text-neutral-100">
            {content.fix}
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line bg-white/[0.015] px-6 py-4 sm:px-8">
          <p className="min-w-0 truncate text-xs text-neutral-400" aria-live="polite">
            {retrying ? (
              "Checking again"
            ) : failedAt ? (
              <span key={failedAt} className="tos-still-blocked">Still blocked at {checkedTime(failedAt)}</span>
            ) : (
              <span className="font-mono">{content.code}</span>
            )}
          </p>

          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className={cx(
              "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-white px-5 text-sm font-medium text-black",
              "hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-panel",
              "disabled:cursor-default disabled:bg-white/80",
              CONTROL_MOTION,
            )}
          >
            {retrying && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />}
            {retrying ? "Checking" : "Try again"}
          </button>
        </div>
      </section>
    </FullScreen>
  );
}

export function TosGateModal({ tos, onAccept, error }) {
  const [readToEnd, setReadToEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);

  const previous = tos.previous;
  const updated = Boolean(previous);

  //once theyve reached the bottom it stays satisfied, scrolling back up shouldnt take the button away again
  const checkScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;

    const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (remaining <= SCROLL_TOLERANCE) {
      setReadToEnd(true);
    }
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;

    //re-check on resize too, since a short document or a taller window means there is nothing to scroll
    const resizeObserver = new ResizeObserver(checkScroll);
    resizeObserver.observe(node);
    if (node.firstElementChild) resizeObserver.observe(node.firstElementChild);

    node.focus({ preventScroll: true }); //so page down and arrows work without clicking first
    checkScroll();

    return () => resizeObserver.disconnect();
  }, [checkScroll]);

  async function accept() {
    if (busy || !readToEnd) return;

    setBusy(true);
    try {
      await onAccept();
    } finally {
      setBusy(false);
    }
  }

  return (
    <FullScreen>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="tos-modal-title"
        className="flex max-h-[min(46rem,100%)] w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-panel [box-shadow:var(--shadow-surface)]"
      >
        {/*the document renders its own title and date just below, so this bar stays a bare label*/}
        <header className="shrink-0 border-b border-line px-8 py-4">
          <h1
            id="tos-modal-title"
            className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted"
          >
            Terms of Service
          </h1>
        </header>

        {updated && (
          <div className="shrink-0 border-b border-line bg-amber-500/[0.07] px-8 py-4">
            <div className="min-w-0 text-sm leading-6">
              <p className="font-medium text-amber-200">
                The terms have been updated. Please read and accept again.
              </p>
              <p className="mt-1 text-muted">
                You accepted the previous TOS on {versionLabel(previous.date, previous.hash)}.
              </p>
            </div>
          </div>
        )}

        <div
          ref={scrollRef}
          tabIndex={0}
          onScroll={checkScroll}
          aria-label="Terms of Service"
          className="min-h-0 flex-1 overflow-y-auto px-8 py-6 text-sm leading-7 text-neutral-300 outline-none"
        >
          <div>
            <ReactMarkdown components={TOS_MARKDOWN_COMPONENTS}>{tos.markdown || ""}</ReactMarkdown>
          </div>
        </div>

        <footer className="shrink-0 border-t border-line px-8 pb-7 pt-5">
          {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

          <button
            type="button"
            onClick={accept}
            disabled={!readToEnd || busy}
            className={cx(
              "w-full rounded-full bg-white px-6 py-3 text-sm font-medium text-black",
              "hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/[0.08] disabled:text-muted",
              CONTROL_MOTION,
            )}
          >
            I have read and agree to the Terms of Service
          </button>
        </footer>
      </section>
    </FullScreen>
  );
}
