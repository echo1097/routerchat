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

//pulls a closed "field": "value" out of a raw json fragment and decodes its escapes, only matches once the closing quote landed
function decodeClosedJsonString(rawFragment, fieldName) {
  const match = rawFragment.match(new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

//decodes however much of a json string value has arrived, the tail of a chunk can land mid escape sequence
function decodePartialJsonString(rawValue, complete) {
  let raw = rawValue;
  if (!complete && raw.endsWith("\\")) raw = raw.slice(0, -1);

  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    //shave the tail a char at a time until it decodes, a cut off \uXXXX needs more than one char off
    let salvage = raw;
    while (salvage.length) {
      salvage = salvage.slice(0, -1);
      try {
        return JSON.parse(`"${salvage}"`);
      } catch {
        //keep shaving
      }
    }
    return "";
  }
}

//edit mode streams one json object of {chapterRevision, edits:[...]} so the prose the model is writing is
//buried in newText, this walks the growing buffer the same brace and string aware way salvage_truncated_batch
//does on the backend but also reports the still open edit rather than only the finished ones
function parseStreamingEditPreview(rawText) {
  const text = String(rawText || "");
  const editsKey = text.indexOf('"edits"');
  if (editsKey === -1) return { completedCount: 0, current: null };
  const arrayStart = text.indexOf("[", editsKey);
  if (arrayStart === -1) return { completedCount: 0, current: null };

  let depth = 0;
  let inString = false;
  let escaped = false;
  let elementStart = null;
  let completedCount = 0;

  for (let index = arrayStart + 1; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) elementStart = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && elementStart !== null) {
        completedCount += 1;
        elementStart = null;
      }
    } else if (char === "]" && depth === 0) {
      elementStart = null;
      break;
    }
  }

  //an object still open at the end of the buffer is the edit being written right now
  if (elementStart === null) return { completedCount, current: null };
  const fragment = text.slice(elementStart);

  const operation = decodeClosedJsonString(fragment, "operation") || "";
  const anchor = ["anchorText", "blockId", "startAnchorText", "startBlockId"]
    .map((field) => decodeClosedJsonString(fragment, field))
    .find((value) => value) || "";

  const newTextKey = fragment.match(/"newText"\s*:\s*(\[)?/);
  if (!newTextKey) {
    return { completedCount, current: { operation, anchor, newText: "", newTextComplete: false } };
  }

  const isArray = Boolean(newTextKey[1]);
  const valueStart = newTextKey.index + newTextKey[0].length;
  const preview = isArray
    ? readStreamingParagraphArray(fragment, valueStart)
    : readStreamingJsonString(fragment, valueStart);

  return {
    completedCount,
    current: {
      operation,
      anchor,
      newText: preview.text,
      newTextComplete: preview.complete,
    },
  };
}

//reads however much of one json string has arrived, reporting where it ended so the caller can keep walking
function readStreamingJsonString(fragment, from) {
  const opening = fragment.slice(from).match(/^\s*"/);
  if (!opening) return { text: "", complete: false, end: from };

  let raw = "";
  let escaped = false;
  let cursor = from + opening[0].length;

  for (; cursor < fragment.length; cursor += 1) {
    const char = fragment[cursor];
    if (escaped) {
      raw += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      raw += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      return { text: decodePartialJsonString(raw, true), complete: true, end: cursor + 1 };
    }
    raw += char;
  }

  return { text: decodePartialJsonString(raw, false), complete: false, end: cursor };
}

//newText is an array of paragraphs now, so the preview rejoins the entries the same way the server will
function readStreamingParagraphArray(fragment, from) {
  const paragraphs = [];
  let cursor = from;

  while (cursor < fragment.length) {
    const entry = readStreamingJsonString(fragment, cursor);
    if (entry.text) paragraphs.push(entry.text);
    cursor = entry.end;

    if (!entry.complete) return { text: paragraphs.join("\n\n"), complete: false };

    const separator = fragment.slice(cursor).match(/^\s*,/);
    if (!separator) break;
    cursor += separator[0].length;
  }

  return {
    text: paragraphs.join("\n\n"),
    complete: /^\s*\]/.test(fragment.slice(cursor)),
  };
}

//folds a fresh parse into whatever is already on screen, an edit that has opened but not yet named itself
//must not blank the panel or it tears down and rebuilds between every edit in the batch
function nextEditPreview(current, parsed) {
  const next = parsed && parsed.current;
  if (!next || (!next.operation && !next.newText)) {
    return current ? { ...current, newTextComplete: true } : null;
  }
  return {
    editIndex: parsed.completedCount,
    operation: next.operation,
    anchor: next.anchor,
    newText: next.newText,
    newTextComplete: next.newTextComplete,
  };
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
  nextEditPreview,
  parseStreamingEditPreview,
};
