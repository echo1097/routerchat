import { describe, expect, it } from "vitest";
import { excerptParagraphs, formatEditedAgo, storyMetaLine } from "../../../frontend/src/writing/landingFormatting.js";

const now = Date.parse("2026-10-26T12:00:00Z");

describe("formatEditedAgo", () => {
  it("says just now for the last minute", () => {
    expect(formatEditedAgo("2026-10-26T11:59:30Z", now)).toBe("Edited just now");
  });

  it("uses minutes, hours and days for recent edits", () => {
    expect(formatEditedAgo("2026-10-26T11:45:00Z", now)).toBe("Edited 15 minutes ago");
    expect(formatEditedAgo("2026-10-26T09:00:00Z", now)).toBe("Edited 3 hours ago");
    expect(formatEditedAgo("2026-10-25T09:00:00Z", now)).toBe("Edited yesterday");
  });

  it("falls back to a date for older edits", () => {
    expect(formatEditedAgo("2026-09-02T09:00:00Z", now)).toMatch(/^Edited .*2/);
    expect(formatEditedAgo("2024-03-04T09:00:00Z", now)).toMatch(/2024/);
  });

  it("returns nothing for a missing timestamp", () => {
    expect(formatEditedAgo("", now)).toBe("");
    expect(formatEditedAgo(undefined, now)).toBe("");
  });
});

describe("storyMetaLine", () => {
  it("joins chapter and word counts", () => {
    expect(storyMetaLine({ chapter_count: 3, word_count: 12480 })).toBe(`3 chapters · ${(12480).toLocaleString()} words`);
  });

  it("uses singular labels and skips zeros", () => {
    expect(storyMetaLine({ chapter_count: 1, word_count: 0 })).toBe("1 chapter");
    expect(storyMetaLine({ chapter_count: 0, word_count: 0 })).toBe("");
  });

  it("stays empty when the backend sends no counts", () => {
    expect(storyMetaLine({ title: "Old backend" })).toBe("");
  });
});

describe("excerptParagraphs", () => {
  it("splits on blank lines and drops empty pieces", () => {
    expect(excerptParagraphs("First.\n\n  Second.  \n\n\n")).toEqual(["First.", "Second."]);
    expect(excerptParagraphs(null)).toEqual([]);
  });
});
