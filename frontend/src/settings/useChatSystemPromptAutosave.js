import { useState, useRef, useEffect } from "react";

const AUTOSAVE_DELAY_MS = 600;

const SAVED_FLASH_MS = 1400;

export function useChatSystemPromptAutosave({ value, onSave, active = true, resetKey }) {
  const [draft, setDraft] = useState(value || "");
  const [saveState, setSaveState] = useState("saved");
  const latestSavedRef = useRef(value || "");
  const draftRef = useRef(value || "");
  const saveTimeoutRef = useRef(null);
  const saveRunRef = useRef(0);
  const onSaveRef = useRef(onSave);

  onSaveRef.current = onSave;

  useEffect(() => {
    const nextValue = value || "";
    window.clearTimeout(saveTimeoutRef.current);
    setDraft(nextValue);
    draftRef.current = nextValue;
    latestSavedRef.current = nextValue;
    setSaveState("saved");
  }, [resetKey]);

  useEffect(() => {
    const nextValue = value || "";
    if (nextValue === latestSavedRef.current) return;
    if (draftRef.current !== latestSavedRef.current) return;
    setDraft(nextValue);
    draftRef.current = nextValue;
    latestSavedRef.current = nextValue;
    setSaveState("saved");
  }, [value]);

  useEffect(() => {
    if (active) return;
    flushSave();
  }, [active]);

  useEffect(() => {
    function handlePageHide() {
      flushSave();
    }

    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  async function savePrompt(nextValue, savedLabel = "saved") {
    if (!onSaveRef.current) return;
    if (nextValue === latestSavedRef.current) {
      setSaveState("saved");
      return;
    }

    const runId = saveRunRef.current + 1;
    saveRunRef.current = runId;
    setSaveState("saving");

    try {
      await onSaveRef.current(nextValue);
      if (runId !== saveRunRef.current) return;
      latestSavedRef.current = nextValue;
      if (draftRef.current !== nextValue) {
        setSaveState("unsaved");
        return;
      }
      setSaveState(savedLabel);
      window.setTimeout(() => {
        if (saveRunRef.current === runId && draftRef.current === latestSavedRef.current) {
          setSaveState("saved");
        }
      }, SAVED_FLASH_MS);
    } catch {
      if (runId === saveRunRef.current) {
        setSaveState("save failed");
      }
    }
  }

  function flushSave() {
    window.clearTimeout(saveTimeoutRef.current);
    if (draftRef.current === latestSavedRef.current) return;
    void savePrompt(draftRef.current, "saved");
  }

  function queueAutosave(nextValue) {
    window.clearTimeout(saveTimeoutRef.current);
    if (nextValue === latestSavedRef.current) {
      setSaveState("saved");
      return;
    }

    setSaveState("unsaved");
    saveTimeoutRef.current = window.setTimeout(() => {
      void savePrompt(draftRef.current, "autosaved");
    }, AUTOSAVE_DELAY_MS);
  }

  function updateDraft(nextValue) {
    setDraft(nextValue);
    draftRef.current = nextValue;
    queueAutosave(nextValue);
  }

  function saveNow() {
    window.clearTimeout(saveTimeoutRef.current);
    void savePrompt(draftRef.current, "saved");
  }

  const canSave = saveState !== "saving" && draft !== latestSavedRef.current;

  return { draft, saveState, canSave, updateDraft, saveNow };
}
