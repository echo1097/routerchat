import { describe, expect, it } from "vitest";

import {
  effectiveThinkingEnabled,
  modelMetadata,
  requiresThinking,
  supportsThinking,
} from "../../frontend/src/modelReasoning.js";

const models = [
  {
    id: "test/mandatory",
    supported_parameters: ["reasoning"],
    reasoning: { mandatory: true },
  },
  {
    id: "test/optional",
    supported_parameters: ["reasoning"],
    reasoning: { mandatory: false },
  },
  {
    id: "test/instant",
    supported_parameters: [],
  },
];

describe("model reasoning metadata", () => {
  it("recognizes mandatory reasoning and keeps it effectively enabled", () => {
    expect(requiresThinking(models, "test/mandatory")).toBe(true);
    expect(effectiveThinkingEnabled(models, "test/mandatory", false)).toBe(true);
  });

  it("preserves the user preference for optional reasoning", () => {
    expect(effectiveThinkingEnabled(models, "test/optional", false)).toBe(false);
    expect(effectiveThinkingEnabled(models, "test/optional", true)).toBe(true);
  });

  it("normalizes nitro variants when finding capabilities", () => {
    expect(modelMetadata(models, "test/mandatory:nitro")?.id).toBe("test/mandatory");
    expect(supportsThinking(models, "test/mandatory:nitro")).toBe(true);
  });

  it("does not infer reasoning support when metadata is absent", () => {
    expect(supportsThinking(models, "test/instant")).toBe(false);
    expect(requiresThinking(models, "test/instant")).toBe(false);
  });
});
