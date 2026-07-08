import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
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

function entryFromDraft(draft, existingEntry) {
  const category = normalizeCategory(draft.category);
  const aliases = ["note", "synopsis"].includes(category) ? [] : normalizeArray(draft.aliasesText);
  const metadata = draft.notes.trim() && !["character", "note", "synopsis"].includes(category)
    ? { notes: draft.notes.trim() }
    : {};

  return {
    id: existingEntry?.id || crypto.randomUUID(),
    story_id: existingEntry?.story_id,
    name: draft.name.trim(),
    category,
    description: draft.description.trim(),
    aliases,
    tags: [],
    metadata,
    disabled: false,
    created_at: existingEntry?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function categoryLabel(category) {
  return CATEGORY_OPTIONS.find((option) => option.id === category)?.label || "Note";
}

function entrySearchText(entry) {
  return [
    entry.name,
    entry.category,
    entry.description,
    ...(entry.aliases || []),
    ...Object.values(entry.metadata || {}),
  ]
    .join(" ")
    .toLowerCase();
}

function useSlidingTabs(activeCategory, tabCount) {
  const tabsRef = useRef(null);
  const pillRef = useRef(null);
  const measuredRef = useRef(false);

  useEffect(() => {
    const tabsBar = tabsRef.current;
    const pill = pillRef.current;
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

    function handleResize() {
      movePill(false);
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [activeCategory, tabCount]);

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
    if (!draft.name.trim() || savingEntry || locked) return;

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

  async function deleteEntry(entryId) {
    if (deletingEntryId || locked) return false;

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
      disabled: false,
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

  return (
    <>
      <section className="lorebook-shell min-h-0 overflow-y-auto px-4 py-6 sm:px-8 lg:px-10">
        <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col">
          <header className="lorebook-header">
            <div className="lorebook-title-block">
              <button type="button" onClick={onBack} className={cx("lorebook-back-button", CONTROL_MOTION)}>
                <ArrowLeft size={14} />
                Back to chapter
              </button>
              <div className="lorebook-story-title">{story.title}</div>
              <h1>Lorebook</h1>
              <p>Keep track of events in your story along with characters, locations, and other important elements.</p>
            </div>

            {!isTimelineTab && (
              <button
                type="button"
                onClick={openNewEntry}
                disabled={locked}
                className={cx("lorebook-primary-button", CONTROL_MOTION)}
              >
                <Plus size={16} />
                New entry
              </button>
            )}
          </header>

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
                  <span className="lorebook-count">{counts[category.id] || 0}</span>
                </button>
              );
            })}
          </nav>

          <div className="lorebook-control-row">
            <div ref={searchWrapRef} className="lorebook-search-wrap t-input-wrap">
              <label ref={searchInputRef} className="lorebook-search t-input">
                <Search size={17} />
                <input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search entries..."
                />
              </label>
            </div>
          </div>

          {lorebookError && <div className="lorebook-form-error">{lorebookError}</div>}

          {isTimelineTab ? (
            <TimelineCanvas
              entry={timelineEntry}
              locked={locked}
              saving={savingTimeline}
              onSave={saveTimeline}
            />
          ) : visibleEntries.length === 0 ? (
            <div className="lorebook-empty">
              <h2>No entries found</h2>
            </div>
          ) : (
            <div className="lorebook-grid">
              {visibleEntries.map((entry) => (
                <LorebookCard
                  key={entry.id}
                  entry={entry}
                  onEdit={() => openEditEntry(entry)}
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
        locked={locked}
      />
    </>
  );
}

function TimelineCanvas({ entry, locked, saving, onSave }) {
  const [timelineText, setTimelineText] = useState(entry?.description || "");
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

  return (
    <section className="lorebook-timeline-canvas">
      <textarea
        value={timelineText}
        onChange={(event) => setTimelineText(event.target.value)}
        disabled={locked || saving}
        placeholder="- Add the first durable timeline event"
        spellCheck="true"
      />
      <div className="lorebook-timeline-footer">
        <span>{locked ? "timeline locked while the model is writing" : saving ? "saving timeline" : "markdown bullets"}</span>
        <button
          type="button"
          onClick={handleSave}
          disabled={!changed || locked || saving}
          className={cx("lorebook-primary-button", CONTROL_MOTION)}
        >
          {saving ? "Saving..." : "Save timeline"}
        </button>
      </div>
    </section>
  );
}

function LorebookCard({ entry, onEdit, locked }) {
  function handleKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    onEdit();
  }

  return (
    <article
      className="lorebook-card"
      role="button"
      tabIndex={locked ? -1 : 0}
      aria-label={`Edit ${entry.name}`}
      onClick={onEdit}
      onKeyDown={handleKeyDown}
    >
      <div className="lorebook-card-top">
        <div className="lorebook-card-title-row">
          <h2>{entry.name}</h2>
          <span className="lorebook-category-pill">{categoryLabel(entry.category)}</span>
        </div>
      </div>

      <p>{entry.description || "No description yet."}</p>
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
  locked,
}) {
  const [rendered, setRendered] = useState(open);
  const [modalState, setModalState] = useState(open ? "open" : "closed");
  const [categoryOpen, setCategoryOpen] = useState(false);

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
      setCategoryOpen(false);
    }, closeMs);

    return () => window.clearTimeout(timeoutId);
  }, [open, rendered]);

  if (!rendered) return null;

  const showAliases = !["note", "synopsis"].includes(draft.category);
  const showNotes = !["character", "note", "synopsis"].includes(draft.category);
  const selectedCategory = ENTRY_CATEGORY_OPTIONS.find((option) => option.id === draft.category) || ENTRY_CATEGORY_OPTIONS[0];

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
        className={cx("lorebook-modal t-modal", modalState === "open" && "is-open", modalState === "closing" && "is-closing")}
        aria-modal="true"
        aria-labelledby="lorebook-editor-title"
      >
        <header>
          <div>
            <div className="lorebook-modal-eyebrow">{editing ? "Edit entry" : "New entry"}</div>
            <h2 id="lorebook-editor-title">{editing ? draft.name || "Edit entry" : "Create lorebook entry"}</h2>
          </div>
          <div className="lorebook-modal-actions">
            {editing && (
              <button
                type="button"
                className={cx("lorebook-icon-button lorebook-delete-button", CONTROL_MOTION)}
                onClick={onDelete}
                disabled={deleting || saving || locked}
                aria-label="Delete lorebook entry"
              >
                <Trash2 size={18} />
              </button>
            )}
            <button type="button" className={cx("lorebook-icon-button", CONTROL_MOTION)} onClick={onClose} aria-label="Close lorebook editor">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="lorebook-modal-body">
          <label>
            Name
            <input
              autoFocus
              value={draft.name}
              onChange={(event) => onChange("name", event.target.value)}
              placeholder="Entry name"
              disabled={locked}
            />
          </label>

          <label>
            Category
            <div className="lorebook-category-accordion t-acc" data-open={String(categoryOpen && !locked)}>
              <button
                type="button"
                className="lorebook-category-trigger t-acc-head"
                onClick={() => setCategoryOpen((wasOpen) => !wasOpen)}
                aria-expanded={categoryOpen && !locked}
                disabled={locked}
              >
                <span>{selectedCategory.label}</span>
                <span className="t-acc-chevron" aria-hidden="true">
                  <ChevronDown size={17} />
                </span>
              </button>

              <div className="t-acc-panel">
                <div className="lorebook-category-panel t-acc-panel-inner">
                  {ENTRY_CATEGORY_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={cx("lorebook-category-option", draft.category === option.id && "is-selected")}
                      onClick={() => {
                        onChange("category", option.id);
                        setCategoryOpen(false);
                      }}
                      aria-pressed={draft.category === option.id}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </label>

          <label>
            Description
            <textarea
              value={draft.description}
              onChange={(event) => onChange("description", event.target.value)}
              placeholder="Core lorebook text the writer should remember"
              disabled={locked}
            />
          </label>

          {showAliases && (
            <label>
              Aliases
              <input
                value={draft.aliasesText}
                onChange={(event) => onChange("aliasesText", event.target.value)}
                placeholder="Seren, Doctor Mishra"
                disabled={locked}
              />
            </label>
          )}

          {showNotes && (
            <label>
              Notes
              <textarea
                value={draft.notes}
                onChange={(event) => onChange("notes", event.target.value)}
                placeholder="Extra structured details for this entry"
                disabled={locked}
              />
            </label>
          )}

          {error && <div className="lorebook-form-error">{error}</div>}
        </div>

        <footer>
          <button type="button" onClick={onClose} className={cx("lorebook-secondary-button", CONTROL_MOTION)}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!draft.name.trim() || saving || locked}
            className={cx("lorebook-primary-button", CONTROL_MOTION)}
          >
            {saving ? "Saving..." : editing ? "Save entry" : "Create entry"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
