import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { FileWarning, Loader2, LockKeyhole, Unplug } from "lucide-react";

import { cx, CONTROL_MOTION } from "./uiShared.js";
import { MARKDOWN_IMAGE_COMPONENT } from "./markdownImage.jsx";

const SCROLL_TOLERANCE = 4;
const SECTION_OFFSET = 24;


function textOf(children) {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement(child)) return textOf(child.props.children);
      return "";
    })
    .join("");
}


function sectionId(title) {
  return `tos-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}


function splitSectionTitle(title) {
  const match = title.match(/^(\d+)\.\s+(.*)$/);
  if (!match) return { number: "", label: title };
  return { number: match[1], label: match[2] };
}


function isShouting(text) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length > 60 && letters === letters.toUpperCase();
}


function isLoneStrong(node) {
  const children = (node?.children || []).filter(
    (child) => !(child.type === "text" && !child.value.trim()),
  );
  return children.length === 1 && children[0].tagName === "strong";
}


function splitDocument(markdown, date) {
  let body = markdown || "";
  let title = "";

  const titleMatch = body.match(/^\s*#\s+(.+?)\s*$/m);
  if (titleMatch && body.trimStart().startsWith("#") && !body.trimStart().startsWith("##")) {
    title = titleMatch[1];
    body = body.replace(titleMatch[0], "");
  }

  if (date) {
    body = body.replace(/^\*\*Last updated:\s*.+?\s*\*\*\s*$/m, "");
  }

  body = body.replace(/^\s*(---\s*)?/, "");

  const sections = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => {
    const text = match[1].replace(/[*_`]/g, "");
    return { id: sectionId(text), ...splitSectionTitle(text) };
  });

  return { title, body, sections };
}


