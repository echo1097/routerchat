import { useState, useRef, useEffect } from "react";
import {
  historyRunGroups,
  historyCostTotal,
  historyWordTotals,
  historyRunPrompt,
  historyRunStoryModel,
  historyRunLoreModel,
  historyRunFailed,
  historyRunSteps,
  historyRunLore,
  historyTimeAgo,
} from "./historyFormatting.js";
import { createPortal } from "react-dom";
import { cx, PROMPT_BAR_CONTROL_MOTION } from "../uiShared.js";
import {
  X,
  ChevronDown,
  ChevronLeft,
  Check,
  Copy,
  Brain,
  PenLine,
  PencilRuler,
  TriangleAlert,
  BookOpen,
  Dot,
  MessageSquareText,
  Plus,
  Pencil,
  EyeOff,
} from "lucide-react";
import { formatInteger, formatCost } from "../textFormatting.js";

const STEP_ICONS = {
  prompt: MessageSquareText,
  thinking: Brain,
  write: PenLine,
  edit: PencilRuler,
  write_failed: TriangleAlert,
  lore_summary: BookOpen,
};

const LORE_GROUPS = [
  { kind: "Added", label: "Entries added", icon: Plus },
  { kind: "Updated", label: "Entries updated", icon: Pencil },
  { kind: "Excluded", label: "Entries excluded", icon: EyeOff },
];

