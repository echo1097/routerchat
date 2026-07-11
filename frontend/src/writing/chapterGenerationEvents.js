function chapterFromUpdateEvent(value) {
  const chapter = value?.chapter;
  if (!chapter || typeof chapter !== "object" || !chapter.id) return null;
  return chapter;
}

function chapterGenerationErrorMessage(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (value?.message) return String(value.message);
  if (value?.code) return String(value.code);
  return "Story generation failed";
}

function chapterGenerationEventMatchesRun(event, run) {
  if (!event || !run) return false;
  return event.runId === run.runId
    && event.storyId === run.storyId
    && event.chapterId === run.chapterId;
}

function chapterUpdateMatchesRun(event, run) {
  if (!chapterGenerationEventMatchesRun(event, run)) return false;
  const chapter = chapterFromUpdateEvent(event.value);
  if (!chapter || chapter.id !== run.chapterId) return false;
  const revision = Number(event.revision ?? chapter.revision);
  return Number.isInteger(revision) && revision === run.baseRevision + 1;
}

export {
  chapterFromUpdateEvent,
  chapterGenerationErrorMessage,
  chapterGenerationEventMatchesRun,
  chapterUpdateMatchesRun,
};
