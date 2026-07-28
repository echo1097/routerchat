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

//the url legitimately carries a null chapterId in a few states, autoload and story switching among them, so the open chapter is the workspace's answer and never the route's
function chapterRunTargetsOpenChapter(run, openStoryId, openChapterId) {
  if (!run) return false;
  return openStoryId === run.storyId && openChapterId === run.chapterId;
}

export {
  chapterFromUpdateEvent,
  chapterRunTargetsOpenChapter,
  chapterGenerationErrorMessage,
  chapterGenerationEventMatchesRun,
  chapterUpdateMatchesRun,
};
