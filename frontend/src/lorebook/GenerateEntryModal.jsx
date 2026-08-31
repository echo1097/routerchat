import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import ThinkingContent from "../ThinkingContent.jsx";
import { useRafScroller } from "../streamScroll.js";
import { useTextSwap } from "../textSwap.js";
import { cx, CONTROL_MOTION } from "../uiShared.js";

//the model writes JSON, so the half finished string has to be unpicked by hand to read as prose
function decodeJsonFragment(fragment) {
  const balanced = fragment.endsWith("\\") ? fragment.slice(0, -1) : fragment;

  try {
    return JSON.parse(`"${balanced}"`);
  } catch {
    return balanced.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

/* the entry arrives as one growing JSON blob, and what the author wants to watch is the name and the
description filling in, so both fields are pulled out of it mid flight, closing quote or not */
function previewFromStream(rawText) {
  const nameMatch = rawText.match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)/);
  const descriptionMatch = rawText.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)/);

  return {
    name: decodeJsonFragment(nameMatch?.[1] || ""),
    description: decodeJsonFragment(descriptionMatch?.[1] || ""),
  };
}

const BRIEF_PLACEHOLDERS = {
  character: "Describe the character",
  location: "Describe the location",
  item: "Describe the item",
  event: "Describe the event",
  note: "Describe the note",
};

