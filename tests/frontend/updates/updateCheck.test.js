import { describe, expect, it } from "vitest";

import { isNewerVersion } from "../../../frontend/src/updates/updateCheck.js";

describe("isNewerVersion", () => {
  it("spots a newer release", () => {
    expect(isNewerVersion("1.2.0", "1.1.7")).toBe(true);
    expect(isNewerVersion("v1.1.8", "1.1.7")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
  });

  it("ignores the same or an older release", () => {
    expect(isNewerVersion("1.1.7", "1.1.7")).toBe(false);
    expect(isNewerVersion("1.1.6", "1.1.7")).toBe(false);
    expect(isNewerVersion("1.1.10", "1.2.0")).toBe(false);
  });

  it("compares multi digit parts as numbers", () => {
    expect(isNewerVersion("1.1.10", "1.1.9")).toBe(true);
  });
});
