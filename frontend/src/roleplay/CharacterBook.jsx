import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, EyeOff, Plus, Search, Upload } from "lucide-react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { fitTextarea, useSlidingTabs, useWideLayout } from "../lorebook/lorebookLayout.js";
import { CHARACTER_COLORS, characterColor } from "./characterChain.js";
import { readCharacterCard } from "./characterCard.js";
import "../lorebook/StoryLorebook.css";
import "./CharacterBook.css";

const KIND_OPTIONS = [
  { id: "cast", label: "Played by the model" },
  { id: "user", label: "Played by you" },
];

const FIELDS = [
  {
    key: "description",
    label: "About",
    placeholder: "Who they are, how they know everyone else, what they want right now",
    rows: 4,
  },
  {
    key: "appearance",
    label: "Appearance",
    placeholder: "What someone notices first",
    rows: 2,
  },
  {
    key: "personality",
    label: "Personality",
    placeholder: "Temperament, habits, soft spots, what sets them off",
    rows: 3,
  },
  {
    key: "speech_style",
    label: "Voice",
    placeholder: "How they talk. Clipped? Formal? All lowercase? Never finishes a sentence?",
    rows: 2,
  },
  {
    key: "greeting",
    label: "Opening line",
    placeholder: "What they say when the scene starts. Leave this empty to start cold.",
    rows: 3,
  },
  {
    key: "example_dialogue",
    label: "Example dialogue",
    placeholder: "A short exchange that shows how they sound. {{char}} and {{user}} both work here.",
    rows: 4,
  },
];

const EMPTY_DRAFT = {
  name: "",
  kind: "cast",
  description: "",
  appearance: "",
  personality: "",
  speech_style: "",
  greeting: "",
  example_dialogue: "",
  color: "",
};

function draftFromCharacter(character) {
  return {
    name: character.name || "",
    kind: character.kind === "user" ? "user" : "cast",
    description: character.description || "",
    appearance: character.appearance || "",
    personality: character.personality || "",
    speech_style: character.speech_style || "",
    greeting: character.greeting || "",
    example_dialogue: character.example_dialogue || "",
    color: character.color || "",
  };
}

function draftsMatch(first, second) {
  return Object.keys(EMPTY_DRAFT).every((key) => first[key] === second[key]);
}

function characterPreview(character) {
  const preview = [character.description, character.personality, character.appearance]
    .map((value) => String(value || "").trim())
    .find(Boolean);
  return preview || "No details yet.";
}

function CharacterRow({ character, color, selected, onSelect, onToggleActive, busy }) {
  return (
    <li className={cx("lorebook-row", selected && "is-selected", character.disabled && "is-disabled")}>
      <button
        type="button"
        className="lorebook-row-main character-row-main"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        aria-label={`Open ${character.name}`}
      >
        <span className="character-row-heading">
          <span className="character-dot" style={{ background: color }} aria-hidden="true" />
          <span className="lorebook-row-name">{character.name}</span>
          {character.kind === "user" && <span className="character-you-badge">You</span>}
        </span>
        <span className="lorebook-row-preview">{characterPreview(character)}</span>
      </button>

      <button
        type="button"
        className={cx("lorebook-context-button", CONTROL_MOTION, character.disabled && "is-disabled")}
        onClick={onToggleActive}
        disabled={busy}
        aria-pressed={!character.disabled}
        aria-label={character.disabled ? `Bring ${character.name} into the scene` : `Keep ${character.name} out of the scene`}
        title={character.disabled ? "Out of the scene" : "In the scene"}
      >
        <span className="lorebook-context-icon lorebook-context-icon-eye" aria-hidden="true">
          <Eye size={16} />
        </span>
        <span className="lorebook-context-icon lorebook-context-icon-eye-off" aria-hidden="true">
          <EyeOff size={16} />
        </span>
      </button>
    </li>
  );
}

