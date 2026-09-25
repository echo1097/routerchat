import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Plus,
  Search,
  WandSparkles,
} from "lucide-react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { useTextSwap } from "../textSwap.js";
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

const WIDE_LAYOUT_QUERY = "(min-width: 900px)";

const DRAFT_FIELDS = ["name", "category", "description", "aliasesText", "notes"];

const EMPTY_DRAFT = {
  name: "",
  category: "character",
  description: "",
  aliasesText: "",
  notes: "",
  metadata: {},
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
    revision: Number.isInteger(entry.revision) ? entry.revision : 0,
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
    metadata: entry.metadata || {},
  };
}

function draftHasText(draft) {
  return [draft.name, draft.description, draft.aliasesText, draft.notes]
    .some((value) => value.trim());
}

function draftsMatch(firstDraft, secondDraft) {
  return DRAFT_FIELDS.every((field) => firstDraft[field] === secondDraft[field]);
}

function entryFromDraft(draft, existingEntry) {
  const category = normalizeCategory(draft.category);
  const aliases = ["note", "synopsis"].includes(category) ? [] : normalizeArray(draft.aliasesText);
  const chapterId = String(draft.metadata?.chapter_id || "").trim();
  const metadata = category === "synopsis"
    ? (chapterId ? { chapter_id: chapterId } : {})
    : draft.notes.trim() && !["character", "note"].includes(category)
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
    revision: existingEntry?.revision ?? 0,
    disabled: existingEntry?.disabled ?? false,
    created_at: existingEntry?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function countTimelineEvents(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => line.replace(/^[-*]\s*/, "").trim()).length;
}

function useWideLayout() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_LAYOUT_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(WIDE_LAYOUT_QUERY);

    function handleChange(event) {
      setWide(event.matches);
    }

    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return wide;
}

