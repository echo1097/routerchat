import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Plus,
  Search,
} from "lucide-react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import RepairModal, { repairDurationParts } from "./RepairModal.jsx";
import RepairLorebookButton from "./RepairLorebookButton.jsx";
import GenerateEntryModal from "./GenerateEntryModal.jsx";
import "./StoryLorebook.css";

const CATEGORY_OPTIONS = [
  { id: "character", label: "Character", plural: "Characters" },
  { id: "location", label: "Location", plural: "Locations" },
  { id: "item", label: "Item", plural: "Items" },
  { id: "event", label: "Event", plural: "Events" },
  { id: "note", label: "Note", plural: "Notes" },
  { id: "synopsis", label: "Chapter Summary", plural: "Chapter Summaries" },
  { id: "timeline", label: "Timeline", plural: "Timeline" },
];

const ENTRY_CATEGORY_OPTIONS = CATEGORY_OPTIONS.filter((option) => !["all", "timeline"].includes(option.id));

const DESCRIPTION_PROMPTS = {
  character: "Who are they? What do they look like, and how do they act?",
  location: "What is this place like? What happens here?",
  item: "What is it, and why does it matter?",
  event: "What happened, and who was there?",
  note: "What should the writer keep in mind?",
  synopsis: "What happens in this chapter, from start to finish?",
};

//matches --resize-dur on the editor body, the two have to agree or scrolling comes back mid tween
const BODY_RESIZE_MS = 220;

//matches --acc-expand and --acc-collapse, the details panel owns the motion for that stretch
const DETAILS_TWEEN_MS = 250;

const EMPTY_DRAFT = {
  name: "",
  category: "character",
  description: "",
  aliasesText: "",
  notes: "",
};