export default function GenerateEntryModal({
  open,
  category,
  categoryLabel,
  chapters = [],
  activeChapterId = null,
  onClose,
  onGenerate,
  onApply,
}) {
  const [rendered, setRendered] = useState(open);
  const [modalState, setModalState] = useState(open ? "open" : "closed");
  const [stage, setStage] = useState("prompt");
  const [phase, setPhase] = useState("thinking");
  const [brief, setBrief] = useState("");
  const [selectedChapterId, setSelectedChapterId] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [streamedText, setStreamedText] = useState("");
  const [error, setError] = useState("");
  const [bodyHeight, setBodyHeight] = useState(null);
  const bodyInnerRef = useRef(null);
  const reasoningRef = useRef(null);
  const {
    markUserScroll: markReasoningScroll,
    markWheelIntent: markReasoningWheelIntent,
    markTouchStart: markReasoningTouchStart,
    markTouchMove: markReasoningTouchMove,
    scrollToBottom: scrollReasoningToBottom,
    startFollowing: startFollowingReasoning,
  } = useRafScroller(reasoningRef, 32);

  const isRunning = stage === "running";
  const titleId = "lorebook-generate-title";
  const descriptionId = "lorebook-generate-description";
  const isSynopsis = category === "synopsis";
  const eligibleChapters = useMemo(
    () => chapters.filter((chapter) => !chapter.disabled && String(chapter.content || "").trim()),
    [chapters],
  );

  useEffect(() => {
    if (open) {
      setRendered(true);
      requestAnimationFrame(() => setModalState("open"));
      return undefined;
    }

    if (!rendered) return undefined;

    setModalState("closing");
    const closeMs = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--modal-close-dur"),
    ) || 150;
    const timeoutId = window.setTimeout(() => {
      setRendered(false);
      setModalState("closed");
      setBodyHeight(null); //the next open measures fresh instead of tweening from the old stage
    }, closeMs);

    return () => window.clearTimeout(timeoutId);
  }, [open, rendered]);

  //a fresh open is a fresh brief, the last run's thinking has nothing to do with this one
  useEffect(() => {
    if (!open) return;

    setStage("prompt");
    setPhase("thinking");
    setReasoning("");
    setStreamedText("");
    setError("");
    if (isSynopsis) {
      const activeEligible = eligibleChapters.some((chapter) => chapter.id === activeChapterId);
      setSelectedChapterId(activeEligible ? activeChapterId : eligibleChapters[0]?.id || "");
    }
  }, [activeChapterId, eligibleChapters, isSynopsis, open]);

  //the body owns the size change between stages, so pin it to whatever the current stage measures
  useLayoutEffect(() => {
    const inner = bodyInnerRef.current;
    if (!inner) return undefined;

    function syncBodyHeight() {
      setBodyHeight(inner.offsetHeight); //offsetHeight, not a rect, the modal is mid scale transform while it opens
    }

    syncBodyHeight();

    const observer = new ResizeObserver(syncBodyHeight);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [rendered]);

  useEffect(() => {
    if (!isRunning) return;
    startFollowingReasoning();
  }, [isRunning, startFollowingReasoning]);

  useEffect(() => {
    if (!isRunning) return;
    scrollReasoningToBottom();
  }, [isRunning, reasoning, streamedText, scrollReasoningToBottom]);

  useEffect(() => {
    if (!open || isRunning) return undefined;

    function handleKeyDown(event) {
      if (event.key !== "Escape") return;

      event.preventDefault();
      onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isRunning, onClose, open]);

  async function runGeneration() {
    if (isRunning || (isSynopsis ? !selectedChapterId : !brief.trim())) return;

    setStage("running");
    setPhase("thinking");
    setReasoning("");
    setStreamedText("");
    setError("");

    try {
      const result = await onGenerate(isSynopsis ? "" : brief.trim(), (event) => {
        //the first status says whether this model thinks at all, so a thinking-off run opens on Writing
        if (event.type === "status") {
          if (event.value === "thinking" || event.value === "writing") setPhase(event.value);
          return;
        }
        if (event.type === "content" && event.value) {
          setStreamedText((currentText) => `${currentText}${event.value}`);
          return;
        }
        if (event.type !== "reasoning" || !event.value) return;
        setReasoning((currentReasoning) => `${currentReasoning}${event.value}`);
      }, isSynopsis ? selectedChapterId : null);

      onApply(result.entry);
      setBrief("");
      onClose();
    } catch (generationError) {
      setError(generationError.message || "Could not generate the entry.");
      setStage("error");
    }
  }

  function handleBriefKeyDown(event) {
    //enter sends, the brief is a sentence or two and not a place anyone wants to hunt for a button
    if (event.key !== "Enter" || event.shiftKey) return;

    event.preventDefault();
    runGeneration();
  }

  /* the thinking is done once the writing starts, so the pane hands the space over to the entry
  itself rather than leaving the author reading old reasoning while the real answer scrolls past */
  const isWriting = isRunning && phase === "writing";
  const preview = isWriting ? previewFromStream(streamedText) : null;
  const hasPreview = Boolean(preview?.name || preview?.description);
  const lowerLabel = String(categoryLabel || "entry").toLowerCase();
  const title = stage === "error"
    ? "Generation failed"
    : isRunning
      ? (phase === "writing" ? "Writing" : "Thinking")
      : `Generate ${lowerLabel}`;
  const { shownText: shownTitle, textRef: titleRef } = useTextSwap(title);

  if (!rendered) return null;

  return createPortal(
    <div
      className={cx(
        "lorebook-modal-guard fixed inset-0 z-[90] grid place-items-center bg-black/60 px-3 py-4 backdrop-blur-sm sm:px-6",
        modalState === "closing" && "pointer-events-none",
      )}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close entry generator"
        onClick={onClose}
        disabled={isRunning}
      />
      <section
        className={cx(
          "lorebook-modal",
          "lorebook-repair-modal",
          "lorebook-generate-modal",
          "t-modal",
          modalState === "open" && "is-open",
          modalState === "closing" && "is-closing",
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header>
          <h2 id={titleId} className="lorebook-repair-title">
            <span
              ref={titleRef}
              className={cx("lorebook-repair-title-text", "t-text-swap", isRunning && "t-shimmer")}
              data-text={shownTitle}
            >
              {shownTitle}
            </span>
          </h2>
          {!isRunning && (
            <button
              type="button"
              className={cx("lorebook-icon-button", CONTROL_MOTION)}
              onClick={onClose}
              aria-label="Close entry generator"
            >
              <X size={18} />
            </button>
          )}
        </header>

        <div
          className={cx("lorebook-modal-body", "lorebook-repair-modal-body", "t-resize")}
          style={bodyHeight === null ? undefined : { height: `${bodyHeight}px` }}
        >
          <div ref={bodyInnerRef} className="lorebook-repair-modal-body-inner">
            {stage === "prompt" && (
              isSynopsis ? (
                <label className="lorebook-generate-field">
                  <span>Chapter</span>
                  {eligibleChapters.length ? (
                    <select
                      id={descriptionId}
                      value={selectedChapterId}
                      autoFocus
                      onChange={(event) => setSelectedChapterId(event.target.value)}
                    >
                      {eligibleChapters.map((chapter) => (
                        <option key={chapter.id} value={chapter.id}>{chapter.title}</option>
                      ))}
                    </select>
                  ) : (
                    <div id={descriptionId} className="lorebook-generate-empty">
                      Write something in a visible chapter before generating its summary.
                    </div>
                  )}
                </label>
              ) : (
                <label className="lorebook-generate-field">
                  <span className="sr-only">What should this {lowerLabel} be?</span>
                  <textarea
                    id={descriptionId}
                    value={brief}
                    autoFocus
                    onChange={(event) => setBrief(event.target.value)}
                    onKeyDown={handleBriefKeyDown}
                    placeholder={BRIEF_PLACEHOLDERS[category] || BRIEF_PLACEHOLDERS.note}
                    spellCheck="true"
                    data-1p-ignore="true"
                  />
                </label>
              )
            )}

            {isRunning && (
              <>
                {/* the shimmering header carries the state visually, this is just for screen readers */}
                <span className="sr-only" role="status" aria-live="polite">
                  {phase === "writing" ? "Writing the entry" : "Thinking about the entry"}
                </span>
                <div
                  id={descriptionId}
                  ref={reasoningRef}
                  onScroll={markReasoningScroll}
                  onWheel={markReasoningWheelIntent}
                  onTouchStart={markReasoningTouchStart}
                  onTouchMove={markReasoningTouchMove}
                  className={cx(
                    "lorebook-repair-reasoning",
                    isWriting && "lorebook-generate-preview",
                    (isWriting ? !hasPreview : !reasoning) && "is-empty",
                  )}
                  data-testid="lorebook-generate-reasoning"
                >
                  {isWriting ? (
                    hasPreview ? (
                      <>
                        {preview.name && <p className="lorebook-generate-preview-name">{preview.name}</p>}
                        {preview.description && <p>{preview.description}</p>}
                      </>
                    ) : (
                      <span>Writing the entry now.</span>
                    )
                  ) : reasoning ? (
                    <ThinkingContent>{reasoning}</ThinkingContent>
                  ) : (
                    <span>Waiting for the model to share its thinking.</span>
                  )}
                </div>
              </>
            )}

            {stage === "error" && (
              <div id={descriptionId} className="lorebook-repair-error" role="alert">
                <p>Could not generate the entry. Your draft was not changed.</p>
                <span>{error}</span>
              </div>
            )}

            {/* the footer rides inside the measured wrapper so losing the buttons mid run tweens
            with everything else instead of snapping the dialog shorter */}
            {!isRunning && (
              <footer>
                <div className="lorebook-footer-actions">
                  {/* the corner x already backs out of here, a Cancel beside Generate is the same door twice */}
                  <button
                    type="button"
                    className={cx("lorebook-primary-button", CONTROL_MOTION)}
                    onClick={() => (stage === "error" ? setStage("prompt") : runGeneration())}
                    disabled={stage === "prompt" && (isSynopsis ? !selectedChapterId : !brief.trim())}
                  >
                    {stage === "error" ? "Back to prompt" : "Generate"}
                  </button>
                </div>
              </footer>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