function useSlidingTabs(activeCategory, tabCount, active = true) {
  const tabsRef = useRef(null);
  const pillRef = useRef(null);
  const measuredRef = useRef(false);

  useEffect(() => {
    const tabsBar = tabsRef.current;
    const pill = pillRef.current;

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
  chapters = [],
  activeChapterId = null,
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
  const [pageMode, setPageMode] = useState("empty");
  const [editingEntryId, setEditingEntryId] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [baselineDraft, setBaselineDraft] = useState(EMPTY_DRAFT);
  const [revealKey, setRevealKey] = useState(0);
  const [pendingAction, setPendingAction] = useState(null);
  const [editorError, setEditorError] = useState("");
  const [lorebookError, setLorebookError] = useState("");
  const [savingEntry, setSavingEntry] = useState(false);
  const [savingTimeline, setSavingTimeline] = useState(false);
  const [deletingEntryId, setDeletingEntryId] = useState(null);
  const [togglingEntryId, setTogglingEntryId] = useState(null);
  const searchWrapRef = useRef(null);
  const searchInputRef = useRef(null);
  const searchShakeRef = useRef(null);
  const wideLayout = useWideLayout();

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

  const entryTotals = useMemo(() => {
    const storyEntries = localEntries.filter((entry) => entry.category !== "timeline");
    return {
      total: storyEntries.length,
      hidden: storyEntries.filter((entry) => entry.disabled).length,
    };
  }, [localEntries]);

  const categoryEntries = useMemo(() => (
    localEntries
      .filter((entry) => {
        if (activeCategory === "timeline") return entry.category === "timeline";
        if (entry.category === "timeline") return false;
        return entry.category === activeCategory;
      })
      .sort((firstEntry, secondEntry) => firstEntry.name.localeCompare(secondEntry.name))
  ), [activeCategory, localEntries]);

  const visibleEntries = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return categoryEntries;

    return categoryEntries.filter((entry) => entry.name.toLowerCase().includes(query));
  }, [categoryEntries, searchTerm]);

  const timelineEntry = useMemo(
    () =>
      localEntries.find(
        (entry) => entry.category === "timeline" || entry.name.trim().toLowerCase() === "timeline",
      ),
    [localEntries],
  );

  const [liveTimelineCount, setLiveTimelineCount] = useState(null);
  const timelineCount = liveTimelineCount ?? countTimelineEvents(timelineEntry?.description || "");

  const editingEntry = useMemo(
    () => localEntries.find((entry) => entry.id === editingEntryId) || null,
    [editingEntryId, localEntries],
  );

  const isTimelineTab = activeCategory === "timeline";
  const pageOpen = pageMode !== "empty";
  const draftDirty = pageOpen && !draftsMatch(draft, baselineDraft);

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

  useEffect(() => {
    if (pageMode !== "entry" || draftDirty || savingEntry) return;

    if (!editingEntry) {
      closePageNow();
      return;
    }

    const freshDraft = draftFromEntry(editingEntry);
    if (draftsMatch(freshDraft, baselineDraft)) return;

    setDraft(freshDraft);
    setBaselineDraft(freshDraft);
  }, [editingEntry]);

  useEffect(() => {
    if (!wideLayout || isTimelineTab || draftDirty || pageMode === "new") return;
    if (editingEntry && editingEntry.category === activeCategory) return;

    const firstEntry = categoryEntries[0];
    if (firstEntry) {
      openEntryNow(firstEntry);
      return;
    }

    closePageNow();
  }, [activeCategory, wideLayout, categoryEntries.length]);

  useEffect(() => {
    if (!pageOpen || wideLayout) return undefined;

    function handleKeyDown(event) {
      if (event.key !== "Escape" || document.querySelector(".lorebook-modal")) return;

      event.preventDefault();
      requestPageChange(closePageNow);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  function requestPageChange(action) {
    if (draftDirty && !savingEntry) {
      setPendingAction(() => action);
      return;
    }

    action();
  }

  function discardAndContinue() {
    const action = pendingAction;
    setPendingAction(null);
    action?.();
  }

  function keepEditing() {
    setPendingAction(null);
  }

  function showDraft(nextDraft, entryId, mode) {
    setEditingEntryId(entryId);
    setDraft(nextDraft);
    setBaselineDraft(nextDraft);
    setPageMode(mode);
    setPendingAction(null);
    setEditorError("");
    setLorebookError("");
    setRevealKey((currentKey) => currentKey + 1);
  }

  function openEntryNow(entry) {
    showDraft(draftFromEntry(entry), entry.id, "entry");
  }

  function openNewEntryNow() {
    showDraft({ ...EMPTY_DRAFT, category: activeCategory }, null, "new");
  }

  function closePageNow() {
    setPageMode("empty");
    setEditingEntryId(null);
    setDraft(EMPTY_DRAFT);
    setBaselineDraft(EMPTY_DRAFT);
    setPendingAction(null);
    setEditorError("");
  }

  function selectEntry(entry) {
    if (entry.id === editingEntryId && pageMode === "entry") return;
    requestPageChange(() => openEntryNow(entry));
  }

  function openNewEntry() {
    if (locked || isTimelineTab) return;
    requestPageChange(openNewEntryNow);
  }

  function closePage() {
    requestPageChange(closePageNow);
  }

  function discardChanges() {
    if (pageMode === "new") {
      closePageNow();
      return;
    }

    setDraft(baselineDraft);
    setEditorError("");
  }

  function goBack() {
    requestPageChange(onBack);
  }

  function updateDraft(field, value) {
    setEditorError("");
    setDraft((currentDraft) => ({
      ...currentDraft,
      [field]: value,
    }));
  }

  /* a generated entry lands in the draft rather than the lorebook, so the author still reads it over
  and presses Create entry themselves */
  function applyGeneratedEntry(generatedEntry) {
    const generatedChapterId = String(generatedEntry.metadata?.chapter_id || "").trim();
    let linkedEntry = generatedChapterId
      ? localEntries.find((entry) => (
        !entry.disabled
        && entry.category === "synopsis"
        && String(entry.metadata?.chapter_id || "") === generatedChapterId
      ))
      : null;
    if (!linkedEntry && generatedChapterId) {
      const legacyMatches = localEntries.filter((entry) => (
        !entry.disabled
        && entry.category === "synopsis"
        && !String(entry.metadata?.chapter_id || "")
        && entry.name.toLowerCase() === String(generatedEntry.name || "").toLowerCase()
      ));
      linkedEntry = legacyMatches.length === 1 ? legacyMatches[0] : null;
    }

    setEditingEntryId(linkedEntry?.id || null);
    setPageMode(linkedEntry ? "entry" : "new");
    if (linkedEntry) setBaselineDraft(draftFromEntry(linkedEntry));
    setEditorError("");
    setRevealKey((currentKey) => currentKey + 1);
    setDraft((currentDraft) => ({
      ...currentDraft,
      name: generatedEntry.name || currentDraft.name,
      category: normalizeCategory(generatedEntry.category || currentDraft.category),
      description: generatedEntry.description || "",
      aliasesText: (generatedEntry.aliases || []).join(", "),
      notes: generatedEntry.notes || "",
      metadata: generatedEntry.metadata || {},
    }));
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
      const normalizedEntry = normalizeEntry(savedEntry);

      setLocalEntries((currentEntries) => {
        if (existingEntry) {
          return currentEntries.map((entry) => (entry.id === existingEntry.id ? normalizedEntry : entry));
        }

        return [normalizedEntry, ...currentEntries];
      });

      const savedDraft = draftFromEntry(normalizedEntry);
      setEditingEntryId(normalizedEntry.id);
      setDraft(savedDraft);
      setBaselineDraft(savedDraft);
      setPageMode("entry");
      setPendingAction(null);
      if (normalizedEntry.category !== activeCategory) setActiveCategory(normalizedEntry.category);
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
      setEditorError(error.message || "Could not delete entry.");
      return false;
    } finally {
      setDeletingEntryId(null);
    }
  }

  async function deleteEditingEntry() {
    if (!editingEntryId) return;

    const deleted = await deleteEntry(editingEntryId);
    if (deleted) {
      closePageNow();
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

  const activeCategoryOption = CATEGORY_OPTIONS.find((category) => category.id === activeCategory);
  const activeCategoryLabel = activeCategoryOption?.plural.toLowerCase() || "entries";
  const activeSingularLabel = activeCategoryOption?.label.toLowerCase() || "entry";
  const searching = Boolean(searchTerm.trim());
  const entryUnit = entryTotals.total === 1 ? "entry" : "entries";

  return (
    <>
      <section data-tour="write-lorebook" className="lorebook-shell min-h-0">
        <div className="lorebook-frame">
          <header className="lorebook-header">
            <button
              type="button"
              onClick={goBack}
              className={cx("lorebook-back-button", CONTROL_MOTION)}
              aria-label="Back to chapter"
              title="Back to chapter"
            >
              <ArrowLeft size={18} />
            </button>

            <div className="lorebook-title-block">
              <h1>Lorebook</h1>
              <p className="lorebook-story-title">{story.title}</p>
            </div>

            <div className="lorebook-header-actions">
              <p className="lorebook-totals">
                <span>{entryTotals.total} {entryUnit}</span>
                {entryTotals.hidden > 0 && <span>{entryTotals.hidden} hidden from context</span>}
              </p>
              {!isTimelineTab && (
                <button
                  type="button"
                  onClick={openNewEntry}
                  disabled={locked}
                  className={cx("lorebook-primary-button lorebook-new-entry-button", CONTROL_MOTION)}
                >
                  <Plus size={16} />
                  New entry
                </button>
              )}
            </div>
          </header>

          <div className="lorebook-tabs-row">
            <nav ref={tabsRef} className="lorebook-tabs t-tabs" role="tablist" aria-label="Lorebook categories">
              <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
              {CATEGORY_OPTIONS.map((category) => {
                const selected = activeCategory === category.id;
                const tabCount = category.id === "timeline" ? timelineCount : counts[category.id] || 0;

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
                    <span className="lorebook-count">{tabCount}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          {lorebookError && <div className="lorebook-form-error lorebook-page-error" role="alert">{lorebookError}</div>}

          {isTimelineTab ? (
            <TimelineCanvas
              entry={timelineEntry}
              locked={locked}
              saving={savingTimeline}
              onSave={saveTimeline}
              onRepair={onRepairTimeline}
              onRepairLorebook={onRepairLorebook}
              onEventCountChange={setLiveTimelineCount}
            />
          ) : (
            <div className={cx("lorebook-workspace", pageOpen && "has-page")}>
              <aside className="lorebook-list-pane" aria-label={`${activeCategoryOption?.plural || "Entries"} list`}>
                <div ref={searchWrapRef} className="lorebook-search-wrap t-input-wrap">
                  <label ref={searchInputRef} className="lorebook-search t-input">
                    <Search size={15} />
                    <input
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      placeholder={`Search ${activeCategoryLabel}`}
                      aria-label="Search lorebook entries"
                      data-1p-ignore="true"
                    />
                  </label>
                </div>

                {visibleEntries.length === 0 ? (
                  <div className="lorebook-list-empty">
                    <p className="lorebook-list-empty-title">
                      {searching ? "No matching entries" : `No ${activeCategoryLabel} yet`}
                    </p>
                    <p>
                      {searching
                        ? "Try a different name or switch categories."
                        : "Create an entry to keep important story details close at hand."}
                    </p>
                  </div>
                ) : (
                  <ul className="lorebook-list">
                    {visibleEntries.map((entry) => (
                      <LorebookRow
                        key={entry.id}
                        entry={entry}
                        selected={pageMode === "entry" && entry.id === editingEntryId}
                        onSelect={() => selectEntry(entry)}
                        onToggleContext={() => toggleEntryContext(entry)}
                        toggling={togglingEntryId === entry.id}
                        contextBusy={Boolean(togglingEntryId)}
                        locked={locked}
                      />
                    ))}
                  </ul>
                )}
              </aside>

              <div className={cx("lorebook-page-pane", pageOpen && "is-open")} aria-hidden={!wideLayout && !pageOpen}>
                {pageOpen ? (
                  <LorebookEntryPage
                    key={revealKey}
                    draft={draft}
                    entry={pageMode === "entry" ? editingEntry : null}
                    editing={pageMode === "entry"}
                    dirty={draftDirty}
                    pendingChange={Boolean(pendingAction)}
                    saving={savingEntry}
                    deleting={Boolean(editingEntryId) && deletingEntryId === editingEntryId}
                    error={editorError}
                    locked={locked}
                    wideLayout={wideLayout}
                    togglingContext={Boolean(editingEntryId) && togglingEntryId === editingEntryId}
                    contextBusy={Boolean(togglingEntryId)}
                    onChange={updateDraft}
                    onSubmit={saveEntry}
                    onDelete={deleteEditingEntry}
                    onDiscard={discardChanges}
                    onClose={closePage}
                    onToggleContext={() => editingEntry && toggleEntryContext(editingEntry)}
                    onDiscardAndContinue={discardAndContinue}
                    onKeepEditing={keepEditing}
                    onGenerateEntry={onGenerateEntry}
                    onApplyGenerated={applyGeneratedEntry}
                    chapters={chapters}
                    activeChapterId={activeChapterId}
                  />
                ) : (
                  <div className="lorebook-page-empty">
                    <p className="lorebook-page-empty-title">
                      {categoryEntries.length ? `Pick a ${activeSingularLabel} to read or edit it` : `Start your ${activeCategoryLabel}`}
                    </p>
                    <p>Entries you keep in context are shared with the model while it writes.</p>
                    <button
                      type="button"
                      onClick={openNewEntry}
                      disabled={locked}
                      className={cx("lorebook-secondary-button", CONTROL_MOTION)}
                    >
                      <Plus size={15} />
                      Add a {activeSingularLabel}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function ContextIcons({ size = 16 }) {
  return (
    <>
      <span className="lorebook-context-icon lorebook-context-icon-eye" aria-hidden="true">
        <Eye size={size} />
      </span>
      <span className="lorebook-context-icon lorebook-context-icon-eye-off" aria-hidden="true">
        <EyeOff size={size} />
      </span>
    </>
  );
}

function LorebookRow({ entry, selected, onSelect, onToggleContext, toggling, contextBusy, locked }) {
  const preview = entry.description.trim() || "No description yet.";

  return (
    <li className={cx("lorebook-row", selected && "is-selected", entry.disabled && "is-disabled")}>
      <button
        type="button"
        className="lorebook-row-main"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        aria-label={`Open ${entry.name}`}
      >
        <span className="lorebook-row-name">{entry.name}</span>
        <span className="lorebook-row-preview">{preview}</span>
      </button>

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
        <ContextIcons />
      </button>
    </li>
  );
}

function LorebookEntryPage({
  draft,
  entry,
  editing,
  dirty,
  pendingChange,
  saving,
  deleting,
  error,
  locked,
  wideLayout,
  togglingContext,
  contextBusy,
  onChange,
  onSubmit,
  onDelete,
  onDiscard,
  onClose,
  onToggleContext,
  onDiscardAndContinue,
  onKeepEditing,
  onGenerateEntry,
  onApplyGenerated,
  chapters,
  activeChapterId,
}) {
  const [generateOpen, setGenerateOpen] = useState(false);
  const { tabsRef, pillRef } = useSlidingTabs(draft.category, ENTRY_CATEGORY_OPTIONS.length);
  const descriptionRef = useRef(null);

  const showAliases = !["note", "synopsis"].includes(draft.category);
  const showNotes = !["character", "note", "synopsis"].includes(draft.category);
  const categoryLabel = ENTRY_CATEGORY_OPTIONS.find((option) => option.id === draft.category)?.label || "entry";
  const hasDraftText = draftHasText(draft);
  const submitLabel = saving ? "Saving..." : editing ? "Save entry" : "Create entry";
  const { shownText: shownSubmitLabel, textRef: submitLabelRef } = useTextSwap(submitLabel);
  const statusText = locked
    ? "Locked while the model is writing"
    : dirty
      ? "Unsaved changes"
      : editing
        ? "All changes saved"
        : "New entry";

  useEffect(() => {
    const textarea = descriptionRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft.description, draft.category]);

  return (
    <form
      onSubmit={onSubmit}
      className="lorebook-entry-page"
      aria-label={editing ? "Edit lorebook entry" : "Create lorebook entry"}
    >
      <div className="lorebook-entry-scroll">
        <div className="lorebook-entry-body">
          {!wideLayout && (
            <button type="button" onClick={onClose} className={cx("lorebook-page-back", CONTROL_MOTION)}>
              <ArrowLeft size={15} />
              All entries
            </button>
          )}

          <div className="lorebook-reveal lorebook-entry-heading">
            <input
              id="lorebook-entry-name"
              className="lorebook-name-input"
              aria-label="Entry name"
              autoFocus={!editing}
              value={draft.name}
              onChange={(event) => onChange("name", event.target.value)}
              placeholder="Untitled entry"
              disabled={locked}
              data-1p-ignore="true"
            />

            {entry && (
              <button
                type="button"
                className={cx("lorebook-context-chip", CONTROL_MOTION, entry.disabled && "is-disabled")}
                onClick={onToggleContext}
                disabled={locked || contextBusy}
                aria-pressed={!entry.disabled}
                aria-busy={togglingContext}
                title={entry.disabled ? "Include in context" : "Exclude from context"}
              >
                <span className="lorebook-context-chip-icon">
                  <ContextIcons size={14} />
                </span>
                {entry.disabled ? "Hidden from context" : "In context"}
              </button>
            )}
          </div>

          <div className="lorebook-reveal lorebook-category-row">
            <div ref={tabsRef} className="lorebook-category-tabs t-tabs" role="tablist" aria-label="Entry category">
              <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
              {ENTRY_CATEGORY_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="lorebook-category-tab t-tab"
                  onClick={() => onChange("category", option.id)}
                  role="tab"
                  aria-selected={draft.category === option.id}
                  disabled={locked}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <label className="lorebook-reveal lorebook-field is-description">
            <span className="lorebook-field-label">Description</span>
            <textarea
              ref={descriptionRef}
              value={draft.description}
              onChange={(event) => onChange("description", event.target.value)}
              placeholder={DESCRIPTION_PROMPTS[draft.category] || DESCRIPTION_PROMPTS.note}
              disabled={locked}
              rows={4}
              data-1p-ignore="true"
            />
          </label>

          {showAliases && (
            <label className="lorebook-reveal lorebook-field">
              <span className="lorebook-field-label">Aliases</span>
              <input
                value={draft.aliasesText}
                onChange={(event) => onChange("aliasesText", event.target.value)}
                placeholder="Nicknames, titles, other names this goes by"
                disabled={locked}
                data-1p-ignore="true"
              />
              <span className="lorebook-field-hint">Separate names with commas.</span>
            </label>
          )}

          {showNotes && (
            <label className="lorebook-reveal lorebook-field">
              <span className="lorebook-field-label">Notes</span>
              <textarea
                value={draft.notes}
                onChange={(event) => onChange("notes", event.target.value)}
                placeholder="Extra structured details for this entry"
                disabled={locked}
                rows={3}
                data-1p-ignore="true"
              />
            </label>
          )}

          {error && <div className="lorebook-form-error" role="alert">{error}</div>}
        </div>
      </div>

      <footer className={cx("lorebook-entry-footer", pendingChange && "is-confirming")}>
        {pendingChange ? (
          <>
            <p className="lorebook-footer-status is-warning" role="status">
              Discard your unsaved changes?
            </p>
            <div className="lorebook-footer-actions">
              <button type="button" onClick={onKeepEditing} className={cx("lorebook-secondary-button", CONTROL_MOTION)}>
                Keep editing
              </button>
              <button type="button" onClick={onDiscardAndContinue} className={cx("lorebook-danger-button", CONTROL_MOTION)}>
                Discard
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="lorebook-footer-left">
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
              <p className={cx("lorebook-footer-status", dirty && "is-dirty")}>{statusText}</p>
            </div>

            <div className="lorebook-footer-actions">
              {onGenerateEntry && !editing && (
                <button
                  type="button"
                  onClick={() => setGenerateOpen(true)}
                  disabled={hasDraftText || saving || locked}
                  className={cx("lorebook-secondary-button", CONTROL_MOTION)}
                >
                  <WandSparkles size={15} />
                  Generate entry
                </button>
              )}
              {(dirty || !editing) && (
                <button type="button" onClick={onDiscard} className={cx("lorebook-secondary-button", CONTROL_MOTION)}>
                  {editing ? "Discard changes" : "Cancel"}
                </button>
              )}
              <button
                type="submit"
                disabled={!hasDraftText || saving || locked || (editing && !dirty)}
                className={cx("lorebook-primary-button", CONTROL_MOTION)}
              >
                <span ref={submitLabelRef} className="t-text-swap" data-text={shownSubmitLabel}>
                  {shownSubmitLabel}
                </span>
              </button>
            </div>
          </>
        )}
      </footer>

      <GenerateEntryModal
        open={generateOpen}
        category={draft.category}
        categoryLabel={categoryLabel}
        onClose={() => setGenerateOpen(false)}
        chapters={chapters}
        activeChapterId={activeChapterId}
        onGenerate={(brief, onEvent, chapterId) => (
          onGenerateEntry(draft.category, brief, onEvent, chapterId)
        )}
        onApply={onApplyGenerated}
      />
    </form>
  );
}

function TimelineCanvas({ entry, locked, saving, onSave, onRepair, onRepairLorebook, onEventCountChange }) {
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
  const eventCount = countTimelineEvents(timelineText);

  useEffect(() => {
    onEventCountChange(eventCount);
  }, [eventCount, onEventCountChange]);

  useEffect(() => () => onEventCountChange(null), [onEventCountChange]);

  const saveLabel = saving ? "Saving..." : "Save timeline";
  const { shownText: shownSaveLabel, textRef: saveLabelRef } = useTextSwap(saveLabel);
  const statusText = locked
    ? "Timeline locked while the model is writing"
    : saving
      ? "Saving timeline"
      : changed
        ? "Unsaved changes"
        : "All changes saved";

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
        <aside className="lorebook-timeline-side">
          <div className="lorebook-timeline-intro">
            <h2>Timeline</h2>
            <p>
              One event per line, in the order things happen. The model reads this to keep the story
              straight.
            </p>
          </div>

          <div className="lorebook-timeline-actions">
            <button
              type="button"
              onClick={handleSave}
              disabled={!changed || locked || saving}
              className={cx("lorebook-primary-button", CONTROL_MOTION)}
            >
              <span ref={saveLabelRef} className="t-text-swap" data-text={shownSaveLabel}>
                {shownSaveLabel}
              </span>
            </button>
            <p className={cx("lorebook-footer-status", changed && !saving && "is-dirty")}>{statusText}</p>
          </div>

          <div className="lorebook-timeline-repairs">
            <p className="lorebook-timeline-repairs-label">Rebuild with the model</p>
            <button
              type="button"
              onClick={openRepair}
              disabled={locked || saving}
              className={cx("lorebook-secondary-button", CONTROL_MOTION)}
            >
              <WandSparkles size={15} />
              Repair timeline
            </button>
            <RepairLorebookButton
              locked={locked || repairStage === "running"}
              saving={saving}
              onRepair={onRepairLorebook}
            />
          </div>
        </aside>

        <div className="lorebook-timeline-document">
          <textarea
            value={timelineText}
            onChange={(event) => setTimelineText(event.target.value)}
            disabled={locked || saving || repairStage === "running"}
            placeholder="- Add the first durable timeline event"
            aria-label="Timeline"
            spellCheck="true"
            data-1p-ignore="true"
          />
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
