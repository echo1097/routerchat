const DEFAULT_DEBOUNCE_MS = 600;

function makeKey(storyId, chapterId) {
  return `${storyId}/${chapterId}`;
}

function isConflictError(error) {
  return error?.code === "chapter_revision_conflict"
    || error?.payload?.detail?.code === "chapter_revision_conflict"
    || error?.payload?.code === "chapter_revision_conflict"
    || error?.status === 409;
}

function conflictError(entry, error) {
  if (error instanceof Error) return error;

  const nextError = new Error("Chapter changed on the server.");
  nextError.code = "chapter_revision_conflict";
  nextError.payload = error;
  return nextError;
}

function snapshotEntry(entry) {
  return {
    storyId: entry.storyId,
    chapterId: entry.chapterId,
    state: entry.state,
    draft: entry.localDraft ? { ...entry.localDraft } : null,
    confirmedChapter: entry.confirmedChapter,
    queued: entry.queuedDraft ? { ...entry.queuedDraft } : null,
    inFlight: entry.inFlight
      ? { ...entry.inFlight.request }
      : null,
    error: entry.error || null,
  };
}

export function createSaveCoordinator({
  saveChapter,
  onStateChange = () => {},
  debounceMs = DEFAULT_DEBOUNCE_MS,
} = {}) {
  if (typeof saveChapter !== "function") {
    throw new TypeError("saveChapter must be a function");
  }

  const entries = new Map();
  let isDisposed = false;

  function ensureEntry(storyId, chapterId) {
    const key = makeKey(storyId, chapterId);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        storyId,
        chapterId,
        state: "saved",
        localDraft: null,
        confirmedChapter: null,
        queuedDraft: null,
        inFlight: null,
        timer: null,
        sequence: 0,
        error: null,
      };
      entries.set(key, entry);
    }
    return entry;
  }

  function emit(entry) {
    onStateChange(snapshotEntry(entry));
  }

  function clearTimer(entry) {
    if (entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  function scheduleEntry(entry) {
    clearTimer(entry);
    if (!entry.queuedDraft || entry.state === "conflict") return;

    entry.timer = setTimeout(() => {
      entry.timer = null;
      void startSave(entry).catch(() => {});
    }, debounceMs);
  }

  async function startSave(entry) {
    if (isDisposed) throw new Error("Save coordinator is disposed.");
    if (entry.inFlight) return entry.inFlight.promise;
    if (!entry.queuedDraft) return entry.confirmedChapter;
    if (entry.state === "conflict") throw entry.error;

    const request = { ...entry.queuedDraft };
    entry.queuedDraft = null;
    entry.inFlight = { request, promise: null };
    entry.state = "saving";
    entry.error = null;
    emit(entry);

    const promise = (async () => {
      try {
        const savedChapter = await saveChapter({
          storyId: entry.storyId,
          chapterId: entry.chapterId,
          content: request.content,
          revision: request.baseRevision,
        });

        entry.confirmedChapter = savedChapter;
        entry.error = null;
        entry.inFlight = null;

        if (entry.queuedDraft) {
          if (entry.localDraft) entry.localDraft.baseRevision = savedChapter.revision;
          entry.queuedDraft = {
            ...entry.queuedDraft,
            baseRevision: savedChapter.revision,
          };
          entry.state = "queued";
          emit(entry);
          return startSave(entry);
        }

        if (entry.localDraft?.content === request.content) {
          entry.localDraft = null;
        }
        entry.state = "saved";
        emit(entry);
        return savedChapter;
      } catch (error) {
        entry.inFlight = null;

        if (isConflictError(error)) {
          const nextError = conflictError(entry, error);
          const serverChapter = error?.chapter
            || error?.payload?.detail?.chapter
            || error?.payload?.chapter;
          if (serverChapter) entry.confirmedChapter = serverChapter;
          entry.error = nextError;
          entry.state = "conflict";
        } else {
          entry.queuedDraft = entry.queuedDraft || request;
          entry.error = error;
          entry.state = "failed";
        }

        emit(entry);
        throw error;
      }
    })();

    entry.inFlight.promise = promise;
    return promise;
  }

  async function flushEntry(entry) {
    clearTimer(entry);
    if (entry.state === "conflict") throw entry.error;
    if (entry.state === "failed" && !entry.inFlight) throw entry.error;

    while (entry.inFlight || entry.queuedDraft) {
      if (entry.state === "conflict") throw entry.error;
      if (entry.inFlight) {
        await entry.inFlight.promise;
      } else {
        await startSave(entry);
      }
    }

    if (entry.state === "failed") throw entry.error;
    return entry.confirmedChapter;
  }

  function targetEntries(storyId, chapterId) {
    if (storyId && chapterId) {
      const entry = entries.get(makeKey(storyId, chapterId));
      return entry ? [entry] : [];
    }

    if (storyId) {
      return [...entries.values()].filter((entry) => entry.storyId === storyId);
    }

    return [...entries.values()];
  }

  function assertUsable() {
    if (isDisposed) throw new Error("Save coordinator is disposed.");
  }

  return {
    queueDraft(storyId, chapterId, content, baseRevision = 0) {
      assertUsable();
      const entry = ensureEntry(storyId, chapterId);
      const draft = {
        content,
        baseRevision,
        sequence: entry.sequence + 1,
      };
      entry.sequence = draft.sequence;
      entry.localDraft = { content, baseRevision };
      entry.queuedDraft = draft;
      if (entry.state !== "conflict") {
        entry.error = null;
        entry.state = "queued";
      }
      scheduleEntry(entry);
      emit(entry);
      return snapshotEntry(entry);
    },

    schedule(storyId, chapterId) {
      assertUsable();
      const entry = ensureEntry(storyId, chapterId);
      scheduleEntry(entry);
      emit(entry);
    },

    async flush(storyId, chapterId) {
      assertUsable();
      const results = [];
      for (const entry of targetEntries(storyId, chapterId)) {
        results.push(await flushEntry(entry));
      }
      return storyId && chapterId ? results[0] || null : results;
    },

    async retry(storyId, chapterId) {
      assertUsable();
      const entry = ensureEntry(storyId, chapterId);
      if (entry.state === "conflict") throw entry.error;
      if (!entry.queuedDraft && entry.localDraft) {
        entry.queuedDraft = {
          ...entry.localDraft,
          sequence: entry.sequence + 1,
        };
        entry.sequence += 1;
      }
      if (!entry.queuedDraft) return entry.confirmedChapter;
      entry.state = "queued";
      entry.error = null;
      emit(entry);
      return flushEntry(entry);
    },

    cancelTimer(storyId, chapterId) {
      const entry = entries.get(makeKey(storyId, chapterId));
      if (entry) clearTimer(entry);
    },

    rememberServerChapter(chapter) {
      if (!chapter?.story_id || !chapter?.id) return chapter;
      const entry = ensureEntry(chapter.story_id, chapter.id);
      if (
        !entry.confirmedChapter
        || Number(chapter.revision) >= Number(entry.confirmedChapter.revision)
      ) {
        entry.confirmedChapter = chapter;
        emit(entry);
      }
      return entry.confirmedChapter;
    },

    getState(storyId, chapterId) {
      const entry = entries.get(makeKey(storyId, chapterId));
      return entry ? snapshotEntry(entry) : null;
    },

    getDraft(storyId, chapterId) {
      const draft = entries.get(makeKey(storyId, chapterId))?.localDraft;
      return draft ? draft.content : null;
    },

    getConfirmedChapter(storyId, chapterId) {
      return entries.get(makeKey(storyId, chapterId))?.confirmedChapter || null;
    },

    getPendingDrafts() {
      return [...entries.values()]
        .filter((entry) => entry.localDraft && (entry.queuedDraft || entry.inFlight))
        .map((entry) => ({
          storyId: entry.storyId,
          chapterId: entry.chapterId,
          content: entry.localDraft.content,
          baseRevision: entry.localDraft.baseRevision,
        }));
    },

    dispose({ abandon = false } = {}) {
      const hasPendingWork = [...entries.values()].some(
        (entry) => entry.queuedDraft || entry.inFlight,
      );
      if (hasPendingWork && !abandon) return false;

      for (const entry of entries.values()) clearTimer(entry);
      isDisposed = true;
      if (abandon) entries.clear();
      return true;
    },
  };
}

export { makeKey as chapterSaveKey };
