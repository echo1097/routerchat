import { describe, expect, it } from "vitest";

import { readPhoneStatus } from "../../../frontend/src/devices/devicesApi.js";


describe("readPhoneStatus", () => {
  it("passes a real status through unchanged", () => {
    const status = { enabled: true, running: true, devices: [{ id: "a", name: "Phone" }] };

    expect(readPhoneStatus(status)).toBe(status);
  });

  it("rejects a reply that has no device list", () => {
    expect(() => readPhoneStatus({})).toThrow("Phone access settings could not be loaded");
    expect(() => readPhoneStatus(null)).toThrow();
    expect(() => readPhoneStatus({ devices: "nope" })).toThrow();
  });
});
