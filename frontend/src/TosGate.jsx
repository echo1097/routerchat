import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { FileWarning, Loader2 } from "lucide-react";

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

export function TosUnavailableScreen({ message, onRetry, retrying }) {
  return (
    <FullScreen>
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tos-unavailable-title"
        className="w-full max-w-lg rounded-3xl bg-panel p-8 [box-shadow:var(--shadow-surface)]"
      >
        <div className="flex items-start gap-4">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-500/10 text-amber-400">
            <FileWarning className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 id="tos-unavailable-title" className="text-lg font-semibold">
              Terms of Service unavailable
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted">
              {message ||
                "TOS.md could not be read. Restore it from the repository to use RouterChat."}
            </p>
            <p className="mt-3 text-sm leading-6 text-muted">
              RouterChat cannot run without its terms. Put <code className="rounded bg-white/[0.07] px-1.5 py-0.5 text-[0.92em] text-neutral-100">TOS.md</code>{" "}
              back in the project root and try again.
            </p>
          </div>
        </div>

        <div className="mt-8 flex justify-end">
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className={cx(
              "rounded-full bg-white/[0.06] px-5 py-2.5 text-sm font-medium text-ink",
              "hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-50",
              CONTROL_MOTION,
            )}
          >
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