function CharacterPage({
  draft,
  editing,
  dirty,
  saving,
  deleting,
  error,
  wideLayout,
  onChange,
  onSubmit,
  onDelete,
  onDiscard,
  onClose,
}) {
  const { tabsRef, pillRef } = useSlidingTabs(draft.kind, KIND_OPTIONS.length);
  const nameRef = useRef(null);
  const fieldRefs = useRef({});

  useLayoutEffect(() => {
    for (const textarea of Object.values(fieldRefs.current)) {
      if (textarea) fitTextarea(textarea);
    }
  }, [draft.description, draft.appearance, draft.personality, draft.speech_style]);

  useLayoutEffect(() => {
    const textarea = nameRef.current;
    if (!textarea) return undefined;

    function fitName() {
      fitTextarea(textarea);
    }

    fitName();
    const observer = new ResizeObserver(fitName);
    observer.observe(textarea.parentElement);
    return () => observer.disconnect();
  }, [draft.name]);

  const canSave = Boolean(draft.name.trim());
  const statusText = dirty ? "Unsaved changes" : editing ? "All changes saved" : "";

  return (
    <form
      onSubmit={onSubmit}
      className="lorebook-entry-page"
      aria-label={editing ? "Edit character" : "Create character"}
    >
      <div className="lorebook-entry-scroll">
        <div className="lorebook-entry-body">
          {!wideLayout && (
            <button type="button" onClick={onClose} className={cx("lorebook-page-back", CONTROL_MOTION)}>
              <ArrowLeft size={15} />
              All characters
            </button>
          )}

          <div className="lorebook-reveal lorebook-entry-heading">
            <textarea
              ref={nameRef}
              className="lorebook-name-input"
              aria-label="Character name"
              autoFocus={!editing}
              rows={1}
              value={draft.name}
              onChange={(event) => onChange("name", event.target.value.replace(/\s*\n\s*/g, " "))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Unnamed character"
              data-1p-ignore="true"
            />
          </div>

          <div className="lorebook-reveal lorebook-category-row">
            <div ref={tabsRef} className="lorebook-category-tabs t-tabs" role="tablist" aria-label="Who plays this character">
              <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
              {KIND_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="lorebook-category-tab t-tab"
                  onClick={() => onChange("kind", option.id)}
                  role="tab"
                  aria-selected={draft.kind === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {FIELDS.map((field) => (
            <label
              key={field.key}
              className={cx("lorebook-reveal lorebook-field", field.key === "description" && "is-description")}
            >
              <span className="lorebook-field-label">{field.label}</span>
              <textarea
                ref={(node) => {
                  fieldRefs.current[field.key] = node;
                }}
                value={draft[field.key]}
                onChange={(event) => onChange(field.key, event.target.value)}
                placeholder={field.placeholder}
                rows={field.rows}
                data-1p-ignore="true"
              />
            </label>
          ))}

          <div className="lorebook-reveal lorebook-field">
            <span className="lorebook-field-label">Bubble color</span>
            <div className="character-swatches" role="radiogroup" aria-label="Bubble color">
              {CHARACTER_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === color}
                  aria-label={`Color ${color}`}
                  onClick={() => onChange("color", draft.color === color ? "" : color)}
                  className={cx("character-swatch", draft.color === color && "is-selected", CONTROL_MOTION)}
                  style={{ background: color }}
                />
              ))}
            </div>
          </div>

          {error && <div className="lorebook-form-error" role="alert">{error}</div>}
        </div>
      </div>

      <footer className="lorebook-entry-footer">
        <div className="lorebook-footer-left">
          {editing && (
            <button
              type="button"
              className={cx("lorebook-delete-button", CONTROL_MOTION)}
              onClick={onDelete}
              disabled={deleting || saving}
            >
              {deleting ? "Deleting..." : "Delete character"}
            </button>
          )}
          {statusText && <p className={cx("lorebook-footer-status", dirty && "is-dirty")}>{statusText}</p>}
        </div>

        <div className="lorebook-footer-actions">
          {(dirty || !editing) && (
            <button type="button" onClick={onDiscard} className={cx("lorebook-secondary-button", CONTROL_MOTION)}>
              {editing ? "Discard changes" : "Cancel"}
            </button>
          )}
          <button
            type="submit"
            disabled={!canSave || saving || (editing && !dirty)}
            className={cx("lorebook-primary-button", CONTROL_MOTION)}
          >
            {saving ? "Saving..." : editing ? "Save character" : "Create character"}
          </button>
        </div>
      </footer>
    </form>
  );
}

