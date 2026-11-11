import { describe, expect, it } from "vitest";

import { phoneHelpTopics } from "../../../frontend/src/devices/phoneHelp.js";


describe("phoneHelpTopics", () => {
  it("explains the Android permission that blocks Chrome", () => {
    const topic = phoneHelpTopics.find((entry) => entry.title.includes("Android"));
    const text = topic.steps.join(" ");

    expect(text).toContain("Nearby devices");
    expect(text).toContain("Local network");
    expect(text).toContain("Permissions");
  });

  it("gives every topic a title and at least one step", () => {
    expect(phoneHelpTopics.length).toBeGreaterThan(0);

    for (const topic of phoneHelpTopics) {
      expect(topic.title.trim()).not.toBe("");
      expect(topic.steps.length).toBeGreaterThan(0);
    }
  });

  it("has no repeated titles", () => {
    const titles = phoneHelpTopics.map((topic) => topic.title);

    expect(new Set(titles).size).toBe(titles.length);
  });
});