const TOS_MARKDOWN_COMPONENTS = {
  ...MARKDOWN_IMAGE_COMPONENT,
  h1: ({ node, ...props }) => (
    <h2 className="mb-3 mt-12 text-[19px] font-semibold tracking-[-0.01em] text-ink first:mt-0" {...props} />
  ),
  h2: ({ node, children, ...props }) => {
    const text = textOf(children);
    const { number, label } = splitSectionTitle(text);

    return (
      <h2
        id={sectionId(text)}
        className="mb-4 mt-14 flex scroll-mt-6 items-baseline gap-2.5 text-[18px] font-semibold tracking-[-0.012em] text-ink first:mt-0"
        {...props}
      >
        {number && (
          <span className="shrink-0 tabular-nums text-neutral-500">{number}</span>
        )}
        <span className="text-balance">{label}</span>
      </h2>
    );
  },
  h3: ({ node, ...props }) => (
    <h3 className="mb-2 mt-8 text-[15px] font-semibold text-neutral-100" {...props} />
  ),
  p: ({ node, children, ...props }) => {
    if (isLoneStrong(node)) {
      return (
        <p className="mb-2 mt-8 text-[15px] font-semibold text-neutral-100 [&_strong]:font-semibold" {...props}>
          {children}
        </p>
      );
    }

    if (isShouting(textOf(children))) {
      return (
        <p className="mb-5 text-pretty text-[13px] leading-[22px] tracking-[0.015em] text-neutral-400 last:mb-0" {...props}>
          {children}
        </p>
      );
    }

    return <p className="mb-5 text-pretty last:mb-0" {...props}>{children}</p>;
  },
  strong: ({ node, ...props }) => <strong className="font-semibold text-neutral-100" {...props} />,
  a: ({ node, ...props }) => (
    <a
      className="text-neutral-100 underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  ul: ({ node, ...props }) => (
    <ul className="mb-5 space-y-2.5 pl-5 marker:text-neutral-600 [list-style:disc]" {...props} />
  ),
  ol: ({ node, ...props }) => (
    <ol className="mb-5 list-decimal space-y-2.5 pl-5 marker:text-neutral-500" {...props} />
  ),
  li: ({ node, ...props }) => <li className="text-pretty pl-1 [&>ul]:mb-0 [&>ul]:mt-2.5" {...props} />,
  hr: ({ node, ...props }) => <hr className="my-12 border-0 border-t border-white/[0.07]" {...props} />,
  code: ({ node, ...props }) => (
    <code
      className="break-words rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.86em] text-neutral-200"
      {...props}
    />
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
  const [activeSection, setActiveSection] = useState("");
  const scrollRef = useRef(null);
  const progressRef = useRef(null);
  const atBottomRef = useRef(false);

  const previous = tos.previous;
  const updated = Boolean(previous);
  const { title, body, sections } = useMemo(() => splitDocument(tos.markdown, tos.date), [tos.markdown, tos.date]);

  const checkScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;

    const scrollable = node.scrollHeight - node.clientHeight;
    const remaining = scrollable - node.scrollTop;
    const progress = scrollable <= SCROLL_TOLERANCE ? 1 : Math.min(1, node.scrollTop / scrollable);

    if (progressRef.current) {
      progressRef.current.style.transform = `scaleX(${progress})`;
    }

    atBottomRef.current = remaining <= SCROLL_TOLERANCE;
    if (remaining <= SCROLL_TOLERANCE) {
      setReadToEnd(true);
    }

    const top = node.getBoundingClientRect().top + SECTION_OFFSET + 8;
    let current = "";
    for (const section of sections) {
      const heading = document.getElementById(section.id);
      if (heading && heading.getBoundingClientRect().top <= top) current = section.id;
    }
    if (remaining <= SCROLL_TOLERANCE && sections.length) current = sections[sections.length - 1].id;

    setActiveSection((existing) => (existing === current ? existing : current));
  }, [sections]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;

    const keepBottom = () => {
      if (atBottomRef.current) node.scrollTop = node.scrollHeight;
      checkScroll();
    };

    const resizeObserver = new ResizeObserver(keepBottom);
    resizeObserver.observe(node);
    if (node.firstElementChild) resizeObserver.observe(node.firstElementChild);

    node.focus({ preventScroll: true });
    checkScroll();

    return () => resizeObserver.disconnect();
  }, [checkScroll]);

  function jumpTo(id) {
    const node = scrollRef.current;
    const heading = document.getElementById(id);
    if (!node || !heading) return;

    const offset = heading.getBoundingClientRect().top - node.getBoundingClientRect().top;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollTo({ top: node.scrollTop + offset - SECTION_OFFSET, behavior: reduceMotion ? "auto" : "smooth" });
  }

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
        aria-describedby="tos-modal-status"
        className="tos-enter flex h-full max-h-[min(54rem,100%)] w-full max-w-3xl flex-col overflow-hidden rounded-[26px] bg-[#181818] lg:max-w-[68rem]"
      >
        <header className="relative shrink-0 px-5 pb-4 pt-5 sm:px-8 sm:pb-5 sm:pt-7">
          <h1
            id="tos-modal-title"
            className="text-balance text-[19px] font-[650] leading-[1.2] tracking-[-0.012em] text-ink sm:text-[22px] sm:leading-[1.15]"
          >
            {title || "Terms of Service"}
          </h1>

          <div className="mt-2 flex flex-col items-start gap-x-3 gap-y-1.5 text-[13px] text-neutral-400 sm:mt-2.5 sm:flex-row sm:flex-wrap sm:items-center">
            {tos.date && <span>Last updated {tos.date}</span>}

            {updated && (
              <span className="inline-flex items-baseline gap-2 text-[12.5px] font-medium text-amber-100/90 sm:items-center sm:rounded-full sm:bg-amber-200/[0.09] sm:py-1 sm:pl-2.5 sm:pr-3 sm:text-[12px]">
                <span className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-amber-200/80 sm:translate-y-0" aria-hidden="true" />
                Changed since you accepted on {versionLabel(previous.date, previous.hash)}
              </span>
            )}
          </div>

          <div className="absolute inset-x-0 bottom-0 h-px bg-white/[0.07]" aria-hidden="true">
            <div
              ref={progressRef}
              className="tos-progress h-full origin-left bg-white/55"
              style={{ transform: "scaleX(0)" }}
            />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {sections.length > 1 && (
            <nav
              aria-label="Sections"
              className="tos-rail hidden w-60 shrink-0 overflow-y-auto border-r border-white/[0.07] px-3 py-5 lg:block"
            >
              <ul className="space-y-0.5">
                {sections.map((section) => {
                  const active = section.id === activeSection;

                  return (
                    <li key={section.id}>
                      <button
                        type="button"
                        onClick={() => jumpTo(section.id)}
                        aria-current={active ? "location" : undefined}
                        className={cx(
                          "flex w-full items-baseline gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] leading-[1.35]",
                          "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                          active
                            ? "bg-white/[0.07] font-medium text-ink"
                            : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200",
                          CONTROL_MOTION,
                        )}
                      >
                        <span
                          className={cx(
                            "w-4 shrink-0 text-right text-[12px] tabular-nums",
                            active ? "text-neutral-400" : "text-neutral-600",
                          )}
                        >
                          {section.number}
                        </span>
                        <span className="min-w-0">{section.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}

          <div
            ref={scrollRef}
            tabIndex={0}
            onScroll={checkScroll}
            aria-label="Terms of Service"
            className="tos-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-12 pt-7 text-[15px] leading-[26px] text-neutral-300 outline-none sm:px-10 sm:pt-8"
          >
            <div className="mx-auto max-w-[66ch]">
              <ReactMarkdown components={TOS_MARKDOWN_COMPONENTS}>{body}</ReactMarkdown>
            </div>
          </div>
        </div>

        <p id="tos-modal-status" aria-live="polite" className="sr-only">
          {readToEnd ? "You've reached the end" : "Read to the end to continue"}
        </p>

        <div className={cx("tos-footer grid shrink-0", readToEnd && "is-open")} aria-hidden={!readToEnd}>
          <div className="min-h-0 overflow-hidden">
            <footer className="tos-footer-inner border-t border-white/[0.07] px-5 py-2.5 sm:px-8 sm:py-3">
              {error && (
                <p
                  role="alert"
                  className="mx-auto mb-2.5 w-fit max-w-full rounded-2xl bg-red-500/[0.14] px-4 py-2 text-center text-[13px] leading-5 text-red-200"
                >
                  {error}
                </p>
              )}

              <div className="flex items-center justify-center">
                <button
                  type="button"
                  onClick={accept}
                  disabled={!readToEnd || busy}
                  className={cx(
                    "inline-flex h-10 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold sm:w-auto",
                    "bg-[#f5f5f5] text-[#0a0a0a] hover:bg-white",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#181818]",
                    "disabled:cursor-wait disabled:opacity-80 disabled:active:scale-100",
                    CONTROL_MOTION,
                  )}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />}
                  I have read and agree to these terms
                </button>
              </div>
            </footer>
          </div>
        </div>
      </section>
    </FullScreen>
  );
}
