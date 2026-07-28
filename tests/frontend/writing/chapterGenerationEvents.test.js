import { describe, expect, it, vi } from "vitest";
import {
  chapterFromUpdateEvent,
  chapterGenerationErrorMessage,
  chapterGenerationEventMatchesRun,
  chapterRunTargetsOpenChapter,
  chapterUpdateMatchesRun,
} from "../../../frontend/src/writing/chapterGenerationEvents.js";
import { createSaveCoordinator } from "../../../frontend/src/writing/saveCoordinator.js";

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

  it("targets the open chapter even when the url carries no chapter id", () => {
    //the actual reason edits needed a reload: the guard compared run.chapterId against route.chapterId, which is null after autoload or a story switch, so the editor was never handed the new content
    const run = { runId: "run-1", storyId: "story-1", chapterId: "chapter-1" };

    expect(chapterRunTargetsOpenChapter(run, "story-1", "chapter-1")).toBe(true);
    expect(chapterRunTargetsOpenChapter(run, "story-1", "chapter-2")).toBe(false);
    expect(chapterRunTargetsOpenChapter(run, "story-2", "chapter-1")).toBe(false);
    expect(chapterRunTargetsOpenChapter(null, "story-1", "chapter-1")).toBe(false);
  });

  it("leaves the committed chapter visible instead of the draft it was generated from", () => {
    //the reported bug: edits landed, then the reconcile pass put the pre-generation draft back and only a reload fixed it
    const coordinator = createSaveCoordinator({ saveChapter: vi.fn() });
    const run = { runId: "run-1", storyId: "story-1", chapterId: "chapter-1", baseRevision: 4 };

    coordinator.rememberServerChapter({
      id: "chapter-1",
      story_id: "story-1",
      content: "what the writer typed",
      revision: 4,
    });
    coordinator.queueDraft("story-1", "chapter-1", "what the writer typed", 4);

    const event = {
      runId: "run-1",
      storyId: "story-1",
      chapterId: "chapter-1",
      revision: 5,
      value: {
        chapter: {
          id: "chapter-1",
          story_id: "story-1",
          content: "what the model edited",
          revision: 5,
        },
      },
    };
    expect(chapterUpdateMatchesRun(event, run)).toBe(true);

    //exactly what the chapter_updated handler does with the payload
    coordinator.rememberServerChapter(chapterFromUpdateEvent(event.value));

    expect(coordinator.getDraft("story-1", "chapter-1")).toBeNull();
    expect(coordinator.getConfirmedChapter("story-1", "chapter-1").content)
      .toBe("what the model edited");
  });
});
