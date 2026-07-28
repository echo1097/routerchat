import { describe, expect, it, vi } from "vitest";
import {
  chapterAppliedEditSummary,
  chapterFromUpdateEvent,
  chapterGenerationErrorIsRepairable,
  chapterGenerationErrorMessage,
  chapterGenerationEventMatchesRun,
  chapterRepairContext,
  chapterRunTargetsOpenChapter,
  chapterUpdateMatchesRun,
} from "../../../frontend/src/writing/chapterGenerationEvents.js";
import { createSaveCoordinator } from "../../../frontend/src/writing/saveCoordinator.js";

describe("chapter generation events", () => {
  it("uses the right agreement for applied edit counts", () => {
    expect(chapterAppliedEditSummary(1)).toBe("1 edit was applied and has been kept");
    expect(chapterAppliedEditSummary(2)).toBe("2 edits were applied and have been kept");
    expect(chapterAppliedEditSummary(1, 1)).toBe("1 of 2 edits was applied and has been kept");
    expect(chapterAppliedEditSummary(2, 1)).toBe("2 of 3 edits were applied and have been kept");
  });

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

  it("offers a repair only when the backend said it can be repaired", () => {
    //the backend clears this on a repair run, which is the only thing stopping the offer from looping
    expect(chapterGenerationErrorIsRepairable({ code: "chapter_edit_truncated", repairable: true })).toBe(true);
    expect(chapterGenerationErrorIsRepairable({ code: "chapter_edit_truncated", repairable: false })).toBe(false);
    expect(chapterGenerationErrorIsRepairable({ code: "chapter_revision_conflict" })).toBe(false);
    expect(chapterGenerationErrorIsRepairable("network error")).toBe(false);
    expect(chapterGenerationErrorIsRepairable(null)).toBe(false);
  });

  it("builds a repair context out of the rejected edits", () => {
    const value = {
      rejected: [
        {
          index: 1,
          code: "chapter_edit_target_mismatch",
          message: "anchorText does not match p_002",
          operation: { operation: "replaceBlock", newText: "the prose it already wrote" },
        },
      ],
    };

    expect(chapterRepairContext(value, "{raw output}", 3)).toEqual({
      previous_output: "{raw output}",
      errors: ["anchorText does not match p_002"],
      failed_edits: [{ operation: "replaceBlock", newText: "the prose it already wrote" }],
      applied_count: 3,
    });
  });

  it("falls back to the error message when nothing was itemised", () => {
    const context = chapterRepairContext({ code: "chapter_edit_truncated", message: "cut off" }, "partial", 0);

    expect(context.errors).toEqual(["cut off"]);
    expect(context.failed_edits).toEqual([]);
    expect(context.applied_count).toBe(0);
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
