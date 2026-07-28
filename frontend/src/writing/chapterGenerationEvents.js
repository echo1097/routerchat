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

function chapterAppliedEditSummary(appliedCount, skippedCount = 0) {
  const subject = skippedCount
    ? `${appliedCount} of ${appliedCount + skippedCount} edits`
    : `${appliedCount} ${appliedCount === 1 ? "edit" : "edits"}`;
  const agreement = appliedCount === 1
    ? "was applied and has been kept"
    : "were applied and have been kept";

  return `${subject} ${agreement}`;
}

//only the backend decides this, a repair run never comes back marked repairable so the offer can never loop
function chapterGenerationErrorIsRepairable(value) {
  return Boolean(value && typeof value === "object" && value.repairable);
}

//what the repair turn needs to describe the failure back to the model
function chapterRepairContext(value, previousOutput, appliedCount = 0) {
  const rejected = Array.isArray(value?.rejected) ? value.rejected : [];
  const errors = rejected.length
    ? rejected.map((item) => String(item?.message || item?.code || "an edit could not be applied"))
    : [chapterGenerationErrorMessage(value)];

  return {
    previous_output: String(previousOutput || ""),
    errors,
    failed_edits: rejected.map((item) => item?.operation).filter(Boolean),
    applied_count: appliedCount,
  };
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
  chapterAppliedEditSummary,
  chapterFromUpdateEvent,
  chapterRunTargetsOpenChapter,
  chapterGenerationErrorIsRepairable,
  chapterGenerationErrorMessage,
  chapterGenerationEventMatchesRun,
  chapterRepairContext,
  chapterUpdateMatchesRun,
};
