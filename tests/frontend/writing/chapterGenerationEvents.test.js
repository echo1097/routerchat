import { describe, expect, it } from "vitest";
import {
  chapterFromUpdateEvent,
  chapterGenerationErrorMessage,
  chapterGenerationEventMatchesRun,
  chapterUpdateMatchesRun,
} from "../../../frontend/src/writing/chapterGenerationEvents.js";

describe("chapter generation events", () => {
  it("reads the complete chapter from a canonical update event", () => {
    const chapter = {
      id: "chapter",
      content: "updated",
      revision: 4,
    };

    expect(chapterFromUpdateEvent({ chapter })).toEqual(chapter);
    expect(chapterFromUpdateEvent({ content: "legacy shape" })).toBeNull();
  });

  it("formats structured and string errors", () => {
    expect(chapterGenerationErrorMessage({
      code: "chapter_edit_target_mismatch",
      message: "target changed",
    })).toBe("target changed");
    expect(chapterGenerationErrorMessage({ code: "chapter_edit_invalid_json" }))
      .toBe("chapter_edit_invalid_json");
    expect(chapterGenerationErrorMessage("network error")).toBe("network error");
    expect(chapterGenerationErrorMessage(null)).toBe("Story generation failed");
  });

  it("accepts only events for the active target and next revision", () => {
    const run = {
      runId: "run-1",
      storyId: "story-1",
      chapterId: "chapter-1",
      baseRevision: 4,
    };
    const event = {
      runId: "run-1",
      storyId: "story-1",
      chapterId: "chapter-1",
      revision: 5,
      value: { chapter: { id: "chapter-1", revision: 5, content: "updated" } },
    };

    expect(chapterGenerationEventMatchesRun(event, run)).toBe(true);
    expect(chapterUpdateMatchesRun(event, run)).toBe(true);
    expect(chapterGenerationEventMatchesRun({ ...event, storyId: "other" }, run)).toBe(false);
    expect(chapterGenerationEventMatchesRun({ ...event, runId: "stale" }, run)).toBe(false);
    expect(chapterUpdateMatchesRun({ ...event, revision: 6 }, run)).toBe(false);
    expect(chapterUpdateMatchesRun({ ...event, value: { chapter: { id: "other", revision: 5 } } }, run)).toBe(false);
  });
});