function normalizeCategory(category) {
  const value = String(category || "note").trim().toLowerCase();
  if (value === "all") return "character";
  if (value === "characters") return "character";
  if (value === "locations") return "location";
  if (value === "items") return "item";
  if (value === "events") return "event";
  if (value === "starting scenario") return "note";
  return CATEGORY_OPTIONS.some((option) => option.id === value) ? value : "note";
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEntry(entry) {
  const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
  const updatedAt = entry.updated_at || entry.updatedAt || new Date().toISOString();

  return {
    id: entry.id || crypto.randomUUID(),
    name: String(entry.name || "Untitled entry"),
    category: normalizeCategory(entry.category),
    description: String(entry.description || entry.content || ""),
    aliases: normalizeArray(entry.aliases),
    tags: normalizeArray(entry.tags),
    metadata,
    disabled: Boolean(entry.disabled),
    created_at: entry.created_at || entry.createdAt || updatedAt,
    updated_at: updatedAt,
  };
}

function draftFromEntry(entry) {
  return {
    name: entry.name || "",
    category: normalizeCategory(entry.category),
    description: entry.description || "",
    aliasesText: (entry.aliases || []).join(", "),
    notes: entry.metadata?.notes || "",
  };
}

function draftHasText(draft) {
  return [draft.name, draft.description, draft.aliasesText, draft.notes]
    .some((value) => value.trim());
}

function entryFromDraft(draft, existingEntry) {
  const category = normalizeCategory(draft.category);
  const aliases = ["note", "synopsis"].includes(category) ? [] : normalizeArray(draft.aliasesText);
  const metadata = draft.notes.trim() && !["character", "note", "synopsis"].includes(category)
    ? { notes: draft.notes.trim() }
    : {};

  return {
    id: existingEntry?.id || crypto.randomUUID(),
    story_id: existingEntry?.story_id,
    name: draft.name.trim() || "Untitled entry",
    category,
    description: draft.description.trim(),
    aliases,
    tags: [],
    metadata,
    disabled: existingEntry?.disabled ?? false,
    created_at: existingEntry?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function useSlidingTabs(activeCategory, tabCount, active = true) {
  const tabsRef = useRef(null);
  const pillRef = useRef(null);
  const measuredRef = useRef(false);

  useEffect(() => {
    const tabsBar = tabsRef.current;
    const pill = pillRef.current;

    /* a bar that unmounts between uses starts over, otherwise the pill would slide in from
    wherever it sat the last time the bar was on screen */
    if (!active) {
      measuredRef.current = false;
      return undefined;
    }

    if (!tabsBar || !pill) return undefined;

    function movePill(animate) {
      const activeTab = tabsBar.querySelector('[aria-selected="true"]');
      if (!activeTab) return;

      if (!animate) {
        const previousTransition = pill.style.transition;
        pill.style.transition = "none";
        pill.style.transform = `translateX(${activeTab.offsetLeft}px)`;
        pill.style.width = `${activeTab.offsetWidth}px`;
        void pill.offsetWidth;
        pill.style.transition = previousTransition;
        return;
      }

      pill.style.transform = `translateX(${activeTab.offsetLeft}px)`;
      pill.style.width = `${activeTab.offsetWidth}px`;
    }

    requestAnimationFrame(() => {
      movePill(measuredRef.current);
      measuredRef.current = true;
    });

    function handleWindowResize() {
      movePill(false);
    }

    /* anything else that reflows the bar after the pill was placed leaves it on stale offsets, a
    scrollbar that comes and goes for a frame is enough, so remeasure off the bar itself. the first
    callback is the observer reporting the size it already has, which would cancel the slide */
    let observedOnce = false;
    const observer = new ResizeObserver(() => {
      if (!observedOnce) {
        observedOnce = true;
        return;
      }

      movePill(true);
    });

    observer.observe(tabsBar);
    window.addEventListener("resize", handleWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [activeCategory, tabCount, active]);

  return { tabsRef, pillRef };
}

export default function StoryLorebook({
  story,
  entries,
  onBack,
  initialCategory = "all",
  onCreateEntry,
  onUpdateEntry,
  onDeleteEntry,
  onConfirmDeleteEntry,
  onRepairTimeline,
  onRepairLorebook,
  onGenerateEntry,
  locked = false,
}) {
  const [localEntries, setLocalEntries] = useState(() => {
    const nextEntries = entries || [];
    return nextEntries.map(normalizeEntry);
  });
  const [activeCategory, setActiveCategory] = useState(
    initialCategory === "characters" ? "character" : normalizeCategory(initialCategory),
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editorError, setEditorError] = useState("");
  const [lorebookError, setLorebookError] = useState("");
  const [savingEntry, setSavingEntry] = useState(false);
  const [savingTimeline, setSavingTimeline] = useState(false);
  const [deletingEntryId, setDeletingEntryId] = useState(null);
  const [togglingEntryId, setTogglingEntryId] = useState(null);
  const searchWrapRef = useRef(null);
  const searchInputRef = useRef(null);
  const searchShakeRef = useRef(null);

  const { tabsRef, pillRef } = useSlidingTabs(activeCategory, CATEGORY_OPTIONS.length);

  useEffect(() => {
    const nextEntries = entries || [];
    setLocalEntries(nextEntries.map(normalizeEntry));
  }, [story?.id, entries]);

  const counts = useMemo(() => {
    const nextCounts = Object.fromEntries(CATEGORY_OPTIONS.map((option) => [option.id, 0]));
    localEntries.forEach((entry) => {
      nextCounts[entry.category] = (nextCounts[entry.category] || 0) + 1;
    });
    return nextCounts;
  }, [localEntries]);

  const visibleEntries = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return localEntries
      .filter((entry) => {
        if (activeCategory === "timeline") return entry.category === "timeline";
        if (entry.category === "timeline") return false;
        return entry.category === activeCategory;
      })
      .filter((entry) => {
        if (!query) return true;

        return entry.name.toLowerCase().includes(query);
      })
      .sort((firstEntry, secondEntry) => firstEntry.name.localeCompare(secondEntry.name));
  }, [activeCategory, localEntries, searchTerm]);

  const timelineEntry = useMemo(
    () =>
      localEntries.find(
        (entry) => entry.category === "timeline" || entry.name.trim().toLowerCase() === "timeline",
      ),
    [localEntries],
  );

  useEffect(() => {
    const query = searchTerm.trim();
    const noSearchResults = Boolean(query) && activeCategory !== "timeline" && visibleEntries.length === 0;
    const wrap = searchWrapRef.current;
    const input = searchInputRef.current;

    if (!wrap || !input) return;

    if (!query || activeCategory === "timeline") {
      window.clearTimeout(searchShakeRef.current);
      wrap.classList.remove("is-error");
      input.classList.remove("is-error", "is-shaking");
      return;
    }

    if (!noSearchResults) return;

    wrap.classList.add("is-error");
    input.classList.add("is-error");

    input.classList.remove("is-shaking");
    void input.offsetWidth;
    input.classList.add("is-shaking");

    const style = getComputedStyle(wrap);
    const readMs = (name, fallback) => {
      const value = Number.parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const shakeMs = readMs("--shake-dur-a", 80) * 2 + readMs("--shake-dur-b", 60) * 2;

    window.clearTimeout(searchShakeRef.current);
    searchShakeRef.current = window.setTimeout(() => {
      wrap.classList.remove("is-error");
      input.classList.remove("is-error", "is-shaking");
    }, shakeMs + 20);
  }, [activeCategory, searchTerm, visibleEntries.length]);

  useEffect(() => {
    return () => {
      window.clearTimeout(searchShakeRef.current);
    };
  }, []);

  function updateDraft(field, value) {
    setEditorError("");
    setDraft((currentDraft) => ({
      ...currentDraft,
      [field]: value,
    }));
  }

  function openNewEntry() {
    if (locked || activeCategory === "timeline") return;

    setEditingEntryId(null);
    setDraft({ ...EMPTY_DRAFT, category: activeCategory });
    setEditorError("");
    setLorebookError("");
    setEditorOpen(true);
  }

  /* a generated entry lands in the draft rather than the lorebook, so the author still reads it over
  and presses Create entry themselves */
  function applyGeneratedEntry(generatedEntry) {
    setEditorError("");
    setDraft((currentDraft) => ({
      ...currentDraft,
      name: generatedEntry.name || currentDraft.name,
      category: normalizeCategory(generatedEntry.category || currentDraft.category),
      description: generatedEntry.description || "",
      aliasesText: (generatedEntry.aliases || []).join(", "),
      notes: generatedEntry.notes || "",
    }));
  }

  function openEditEntry(entry) {
    if (locked) return;

    setEditingEntryId(entry.id);
    setDraft(draftFromEntry(entry));
    setEditorError("");
    setLorebookError("");
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditorOpen(false);
  }

  async function saveEntry(event) {
    event.preventDefault();
    if (!draftHasText(draft) || savingEntry || locked) return;

    const existingEntry = localEntries.find((entry) => entry.id === editingEntryId);
    const nextEntry = entryFromDraft(draft, existingEntry);

    try {
      setSavingEntry(true);
      setEditorError("");
      setLorebookError("");
      const savedEntry = existingEntry
        ? await onUpdateEntry(existingEntry.id, nextEntry)
        : await onCreateEntry(nextEntry);

      setLocalEntries((currentEntries) => {
        const normalizedEntry = normalizeEntry(savedEntry);
        if (existingEntry) {
          return currentEntries.map((entry) => (entry.id === existingEntry.id ? normalizedEntry : entry));
        }

        return [normalizedEntry, ...currentEntries];
      });
      closeEditor();
    } catch (error) {
      setEditorError(error.message || "Could not save entry.");
    } finally {
      setSavingEntry(false);
    }
  }

  async function toggleEntryContext(entry) {
    if (locked || savingEntry || togglingEntryId) return;

    const nextEntry = {
      ...entry,
      disabled: !entry.disabled,
      updated_at: new Date().toISOString(),
    };

    try {
      setTogglingEntryId(entry.id);
      setLorebookError("");
      setLocalEntries((currentEntries) =>
        currentEntries.map((currentEntry) => (currentEntry.id === entry.id ? nextEntry : currentEntry)),
      );

      const savedEntry = await onUpdateEntry(entry.id, nextEntry);
      const normalizedEntry = normalizeEntry(savedEntry);
      setLocalEntries((currentEntries) =>
        currentEntries.map((currentEntry) => (currentEntry.id === entry.id ? normalizedEntry : currentEntry)),
      );
    } catch (error) {
      setLocalEntries((currentEntries) =>
        currentEntries.map((currentEntry) => (currentEntry.id === entry.id ? entry : currentEntry)),
      );
      setLorebookError(error.message || "Could not update entry context.");
    } finally {
      setTogglingEntryId(null);
    }
  }

  async function deleteEntry(entryId) {
    if (deletingEntryId || locked) return false;

    const entry = localEntries.find((item) => item.id === entryId);
    if (!entry || !(await onConfirmDeleteEntry(entry))) return false;

    try {
      setDeletingEntryId(entryId);
      setLorebookError("");
      await onDeleteEntry(entryId);
      setLocalEntries((currentEntries) => currentEntries.filter((entry) => entry.id !== entryId));
      return true;
    } catch (error) {
      setLorebookError(error.message || "Could not delete entry.");
      return false;
    } finally {
      setDeletingEntryId(null);
    }
  }

  async function deleteEditingEntry() {
    if (!editingEntryId) return;

    const deleted = await deleteEntry(editingEntryId);
    if (deleted) {
      closeEditor();
    }
  }

  function normalizeTimelineText(value) {
    return String(value || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith("- ") ? line : `- ${line.replace(/^[-*]\s*/, "")}`))
      .join("\n");
  }

  async function saveTimeline(description) {
    if (savingTimeline || locked) return false;

    const nextDescription = normalizeTimelineText(description);
    const nextEntry = {
      id: timelineEntry?.id || crypto.randomUUID(),
      story_id: timelineEntry?.story_id,
      name: "Timeline",
      category: "timeline",
      description: nextDescription,
      aliases: timelineEntry?.aliases || ["Timeline"],
      tags: timelineEntry?.tags || [],
      metadata: timelineEntry?.metadata || {},
      disabled: timelineEntry?.disabled ?? false,
      created_at: timelineEntry?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    try {
      setSavingTimeline(true);
      setLorebookError("");
      const savedEntry = timelineEntry
        ? await onUpdateEntry(timelineEntry.id, nextEntry)
        : await onCreateEntry(nextEntry);
      const normalizedEntry = normalizeEntry(savedEntry);

      setLocalEntries((currentEntries) => {
        if (timelineEntry) {
          return currentEntries.map((entry) => (entry.id === timelineEntry.id ? normalizedEntry : entry));
        }

        return [normalizedEntry, ...currentEntries];
      });
      return true;
    } catch (error) {
      setLorebookError(error.message || "Could not save timeline.");
      return false;
    } finally {
      setSavingTimeline(false);
    }
  }

  const isTimelineTab = activeCategory === "timeline";
  const activeCategoryLabel = CATEGORY_OPTIONS.find((category) => category.id === activeCategory)?.plural.toLowerCase() || "entries";

  return (
    <>
      <section data-tour="write-lorebook" className="lorebook-shell min-h-0 overflow-y-auto px-4 py-6 sm:px-8 lg:px-10">
        <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col">
          <header className="lorebook-header">
            <div className="lorebook-title-block">
              <button type="button" onClick={onBack} className={cx("lorebook-back-button", CONTROL_MOTION)}>
                <ArrowLeft size={14} />
                Back to chapter
              </button>
              <div className="lorebook-story-title">{story.title}</div>
              <h1>Lorebook</h1>
            </div>

          </header>

          <div className={cx("lorebook-library-controls", isTimelineTab && "is-timeline")}>
            <nav ref={tabsRef} className="lorebook-tabs t-tabs" role="tablist" aria-label="Lorebook categories">
              <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
              {CATEGORY_OPTIONS.map((category) => {
                const selected = activeCategory === category.id;

                return (
                  <button
                    type="button"
                    key={category.id}
                    className="t-tab lorebook-tab"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setActiveCategory(category.id)}
                  >
                    <span>{category.plural}</span>
                    {category.id !== "timeline" && <span className="lorebook-count">{counts[category.id] || 0}</span>}
                  </button>
                );
              })}
            </nav>

            {!isTimelineTab && <>
              <div ref={searchWrapRef} className="lorebook-search-wrap t-input-wrap">
                <label ref={searchInputRef} className="lorebook-search t-input">
                  <Search size={16} />
                  <input
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Search entries..."
                    aria-label="Search lorebook entries"
                    data-1p-ignore="true"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={openNewEntry}
                disabled={locked}
                className={cx("lorebook-primary-button", CONTROL_MOTION)}
              >
                <Plus size={16} />
                New entry
              </button>
            </>}
          </div>

          {lorebookError && <div className="lorebook-form-error">{lorebookError}</div>}

          {isTimelineTab ? (
            <TimelineCanvas
              entry={timelineEntry}
              locked={locked}
              saving={savingTimeline}
              onSave={saveTimeline}
              onRepair={onRepairTimeline}
              onRepairLorebook={onRepairLorebook}
            />
          ) : visibleEntries.length === 0 ? (
            <div className="lorebook-empty">
              <h2>{searchTerm.trim() ? "No matching entries" : `No ${activeCategoryLabel} yet`}</h2>
              <p>{searchTerm.trim() ? "Try a different name or switch categories." : "Create an entry to keep important story details close at hand."}</p>
            </div>
          ) : (
            <div className="lorebook-grid">
              {visibleEntries.map((entry) => (
                <LorebookCard
                  key={entry.id}
                  entry={entry}
                  onEdit={() => openEditEntry(entry)}
                  onToggleContext={() => toggleEntryContext(entry)}
                  toggling={togglingEntryId === entry.id}
                  contextBusy={Boolean(togglingEntryId)}
                  locked={locked}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <LorebookEditorModal
        open={editorOpen}
        draft={draft}
        editing={Boolean(editingEntryId)}
        saving={savingEntry}
        error={editorError}
        onChange={updateDraft}
        onClose={closeEditor}
        onSubmit={saveEntry}
        onDelete={deleteEditingEntry}
        deleting={Boolean(editingEntryId) && deletingEntryId === editingEntryId}
        onGenerateEntry={onGenerateEntry}
        onApplyGenerated={applyGeneratedEntry}
        locked={locked}
      />
    </>
  );
}

function TimelineCanvas({ entry, locked, saving, onSave, onRepair, onRepairLorebook }) {
  const [timelineText, setTimelineText] = useState(entry?.description || "");
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairStage, setRepairStage] = useState("confirm");
  const [repairPhase, setRepairPhase] = useState("thinking");
  const [repairReasoning, setRepairReasoning] = useState("");
  const [repairDurationMs, setRepairDurationMs] = useState(null);
  const [repairError, setRepairError] = useState("");
  const savedTextRef = useRef(entry?.description || "");

  useEffect(() => {
    const nextText = entry?.description || "";
    setTimelineText(nextText);
    savedTextRef.current = nextText;
  }, [entry?.id, entry?.description]);

  const changed = timelineText !== savedTextRef.current;

  async function handleSave() {
    const saved = await onSave(timelineText);
    if (saved) {
      savedTextRef.current = timelineText;
    }
  }

  function openRepair() {
    if (locked || saving) return;

    setRepairStage("confirm");
    setRepairPhase("thinking");
    setRepairReasoning("");
    setRepairDurationMs(null);
    setRepairError("");
    setRepairOpen(true);
  }

  function closeRepair() {
    if (repairStage === "running") return;
    setRepairOpen(false);
  }

  async function confirmRepair() {
    if (repairStage === "running") return;

    setRepairStage("running");
    setRepairPhase("thinking");
    setRepairReasoning("");
    setRepairError("");

    try {
      const result = await onRepair(timelineText, (event) => {
        //the backend flips to writing the moment the first bit of timeline lands
        if (event.type === "status") {
          if (event.value === "writing") setRepairPhase("writing");
          return;
        }
        if (event.type !== "reasoning" || !event.value) return;
        setRepairReasoning((currentReasoning) => `${currentReasoning}${event.value}`);
      });
      const repairedText = result.entry?.description || "";
      setTimelineText(repairedText);
      savedTextRef.current = repairedText;
      setRepairDurationMs(result.duration_ms);
      setRepairStage("complete");
    } catch (error) {
      setRepairError(error.message || "Could not rebuild timeline.");
      setRepairStage("error");
    }
  }

  const { seconds: durationSeconds, unit: durationUnit } = repairDurationParts(repairDurationMs);

  return (
    <>
      <section className="lorebook-timeline-canvas">
        <textarea
          value={timelineText}
          onChange={(event) => setTimelineText(event.target.value)}
          disabled={locked || saving || repairStage === "running"}
          placeholder="- Add the first durable timeline event"
          spellCheck="true"
          data-1p-ignore="true"
        />
        <div className="lorebook-timeline-footer">
          <div className="lorebook-timeline-actions">
            <button
              type="button"
              onClick={handleSave}
              disabled={!changed || locked || saving}
              className={cx("lorebook-primary-button", CONTROL_MOTION)}
            >
              {saving ? "Saving..." : "Save timeline"}
            </button>
            <button
              type="button"
              onClick={openRepair}
              disabled={locked || saving}
              className={cx("lorebook-primary-button", CONTROL_MOTION)}
            >
              Repair timeline
            </button>
            <RepairLorebookButton
              locked={locked || repairStage === "running"}
              saving={saving}
              onRepair={onRepairLorebook}
            />
          </div>
          {(locked || saving) && (
            <span>{locked ? "timeline locked while the model is writing" : "saving timeline"}</span>
          )}
        </div>
      </section>

      <RepairModal
        open={repairOpen}
        stage={repairStage}
        phase={repairPhase}
        reasoning={repairReasoning}
        error={repairError}
        idPrefix="timeline-repair"
        closeLabel="Close timeline repair"
        titles={{
          confirm: "Repair timeline?",
          complete: "Timeline rebuilt",
          error: "Timeline repair failed",
        }}
        confirmLabel="Repair timeline"
        description={
          <>
            Repair timeline regenerates the entire timeline, discarding the current one and
            rebuilding it from the entire story (every chapter not hidden from context). Do you
            want to continue?
          </>
        }
        runningLabel={{
          thinking: "Repairing timeline, thinking",
          writing: "Repairing timeline, writing the rebuilt timeline",
        }}
        completeMessage={
          <>
            Finished rebuilding timeline in{" "}
            <span className="lorebook-repair-duration">{durationSeconds}</span>{" "}
            {durationUnit}.
          </>
        }
        errorLead="Could not rebuild timeline. The current timeline was not changed."
        reasoningTestId="timeline-repair-reasoning"
        onConfirm={confirmRepair}
        onClose={closeRepair}
      />
    </>
  );
}

function LorebookCard({ entry, onEdit, onToggleContext, toggling, contextBusy, locked }) {
  function handleKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    onEdit();
  }

  return (
    <article className={cx("lorebook-card", entry.disabled && "is-disabled")}>
      <div
        className="lorebook-card-content"
        role="button"
        tabIndex={locked ? -1 : 0}
        aria-label={`Edit ${entry.name}`}
        aria-disabled={locked}
        onClick={onEdit}
        onKeyDown={handleKeyDown}
      >
        <h2>{entry.name}</h2>

        <p>{entry.description || "No description yet."}</p>
      </div>

      <button
        type="button"
        className={cx("lorebook-context-button", CONTROL_MOTION, entry.disabled && "is-disabled")}
        onClick={onToggleContext}
        disabled={locked || contextBusy}
        aria-pressed={!entry.disabled}
        aria-busy={toggling}
        aria-label={entry.disabled ? `Include ${entry.name} in context` : `Exclude ${entry.name} from context`}
        title={entry.disabled ? "Include in context" : "Exclude from context"}
      >
        <span className="lorebook-context-icon lorebook-context-icon-eye" aria-hidden="true">
          <Eye size={17} />
        </span>
        <span className="lorebook-context-icon lorebook-context-icon-eye-off" aria-hidden="true">
          <EyeOff size={17} />
        </span>
      </button>
    </article>
  );
}

function LorebookEditorModal({
  open,
  draft,
  editing,
  saving,
  deleting,
  error,
  onChange,
  onClose,
  onSubmit,
  onDelete,
  onGenerateEntry,
  onApplyGenerated,
  locked,
}) {
  const [rendered, setRendered] = useState(open);
  const [modalState, setModalState] = useState(open ? "open" : "closed");
  const [generateOpen, setGenerateOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [bodyHeight, setBodyHeight] = useState(null);
  const [bodyResizing, setBodyResizing] = useState(false);
  const [bodyTracking, setBodyTracking] = useState(false);
  const bodyInnerRef = useRef(null);
  const measuredHeightRef = useRef(null);
  const bodyResizeTimeoutRef = useRef(null);
  const { tabsRef, pillRef } = useSlidingTabs(draft.category, ENTRY_CATEGORY_OPTIONS.length, rendered);

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
      setGenerateOpen(false);
      setDetailsOpen(false);
      setBodyHeight(null); //the next open measures fresh instead of tweening from the old category
    }, closeMs);

    return () => window.clearTimeout(timeoutId);
  }, [open, rendered]);

  /* while the box tweens toward a taller stack the new fields stick out past it, so scrolling stays
  off until the tween lands and no scrollbar can flicker in and out on the way */
  function markBodyResizing() {
    setBodyResizing(true);
    window.clearTimeout(bodyResizeTimeoutRef.current);
    bodyResizeTimeoutRef.current = window.setTimeout(() => setBodyResizing(false), BODY_RESIZE_MS + 40);
  }

  /* switching category adds or drops whole fields, so the body is pinned to whatever the current
  fields measure and tweens between the two heights instead of snapping */
  useLayoutEffect(() => {
    const inner = bodyInnerRef.current;
    if (!inner) return undefined;

    function syncBodyHeight() {
      const nextHeight = inner.offsetHeight; //offsetHeight, not a rect, the modal is mid scale transform while it opens
      const previousHeight = measuredHeightRef.current;
      measuredHeightRef.current = nextHeight;
      setBodyHeight(nextHeight);

      if (previousHeight === null || previousHeight === nextHeight) return;

      markBodyResizing();
    }

    syncBodyHeight();

    const observer = new ResizeObserver(syncBodyHeight);
    observer.observe(inner);
    return () => {
      observer.disconnect();
      window.clearTimeout(bodyResizeTimeoutRef.current);
      measuredHeightRef.current = null;
      setBodyResizing(false);
    };
  }, [rendered]);

  /* the details panel runs its own open and close tween, so for that stretch the body tracks it
  frame for frame instead of easing toward it and dragging the footer along late */
  useEffect(() => {
    if (!rendered) return undefined;

    setBodyTracking(true);
    const timeoutId = window.setTimeout(() => setBodyTracking(false), DETAILS_TWEEN_MS + 40);
    return () => window.clearTimeout(timeoutId);
  }, [detailsOpen, rendered]);

  useEffect(() => {
    if (!open) return;

    setDetailsOpen(Boolean(draft.aliasesText.trim() || draft.notes.trim()));
  }, [open]);

  /* the header shows an Esc affordance instead of a close glyph, so the key has to do the job. the
  generator sits on top of this one and owns Esc for as long as it is open */
  useEffect(() => {
    if (!open || generateOpen) return undefined;

    function handleKeyDown(event) {
      if (event.key !== "Escape") return;

      event.preventDefault();
      onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, generateOpen, onClose]);

  if (!rendered) return null;

  const showAliases = !["note", "synopsis"].includes(draft.category);
  const showNotes = !["character", "note", "synopsis"].includes(draft.category);
  const categoryLabel = ENTRY_CATEGORY_OPTIONS.find((option) => option.id === draft.category)?.label || "entry";
  const hasDraftText = draftHasText(draft);

  return createPortal(
    <div className="lorebook-modal-guard fixed inset-0 z-[80] grid place-items-center bg-black/60 px-3 py-4 backdrop-blur-sm sm:px-6">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close lorebook editor"
        onClick={onClose}
      />
      <form
        onSubmit={onSubmit}
        className={cx(
          "lorebook-modal lorebook-editor-modal t-modal",
          modalState === "open" && "is-open",
          modalState === "closing" && "is-closing",
        )}
        aria-modal="true"
        aria-label={editing ? "Edit lorebook entry" : "Create lorebook entry"}
      >
        <header>
          <div className="lorebook-editor-heading">
            <input
              id="lorebook-entry-name"
              className="lorebook-name-input"
              aria-label="Entry name"
              autoFocus
              value={draft.name}
              onChange={(event) => onChange("name", event.target.value)}
              placeholder="Untitled entry"
              disabled={locked}
              data-1p-ignore="true"
            />
          </div>
        </header>

        <div
          className={cx(
            "lorebook-modal-body t-resize",
            bodyResizing && "is-resizing",
            bodyTracking && "is-tracking",
          )}
          style={bodyHeight === null ? undefined : { height: `${bodyHeight}px` }}
        >
          <div ref={bodyInnerRef} className="lorebook-editor-body-inner">
            <div className="lorebook-category-row">
              <div ref={tabsRef} className="lorebook-category-tabs t-tabs" role="tablist" aria-label="Entry category">
                <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
                {ENTRY_CATEGORY_OPTIONS.map((option) => {
                  const selected = draft.category === option.id;

                  return (
                    <button
                      key={option.id}
                      type="button"
                      className="lorebook-category-tab t-tab"
                      onClick={() => {
                        markBodyResizing(); //a frame late here is a frame of scrollbar, and the pill measures against it
                        onChange("category", option.id);
                      }}
                      role="tab"
                      aria-selected={selected}
                      disabled={locked}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="lorebook-field">
              <span className="lorebook-field-label">Description</span>
              <textarea
                value={draft.description}
                onChange={(event) => onChange("description", event.target.value)}
                placeholder={DESCRIPTION_PROMPTS[draft.category] || DESCRIPTION_PROMPTS.note}
                disabled={locked}
                data-1p-ignore="true"
              />
            </label>

            {(showAliases || showNotes) && (
              <div className="lorebook-details t-acc" data-open={String(detailsOpen && !locked)}>
                <button
                  type="button"
                  className="lorebook-details-trigger t-acc-head"
                  onClick={() => setDetailsOpen((wasOpen) => !wasOpen)}
                  aria-expanded={detailsOpen && !locked}
                  aria-controls="lorebook-details-panel"
                  disabled={locked}
                >
                  <span className="lorebook-field-label">Details</span>
                  <span className="lorebook-details-state">{detailsOpen && !locked ? "Hide" : "Show"}</span>
                </button>
                <div id="lorebook-details-panel" className="t-acc-panel">
                  <div className="t-acc-panel-inner">
                    <div className="lorebook-details-panel">
                      {showAliases && <label className="lorebook-field">
                        <span className="lorebook-field-label">Aliases</span>
                        <input
                          value={draft.aliasesText}
                          onChange={(event) => onChange("aliasesText", event.target.value)}
                          placeholder="Nicknames, titles, other names this goes by"
                          disabled={locked}
                          data-1p-ignore="true"
                        />
                      </label>}

                      {showNotes && <label className="lorebook-field is-stacked">
                        <span className="lorebook-field-label">Notes</span>
                        <textarea
                          value={draft.notes}
                          onChange={(event) => onChange("notes", event.target.value)}
                          placeholder="Extra structured details for this entry"
                          disabled={locked}
                          data-1p-ignore="true"
                        />
                      </label>}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {error && <div className="lorebook-form-error">{error}</div>}
          </div>
        </div>

        <footer>
          {editing && (
            <button
              type="button"
              className={cx("lorebook-delete-button", CONTROL_MOTION)}
              onClick={onDelete}
              disabled={deleting || saving || locked}
            >
              {deleting ? "Deleting..." : "Delete entry"}
            </button>
          )}
          <div className="lorebook-footer-actions">
            <button type="button" onClick={onClose} className={cx("lorebook-secondary-button", CONTROL_MOTION)}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={!hasDraftText || saving || locked}
              className={cx("lorebook-primary-button", CONTROL_MOTION)}
            >
              {saving ? "Saving..." : editing ? "Save entry" : "Create entry"}
            </button>
            {/* generating is for a blank entry, an entry that already exists has words worth keeping */}
            {onGenerateEntry && !editing && (
              <button
                type="button"
                onClick={() => setGenerateOpen(true)}
                disabled={hasDraftText || saving || locked}
                className={cx("lorebook-generate-button", CONTROL_MOTION)}
              >
                Generate entry
              </button>
            )}
          </div>
        </footer>
      </form>

      <GenerateEntryModal
        open={generateOpen}
        category={draft.category}
        categoryLabel={categoryLabel}
        onClose={() => setGenerateOpen(false)}
        onGenerate={(brief, onEvent) => onGenerateEntry(draft.category, brief, onEvent)}
        onApply={onApplyGenerated}
      />
    </div>,
    document.body,
  );
}