export default function CharacterBook({
  title,
  characters,
  onBack,
  onCreate,
  onUpdate,
  onDelete,
  onConfirmDelete,
  onImportScenario,
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [pageMode, setPageMode] = useState("closed");
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [error, setError] = useState("");
  const wideLayout = useWideLayout();
  const cardInputRef = useRef(null);

  const editingCharacter = characters.find((character) => character.id === editingId) || null;
  const savedDraft = editingCharacter ? draftFromCharacter(editingCharacter) : EMPTY_DRAFT;
  const dirty = !draftsMatch(draft, savedDraft);

  const colorById = useMemo(() => {
    const map = {};
    characters.forEach((character, index) => {
      map[character.id] = characterColor(character, index);
    });
    return map;
  }, [characters]);

  const visibleCharacters = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return characters;
    return characters.filter((character) => (
      `${character.name} ${character.description}`.toLowerCase().includes(term)
    ));
  }, [characters, searchTerm]);

  useEffect(() => {
    if (pageMode === "entry" && !editingCharacter) {
      setPageMode("closed");
      setEditingId(null);
    }
  }, [pageMode, editingCharacter]);

  function openNewCharacter() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setError("");
    setPageMode("new");
  }

  function selectCharacter(character) {
    setEditingId(character.id);
    setDraft(draftFromCharacter(character));
    setError("");
    setPageMode("entry");
  }

  function closePage() {
    setPageMode("closed");
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setError("");
  }

  function updateDraft(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function saveCharacter(event) {
    event.preventDefault();
    if (saving || !draft.name.trim()) return;

    try {
      setSaving(true);
      setError("");
      const body = { ...draft, name: draft.name.trim() };

      if (editingCharacter) {
        await onUpdate(editingCharacter.id, body);
      } else {
        const created = await onCreate(body);
        setEditingId(created.id);
        setPageMode("entry");
      }
      setDraft(body);
    } catch (saveError) {
      setError(saveError.message || "Could not save this character.");
    } finally {
      setSaving(false);
    }
  }

  async function importCards(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    try {
      setError("");
      let imported = 0;

      for (const file of files) {
        const card = await readCharacterCard(file);
        if (!card) {
          setError(`${file.name} is not a character card.`);
          continue;
        }

        const created = await onCreate(card.character);
        imported += 1;

        if (card.scenario && onImportScenario) await onImportScenario(card.scenario);
        if (files.length === 1) {
          setEditingId(created.id);
          setDraft(draftFromCharacter({ ...card.character, ...created }));
          setPageMode("entry");
        }
      }

      if (imported === 0 && files.length > 0) return;
    } catch (importError) {
      setError(importError.message || "Could not read that character card.");
    }
  }

  async function toggleCharacterActive(character) {
    if (togglingId) return;

    try {
      setTogglingId(character.id);
      setError("");
      await onUpdate(character.id, {
        ...draftFromCharacter(character),
        disabled: !character.disabled,
      });
    } catch (toggleError) {
      setError(toggleError.message || "Could not update this character.");
    } finally {
      setTogglingId(null);
    }
  }

  async function deleteEditingCharacter() {
    if (!editingCharacter || deletingId) return;
    if (!(await onConfirmDelete(editingCharacter))) return;

    try {
      setDeletingId(editingCharacter.id);
      setError("");
      await onDelete(editingCharacter.id);
      closePage();
    } catch (deleteError) {
      setError(deleteError.message || "Could not delete this character.");
    } finally {
      setDeletingId(null);
    }
  }

  const pageOpen = pageMode !== "closed";
  const searching = Boolean(searchTerm.trim());
  const castCount = characters.filter((character) => character.kind !== "user").length;

  return (
    <section className="lorebook-shell min-h-0">
      <div className="lorebook-frame">
        <header className="lorebook-header">
          <button
            type="button"
            onClick={onBack}
            className={cx("lorebook-back-button", CONTROL_MOTION)}
            aria-label="Back to the roleplay"
            title="Back to the roleplay"
          >
            <ArrowLeft size={18} />
          </button>

          <div className="lorebook-title-block">
            <h1>Characters</h1>
            <p className="lorebook-story-title">{title}</p>
          </div>

          <div className="lorebook-header-actions">
            {castCount > 0 && (
              <p className="lorebook-totals">
                <span>{castCount} in the cast</span>
              </p>
            )}
            <input
              ref={cardInputRef}
              type="file"
              accept=".json,.png"
              multiple
              className="hidden"
              onChange={(event) => {
                importCards(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => cardInputRef.current?.click()}
              className={cx("lorebook-secondary-button", CONTROL_MOTION)}
              title="Import a SillyTavern or TavernAI character card"
            >
              <Upload size={15} />
              Import card
            </button>
            <button
              type="button"
              onClick={openNewCharacter}
              className={cx("lorebook-primary-button lorebook-new-entry-button", CONTROL_MOTION)}
            >
              <Plus size={16} />
              New character
            </button>
          </div>
        </header>

        <div className={cx("lorebook-workspace character-workspace", pageOpen && "has-page")}>
          <aside className="lorebook-list-pane" aria-label="Character list">
            <div className="lorebook-search-wrap t-input-wrap">
              <label className="lorebook-search t-input">
                <Search size={15} />
                <input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search characters"
                  aria-label="Search characters"
                  data-1p-ignore="true"
                />
              </label>
            </div>

            {visibleCharacters.length === 0 ? (
              <div className="lorebook-list-empty">
                <p className="lorebook-list-empty-title">
                  {searching ? "No matching characters" : "No characters yet"}
                </p>
                <p>
                  {searching
                    ? "Try a different name."
                    : "Add the people in this scene. The model plays everyone except you."}
                </p>
              </div>
            ) : (
              <ul className="lorebook-list">
                {visibleCharacters.map((character) => (
                  <CharacterRow
                    key={character.id}
                    character={character}
                    color={colorById[character.id]}
                    selected={pageMode === "entry" && character.id === editingId}
                    onSelect={() => selectCharacter(character)}
                    onToggleActive={() => toggleCharacterActive(character)}
                    busy={Boolean(togglingId)}
                  />
                ))}
              </ul>
            )}
          </aside>

          <div className={cx("lorebook-page-pane", pageOpen && "is-open")} aria-hidden={!wideLayout && !pageOpen}>
            {pageOpen ? (
              <CharacterPage
                key={editingId || "new"}
                draft={draft}
                editing={pageMode === "entry"}
                dirty={dirty}
                saving={saving}
                deleting={deletingId === editingId}
                error={error}
                wideLayout={wideLayout}
                onChange={updateDraft}
                onSubmit={saveCharacter}
                onDelete={deleteEditingCharacter}
                onDiscard={() => (pageMode === "entry" ? setDraft(savedDraft) : closePage())}
                onClose={closePage}
              />
            ) : (
              <div className="lorebook-page-empty">
                <p className="lorebook-page-empty-title">
                  {characters.length ? "Pick a character to read or edit them" : "Build your cast"}
                </p>
                <p>Everyone in the scene answers in their own bubble.</p>
                <button
                  type="button"
                  onClick={openNewCharacter}
                  className={cx("lorebook-secondary-button", CONTROL_MOTION)}
                >
                  <Plus size={15} />
                  Add a character
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