export function WriteHistoryModal({ open, entries, title, onClose }) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [showPage, setShowPage] = useState(false);
  const closeRef = useRef(null);
  const pageRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      setSelectedRunId(null);
      setShowPage(false);
      requestAnimationFrame(() => closeRef.current?.focus());
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

  if (!rendered) return null;

  const isOpen = phase === "open";
  const runGroups = historyRunGroups(entries);
  const newestFirst = [...runGroups].reverse();
  const selectedRun =
    runGroups.find((run) => run.id === selectedRunId) ?? runGroups[runGroups.length - 1] ?? null;
  const totalCost = historyCostTotal(entries);
  const totalWords = historyWordTotals(entries);
  const now = Date.now();

  function selectRun(runId) {
    setSelectedRunId(runId);
    setShowPage(true);
    if (pageRef.current) pageRef.current.scrollTop = 0;
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center px-3 py-4 sm:px-4 sm:py-6">
      <button
        type="button"
        aria-label="Close history"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <section
        data-tour="write-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby="write-history-title"
        className={cx(
          "t-modal relative z-10 flex w-full flex-col overflow-hidden rounded-[26px] bg-[#181818] text-neutral-100 [box-shadow:var(--shadow-surface)]",
          selectedRun
            ? "h-[min(660px,calc(100dvh-2rem))] max-w-[940px]"
            : "max-h-[min(660px,calc(100dvh-2rem))] max-w-[720px]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-5 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <h2
              id="write-history-title"
              className="text-balance text-lg font-semibold leading-6 tracking-[-0.01em] text-neutral-100"
            >
              {title}
            </h2>
            {!selectedRun && (
              <p className="mt-0.5 text-[13px] leading-5 text-neutral-500">
                Prompts and changes will appear here
              </p>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className={cx(
              "grid h-8 w-8 shrink-0 place-items-center rounded-full bg-transparent text-neutral-400 hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
              PROMPT_BAR_CONTROL_MOTION,
            )}
            aria-label="Close history"
          >
            <X size={17} />
          </button>
        </header>

        {selectedRun ? (
          <div className="grid min-h-0 flex-1 border-t border-white/[0.07] sm:grid-cols-[290px_minmax(0,1fr)]">
            <div
              className={cx(
                "min-h-0 flex-col sm:flex sm:border-r sm:border-white/[0.07]",
                showPage ? "hidden" : "flex",
              )}
            >
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2.5" role="list">
                {newestFirst.map((run) => (
                  <WriteHistoryRunRow
                    key={run.id}
                    run={run}
                    now={now}
                    selected={run.id === selectedRun.id}
                    onSelect={() => selectRun(run.id)}
                  />
                ))}
              </div>
              <WriteHistoryTotals
                promptCount={runGroups.length}
                words={totalWords}
                cost={totalCost}
              />
            </div>

            <div
              ref={pageRef}
              className={cx(
                "min-h-0 overflow-y-auto px-5 pb-7 pt-4 sm:block sm:px-7 sm:pt-6",
                showPage ? "block" : "hidden",
              )}
            >
              <WriteHistoryRunPage
                key={selectedRun.id}
                run={selectedRun}
                onBack={() => setShowPage(false)}
              />
            </div>
          </div>
        ) : (
          <div className="px-4 pb-4 sm:px-5 sm:pb-5">
            <div className="rounded-[20px] bg-black/20 px-4 py-12 text-center">
              <div className="text-sm font-medium text-neutral-300">No history yet</div>
              <div className="mt-1 text-xs leading-5 text-neutral-500">
                Your next writing run will show up here.
              </div>
            </div>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}

function WriteHistoryRunRow({ run, now, selected, onSelect }) {
  const prompt = historyRunPrompt(run) || "Earlier activity";
  const words = historyWordTotals(run.actions);
  const failed = historyRunFailed(run);

  return (
    <button
      type="button"
      role="listitem"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cx(
        "flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-[background-color,scale] duration-150 ease-out active:scale-[0.985] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/20",
        selected ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
      )}
    >
      <span
        className={cx(
          "line-clamp-2 text-[13px] font-medium leading-[19px]",
          selected ? "text-neutral-100" : "text-neutral-300",
        )}
      >
        {prompt}
      </span>
      <span className="flex items-center justify-between gap-2 text-[11px] font-medium leading-4 text-neutral-500">
        <span>{historyTimeAgo(run.prompt.created_at, now)}</span>
        {failed && words.added === 0 && words.removed === 0 ? (
          <span className="text-amber-200/85">Failed</span>
        ) : (
          <WriteHistoryWords added={words.added} removed={words.removed} />
        )}
      </span>
    </button>
  );
}

function WriteHistoryTotals({ promptCount, words, cost }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-3.5 gap-y-0.5 border-t border-white/[0.07] px-4 py-3 text-xs tabular-nums text-neutral-500">
      <span>
        <span className="font-medium text-neutral-300">{formatInteger(promptCount)}</span>
        {promptCount === 1 ? " prompt" : " prompts"}
      </span>
      {(words.added > 0 || words.removed > 0) && (
        <WriteHistoryWords added={words.added} removed={words.removed} />
      )}
      {cost > 0 && <span className="font-medium text-neutral-300">{formatCost(cost)}</span>}
    </div>
  );
}

function WriteHistoryRunPage({ run, onBack }) {
  const prompt = historyRunPrompt(run);
  const storyModel = historyRunStoryModel(run);
  const loreModel = historyRunLoreModel(run);
  const steps = historyRunSteps(run);
  const lore = historyRunLore(run);
  const words = historyWordTotals(run.actions);
  const cost = historyCostTotal(run.actions);
  const hasWords = words.added > 0 || words.removed > 0;

  return (
    <div className="t-history-page mx-auto flex max-w-[560px] flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className={cx(
          "inline-flex h-[30px] items-center gap-1.5 self-start rounded-full bg-white/[0.04] pl-2 pr-3 text-xs font-medium text-neutral-300 hover:bg-white/[0.07] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 sm:hidden",
          PROMPT_BAR_CONTROL_MOTION,
        )}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        All prompts
      </button>

      {(hasWords || cost > 0 || lore) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {hasWords && (
            <WriteHistoryPill>
              <WriteHistoryWords added={words.added} removed={words.removed} />
              <span>words</span>
            </WriteHistoryPill>
          )}
          {cost > 0 && (
            <WriteHistoryPill>
              <span className="text-neutral-100">{formatCost(cost)}</span>
              <span>cost</span>
            </WriteHistoryPill>
          )}
          {lore && (
            <WriteHistoryPill>
              <span className="text-neutral-100">{formatInteger(lore.changes.length)}</span>
              <span>{lore.changes.length === 1 ? "lorebook change" : "lorebook changes"}</span>
            </WriteHistoryPill>
          )}
        </div>
      )}

      <div>
        <h3 className="mb-2 text-[13px] font-semibold text-neutral-300">User actions</h3>
        <ol className="overflow-hidden rounded-2xl shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
          <WriteHistoryStep step={{ id: "prompt", kind: "prompt", label: "Prompt", detail: prompt }} />
        </ol>
      </div>

      {steps.length > 0 && (
        <div>
          <WriteHistorySectionTitle title="Story changes" model={storyModel} />
          <ol className="divide-y divide-white/[0.07] overflow-hidden rounded-2xl shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            {steps.map((step) => (
              <WriteHistoryStep key={step.id} step={step} />
            ))}
          </ol>
        </div>
      )}

      {lore && (
        <div>
          <WriteHistorySectionTitle title="Lorebook changes" model={loreModel} />
          <ul className="divide-y divide-white/[0.07] overflow-hidden rounded-2xl shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            {LORE_GROUPS.map((group) => {
              const changes = lore.changes.filter((change) => change.kind === group.kind);
              if (changes.length === 0) return null;
              return <WriteHistoryLoreGroup key={group.kind} group={group} changes={changes} />;
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function WriteHistorySectionTitle({ title, model }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      <h3 className="text-[13px] font-semibold text-neutral-300">{title}</h3>
      {model && (
        <WriteHistoryPill>
          <span className="text-neutral-300">{model}</span>
        </WriteHistoryPill>
      )}
    </div>
  );
}

function WriteHistoryLoreGroup({ group, changes }) {
  const [open, setOpen] = useState(false);
  const Icon = group.icon;
  const excluded = group.kind === "Excluded";
  const words = changes.reduce(
    (totals, change) => ({
      added: totals.added + (excluded ? 0 : change.added),
      removed: totals.removed + change.removed,
    }),
    { added: 0, removed: 0 },
  );

  return (
    <li className="t-tree" data-open={String(open)}>
      <div className="t-tree-row">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="grid w-full grid-cols-[18px_minmax(0,1fr)_auto_auto] items-center gap-3 px-3.5 py-2.5 text-left text-[13px] font-medium text-neutral-300 transition-colors duration-150 ease-out hover:bg-white/[0.04] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/20"
        >
          <Icon size={15} strokeWidth={1.8} aria-hidden="true" className="text-neutral-500" />
          <span className="truncate">
            {group.label}
            <span className="ml-1.5 tabular-nums text-neutral-500">{formatInteger(changes.length)}</span>
          </span>
          <WriteHistoryWords added={words.added} removed={words.removed} muted={excluded} />
          <span className="t-tree-chevron text-neutral-500">
            <ChevronDown size={15} strokeWidth={1.8} aria-hidden="true" />
          </span>
        </button>
      </div>
      <div className="t-tree-panel">
        <div className="t-tree-panel-inner">
          <ul className="pb-2 pl-[44px] pr-[42px]">
            {changes.map((change) => (
              <li
                key={change.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1.5 text-[13px]"
              >
                <span
                  className={cx(
                    "truncate",
                    excluded ? "text-neutral-500 line-through decoration-white/25" : "text-neutral-400",
                  )}
                >
                  {change.name}
                </span>
                <WriteHistoryWords
                  added={excluded ? 0 : change.added}
                  removed={change.removed}
                  muted={excluded}
                />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </li>
  );
}

function WriteHistoryStep({ step }) {
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICONS[step.kind] ?? Dot;
  const failed = step.kind === "write_failed";
  const expandable = step.kind === "thinking" || step.kind === "prompt";
  const copyName = step.kind === "prompt" ? "prompt" : "thinking";

  const iconNode = (
    <Icon
      size={15}
      strokeWidth={1.8}
      aria-hidden="true"
      className={failed ? "text-amber-200" : "text-neutral-500"}
    />
  );

  if (expandable) {
    return (
      <li className="t-tree" data-open={String(open)}>
        <div className="t-tree-row">
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            className="grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2.5 text-left text-[13px] font-medium text-neutral-300 transition-colors duration-150 ease-out hover:bg-white/[0.04] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/20"
          >
            {iconNode}
            <span className="truncate">{step.label}</span>
            <span className="t-tree-chevron text-neutral-500">
              <ChevronDown size={15} strokeWidth={1.8} aria-hidden="true" />
            </span>
          </button>
        </div>
        <div className="t-tree-panel">
          <div className="t-tree-panel-inner">
            <div className="flex items-start gap-1 pb-3.5 pl-[44px] pr-3.5">
              <div
                className={cx(
                  "max-h-[320px] min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-pretty text-[13px] leading-[21px]",
                  step.detail ? "cursor-text select-text text-neutral-400" : "text-neutral-600",
                )}
              >
                {step.detail || `No ${copyName} saved`}
              </div>
              {step.detail && <WriteHistoryCopyButton text={step.detail} copyName={copyName} />}
            </div>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-3 px-3.5 py-2.5 text-[13px]">
      {iconNode}
      <span className={cx("font-medium", failed ? "text-amber-200" : "text-neutral-300")}>
        {step.label}
      </span>
      <WriteHistoryWords added={step.added} removed={step.removed} />
      {step.detail && (
        <span className="col-start-2 col-end-4 whitespace-pre-wrap text-pretty text-xs leading-[18px] text-neutral-500">
          {step.detail}
        </span>
      )}
    </li>
  );
}

function WriteHistoryPill({ children }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-white/[0.05] px-2.5 text-[11px] font-medium tabular-nums text-neutral-500">
      {children}
    </span>
  );
}

function WriteHistoryWords({ added, removed, large = false, muted = false }) {
  if (!added && !removed) return <span />;

  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 tabular-nums",
        large ? "text-[15px] font-semibold" : "text-[11px] font-medium",
      )}
    >
      {added > 0 && <span className="text-emerald-300">+{formatInteger(added)}</span>}
      {removed > 0 && (
        <span className={muted ? "text-neutral-500" : "text-red-300"}>
          &minus;{formatInteger(removed)}
        </span>
      )}
    </span>
  );
}

function WriteHistoryCopyButton({ text, copyName }) {
  const [copyState, setCopyState] = useState("idle");
  const timeoutRef = useRef(null);
  const copyingRef = useRef(false);

  useEffect(
    () => () => window.clearTimeout(timeoutRef.current),
    [],
  );

  async function copyText() {
    if (!text || copyingRef.current) return;

    copyingRef.current = true;
    window.clearTimeout(timeoutRef.current);
    setCopyState("copying");

    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    } finally {
      copyingRef.current = false;
    }

    timeoutRef.current = window.setTimeout(() => setCopyState("idle"), 2400);
  }

  const copied = copyState === "copied";
  const statusText = copied
    ? `${copyName === "thinking" ? "Thinking" : "Prompt"} copied to clipboard.`
    : copyState === "failed"
      ? "Couldn’t copy. Try again."
      : "";

  return (
    <div className="inline-flex shrink-0 items-center">
      <button
        type="button"
        onClick={copyText}
        disabled={copyState === "copying"}
        aria-label={`Copy ${copyName}`}
        className={cx(
          "inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-white/[0.07] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-wait",
          PROMPT_BAR_CONTROL_MOTION,
        )}
      >
        {copied ? (
          <Check size={13} className="text-emerald-300" aria-hidden="true" />
        ) : (
          <Copy size={13} aria-hidden="true" />
        )}
      </button>
      <span role="status" className={copyState === "failed" ? "ml-2 text-xs text-amber-200" : "sr-only"}>
        {statusText}
      </span>
    </div>
  );
}
