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

//a draft only speaks for the chapter while the server has not moved past the revision it was typed against
function draftIsCurrent(entry) {
  if (!entry.localDraft) return false;
  //its own save is on the wire and about to move the revision, so it stays the truth until that lands
  if (entry.inFlight) return true;
  if (!entry.confirmedChapter) return true;
  return Number(entry.localDraft.baseRevision) >= Number(entry.confirmedChapter.revision);
}

function snapshotEntry(entry) {
  return {
    storyId: entry.storyId,
    chapterId: entry.chapterId,
    state: entry.state,
    draft: draftIsCurrent(entry) ? { ...entry.localDraft } : null,
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
        supersededDraft: null,
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

  //the server already carries whatever this draft was based on, so it stops being the truth. kept on the side rather than dropped so nobody's words are actually destroyed
  function retireDraft(entry) {
    if (!entry.localDraft) return;
    clearTimer(entry);
    entry.supersededDraft = entry.localDraft;
    entry.localDraft = null;
    entry.queuedDraft = null;
    entry.error = null;
    entry.state = "saved";
  }

  function scheduleEntry(entry) {
    clearTimer(entry);
    if (!entry.queuedDraft) return;

    entry.timer = setTimeout(() => {
      entry.timer = null;
      void startSave(entry).catch(() => {});
    }, debounceMs);
  }

  async function startSave(entry) {
    if (isDisposed) throw new Error("Save coordinator is disposed.");
    if (entry.inFlight) return entry.inFlight.promise;
    if (!entry.queuedDraft) return entry.confirmedChapter;

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

        //our own save just moved the revision, so carry the live draft forward with it or it would look stale against the chapter it created
        if (entry.localDraft) entry.localDraft.baseRevision = savedChapter.revision;

        if (entry.queuedDraft) {
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
          //a 409 means the server moved on without us, so retiring beats re-queueing, which would save this stale text right back over whatever moved it
          entry.localDraft = entry.localDraft || { ...request };
          retireDraft(entry);
          emit(entry);
          throw nextError;
        }

        entry.queuedDraft = entry.queuedDraft || request;
        entry.error = error;
        entry.state = "failed";
        emit(entry);
        throw error;
      }
    })();

    entry.inFlight.promise = promise;
    return promise;
  }

  async function flushEntry(entry) {
    clearTimer(entry);
    if (entry.state === "failed" && !entry.inFlight) throw entry.error;

    while (entry.inFlight || entry.queuedDraft) {
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
      entry.error = null;
      entry.state = "queued";
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
        if (!draftIsCurrent(entry)) retireDraft(entry);
        emit(entry);
      }
      return entry.confirmedChapter;
    },

    getState(storyId, chapterId) {
      const entry = entries.get(makeKey(storyId, chapterId));
      return entry ? snapshotEntry(entry) : null;
    },

    getDraft(storyId, chapterId) {
      const entry = entries.get(makeKey(storyId, chapterId));
      return entry && draftIsCurrent(entry) ? entry.localDraft.content : null;
    },

    getConfirmedChapter(storyId, chapterId) {
      return entries.get(makeKey(storyId, chapterId))?.confirmedChapter || null;
    },

    getPendingDrafts() {
      return [...entries.values()]
        .filter((entry) => draftIsCurrent(entry) && (entry.queuedDraft || entry.inFlight))
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
