import { useState, useRef, useEffect } from "react";
import {
  historyRunGroups,
  isPromptEntry,
  historyCostTotal,
  historyWordTotals,
  historyRunRows,
  historyRowChildren,
  historyRowText,
  historyRowWords,
  historyRowLabel,
} from "./historyFormatting.js";
import { createPortal } from "react-dom";
import { cx, PROMPT_BAR_CONTROL_MOTION } from "../uiShared.js";
import { X, ChevronDown, Check, Copy } from "lucide-react";
import { formatInteger, formatCost } from "../textFormatting.js";

export function WriteHistoryModal({ open, entries, title, onClose }) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [expandedEntries, setExpandedEntries] = useState({});
  const [openRuns, setOpenRuns] = useState({});
  const closeRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
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
  const eventCount = entries.filter((entry) => !isPromptEntry(entry)).length;
  const totalCost = historyCostTotal(entries);
  const totalWords = historyWordTotals(entries);
  const lastRunId = runGroups.length > 0 ? runGroups[runGroups.length - 1].id : null;

  function toggleExpanded(entryId) {
    setExpandedEntries((current) => ({
      ...current,
      [entryId]: !current[entryId],
    }));
  }

  function toggleRun(runId) {
    setOpenRuns((current) => ({
      ...current,
      [runId]: !(current[runId] ?? runId === lastRunId),
    }));
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
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
          "t-modal relative z-10 flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-[720px] flex-col overflow-hidden rounded-[26px] bg-[#191919] text-neutral-100 [box-shadow:var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <header className="shrink-0 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="flex items-start justify-between gap-5">
            <h2
              id="write-history-title"
              className="min-w-0 text-balance text-lg font-semibold leading-6 tracking-[-0.01em] text-neutral-100"
            >
              {title}
            </h2>
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
          </div>

          {eventCount === 0 && (
            <p className="mt-1 text-sm leading-5 text-neutral-500">
              Prompts and changes will appear here
            </p>
          )}
        </header>

        {}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 sm:px-4 sm:pb-4">
          {runGroups.length > 0 ? (
            <div className="space-y-2.5">
              {runGroups.map((run, index) => (
                <WriteHistoryRunAccordion
                  key={run.id}
                  run={run}
                  index={index}
                  open={openRuns[run.id] ?? run.id === lastRunId}
                  onToggle={() => toggleRun(run.id)}
                  expandedEntries={expandedEntries}
                  onToggleEntry={toggleExpanded}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-[20px] bg-black/20 px-4 py-12 text-center shadow-[var(--shadow-border)]">
              <div className="text-sm font-medium text-neutral-300">No history yet</div>
              <div className="mt-1 text-xs leading-5 text-neutral-600">
                Your next writing run will show up here.
              </div>
            </div>
          )}
        </div>

        {eventCount > 0 && (
          <footer className="shrink-0 border-t border-white/[0.06] px-5 py-3.5 sm:px-6">
            {}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] leading-5 tabular-nums text-neutral-400">
              <WriteHistoryTotal
                value={formatInteger(runGroups.length)}
                label={runGroups.length === 1 ? "prompt" : "prompts"}
              />
              <WriteHistoryTotal
                value={formatInteger(eventCount)}
                label={eventCount === 1 ? "action" : "actions"}
              />
              {(totalWords.added > 0 || totalWords.removed > 0) && (
                <span className="flex items-center">
                  {totalWords.added > 0 && (
                    <span className="text-emerald-300">+{formatInteger(totalWords.added)}</span>
                  )}
                  {totalWords.added > 0 && totalWords.removed > 0 && (
                    <span className="px-1 text-neutral-700">/</span>
                  )}
                  {totalWords.removed > 0 && (
                    <span className="text-red-300">&minus;{formatInteger(totalWords.removed)}</span>
                  )}
                  <span className="ml-1.5 text-neutral-500">words</span>
                </span>
              )}
              {totalCost > 0 && (
                <span className="text-neutral-200">{formatCost(totalCost)}</span>
              )}
            </div>
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}

function WriteHistoryTotal({ label, value }) {
  return (
    <span>
      <span className="font-medium text-neutral-200">{value}</span>
      <span className="ml-1.5 text-neutral-500">{label}</span>
    </span>
  );
}

function WriteHistoryRunAccordion({
  run,
  index,
  open,
  onToggle,
  expandedEntries,
  onToggleEntry,
}) {
  const actionCount = run.actions.length;
  const activityRows = historyRunRows(run);
  const runCost = historyCostTotal(run.actions);
  const runWords = historyWordTotals(run.actions);

  return (
    <section
      className="t-acc overflow-hidden rounded-[20px] bg-black/20 shadow-[var(--shadow-border)]"
      data-open={String(open)}
    >
      {}
      <button
        type="button"
        className="t-acc-head group flex w-full items-center justify-between gap-4 rounded-[20px] py-3 pl-3.5 pr-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/20 sm:pl-4 sm:pr-3"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="min-w-0">
          <span className="-ml-1.5 inline-block rounded-lg px-1.5 text-sm font-semibold leading-5 text-neutral-100 transition-colors duration-150 ease-out group-hover:bg-white/[0.06]">
            Prompt {index + 1}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-medium leading-4 tabular-nums text-neutral-600">
            <span>
              {actionCount} {actionCount === 1 ? "action" : "actions"}
            </span>
            {runWords.added > 0 && <span className="text-emerald-300/80">+{formatInteger(runWords.added)}</span>}
            {runWords.removed > 0 && <span className="text-red-300/80">&minus;{formatInteger(runWords.removed)}</span>}
            {runCost > 0 && <span>{formatCost(runCost)}</span>}
          </span>
        </span>
        <span className="t-acc-chevron grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-500">
          <ChevronDown size={17} strokeWidth={1.8} aria-hidden="true" />
        </span>
      </button>

      <div className="t-acc-panel min-h-0">
        <div className="t-acc-panel-inner min-h-0 px-3.5 pb-4 sm:px-4">
          {activityRows.length > 0 ? (
            <WriteHistoryActivity
              rows={activityRows}
              expandedEntries={expandedEntries}
              onToggleEntry={onToggleEntry}
            />
          ) : (
            <div className="px-1 text-xs leading-5 text-neutral-600">
              No actions recorded for this prompt.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const HISTORY_DEPTH_TEXT = [
  "text-sm font-medium leading-5 text-neutral-300",
  "text-[13px] font-medium leading-5 text-neutral-400",
  "text-[13px] font-normal leading-5 text-neutral-500",
];

function WriteHistoryActivity({ rows, expandedEntries, onToggleEntry }) {
  return (
    <WriteHistoryRows
      rows={rows}
      guides={[]}
      parentFinal
      expandedEntries={expandedEntries}
      onToggleEntry={onToggleEntry}
    />
  );
}

function WriteHistoryRows({ rows, guides, parentFinal, expandedEntries, onToggleEntry }) {
  return (
    <ol className={guides.length === 0 ? "px-1" : undefined}>
      {rows.map((row, index) => {
        const lastSibling = index === rows.length - 1;
        const children = historyRowChildren(row);
        const expandable = children.length > 0 || Boolean(historyRowText(row));
        const open = Boolean(expandedEntries[row.id]);
        const expanded = expandable && open;

        return (
          <WriteHistoryAction
            key={row.id}
            row={row}
            guides={guides}
            expandable={expandable}
            open={open}

            final={parentFinal && lastSibling && !expanded}
            onToggle={() => onToggleEntry(row.id)}
          >
            {children.length > 0 && (
              <WriteHistoryRows
                rows={children}

                guides={[...guides, !lastSibling]}
                parentFinal={parentFinal && lastSibling}
                expandedEntries={expandedEntries}
                onToggleEntry={onToggleEntry}
              />
            )}
          </WriteHistoryAction>
        );
      })}
    </ol>
  );
}

function WriteHistoryAction({
  row,
  guides,
  expandable,
  open,
  final,
  onToggle,
  children,
}) {

  const expanded = expandable && open;
  const entry = row.entries[0];
  const words = historyRowWords(row);
  const depth = guides.length;
  const textPanel = historyRowText(row);

  const failed = entry.kind === "write_failed";
  const textClass = HISTORY_DEPTH_TEXT[Math.min(depth, HISTORY_DEPTH_TEXT.length - 1)];

  return (
    <li className="t-tree" data-open={String(expanded)}>
      <div className="t-tree-row grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4">
        {}
        <div className="flex min-w-0">
          {}
          {guides.slice(1).map((drawn, level) => (
            <WriteHistoryGuide key={level} drawn={drawn} />
          ))}
          {depth > 0 && <WriteHistoryGuide drawn />}

          <div className={cx("min-w-0 flex-1", final ? "pb-0" : "pb-2.5")}>
            {expandable ? (
              <div className={cx("flex min-w-0 items-center gap-1", textClass)}>
                <button
                  type="button"
                  onClick={onToggle}
                  aria-expanded={expanded}
                  className={cx(
                    "-ml-1.5 flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-1.5 text-left transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                    textClass,
                  )}
                >
                  <span className="truncate">{historyRowLabel(row)}</span>
                  <span className="t-tree-chevron shrink-0 text-neutral-600">
                    <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
                  </span>
                </button>
                {textPanel?.text && (
                  <WriteHistoryCopyButton
                    text={textPanel.text}
                    copyName={textPanel.kind === "thinking" ? "thinking" : "prompt"}
                  />
                )}
              </div>
            ) : (
              <div className={cx("text-pretty", textClass, failed && "text-amber-200")}>
                {historyRowLabel(row)}
              </div>
            )}

            {!expandable && <WriteHistoryDetail entry={entry} />}
          </div>
        </div>

        <WriteHistoryStats
          added={words.added}
          removed={words.removed}
          isHide={entry.kind === "lore_hide"}
        />
      </div>

      {expandable && (
        <div className="t-tree-panel">
          <div className="t-tree-panel-inner">
            {textPanel ? (
              <WriteHistoryTextPanel
                text={textPanel.text}
                emptyLabel={
                  textPanel.kind === "thinking" ? "No thinking saved" : "No prompt saved"
                }
              />
            ) : (
              children
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function WriteHistoryGuide({ drawn }) {
  return (
    <span className="relative w-[18px] shrink-0" aria-hidden="true">
      {drawn && <span className="absolute inset-y-0 left-[5px] w-[2px] bg-white/[0.09]" />}
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

  return (
    <div className="inline-flex shrink-0 items-center">
      <button
        type="button"
        onClick={copyText}
        disabled={copyState === "copying"}
        aria-label={`Copy ${copyName}`}
        className="inline-flex h-5 w-5 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/[0.07] hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-wait"
      >
        {copyState === "copied" ? <Check size="1em" className="text-emerald-300" aria-hidden="true" /> : <Copy size="1em" aria-hidden="true" />}
      </button>
      <span role="status" className={copyState === "failed" ? "ml-1 text-xs text-amber-200" : "sr-only"}>
        {copyState === "copied" && `${copyName === "thinking" ? "Thinking" : "Prompt"} copied to clipboard.`}
        {copyState === "failed" && "Couldn’t copy. Try again."}
      </span>
    </div>
  );
}

function WriteHistoryTextPanel({ text, emptyLabel }) {
  return (
    <div className="mb-2.5 flex">
      <WriteHistoryGuide drawn />
      <div className={cx(
        "min-w-0 max-h-[320px] flex-1 overflow-y-auto whitespace-pre-wrap break-words text-pretty text-[13px] leading-5",
        text ? "cursor-text select-text text-neutral-300" : "text-neutral-600",
      )}>
        {text || emptyLabel}
      </div>
    </div>
  );
}

function WriteHistoryStats({ added, removed, isHide = false }) {
  if (!added && !removed) return null;

  return (
    <span className="flex shrink-0 items-center gap-2 self-start text-[11px] font-medium leading-5 tabular-nums">
      {added > 0 && !isHide && <span className="text-emerald-300">+{added}</span>}
      {removed > 0 && (
        <span className={isHide ? "text-neutral-500" : "text-red-300"}>&minus;{removed}</span>
      )}
    </span>
  );
}

function WriteHistoryDetail({ entry }) {
  if (!entry.detail) return null;

  return (
    <div className="text-pretty text-xs leading-5 text-neutral-500">{entry.detail}</div>
  );
}
