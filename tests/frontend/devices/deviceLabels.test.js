import { describe, expect, it } from "vitest";

import {
  countdownLabel,
  lastUsedLabel,
  plainAddress,
  spacedCode,
} from "../../../frontend/src/devices/deviceLabels.js";

const now = Date.parse("2026-11-11T12:00:00Z");


describe("lastUsedLabel", () => {
  it("describes how long ago a phone was used", () => {
    expect(lastUsedLabel("2026-11-11T09:00:00+00:00", now)).toBe("Used today");
    expect(lastUsedLabel("2026-11-10T09:00:00+00:00", now)).toBe("Used yesterday");
    expect(lastUsedLabel("2026-11-01T12:00:00+00:00", now)).toBe("Used 10 days ago");
  });

  it("stays blank for a bad date and never goes negative", () => {
    expect(lastUsedLabel("nonsense", now)).toBe("");
    expect(lastUsedLabel("2026-11-12T12:00:00+00:00", now)).toBe("Used today");
  });
});


describe("countdownLabel", () => {
  it("formats the time left on a pairing code", () => {
    expect(countdownLabel(120)).toBe("2:00");
    expect(countdownLabel(64.2)).toBe("1:05");
    expect(countdownLabel(9)).toBe("0:09");
    expect(countdownLabel(-5)).toBe("0:00");
  });
});


describe("code and address formatting", () => {
  it("splits the code into two groups", () => {
    expect(spacedCode("ABCD2345")).toBe("ABCD 2345");
  });

  it("drops the scheme from the address", () => {
    expect(plainAddress("http://192.168.1.20:8000")).toBe("192.168.1.20:8000");
    expect(plainAddress(null)).toBe("");
  });
});
