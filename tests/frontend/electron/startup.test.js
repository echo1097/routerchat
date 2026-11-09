import { afterEach, describe, expect, it, vi } from "vitest";

import { readBackendPort } from "../../../electron/config.js";
import { readLogStatus } from "../../../electron/splash/logStatus.js";

describe("readLogStatus", () => {
  it("strips the log level and maps startup milestones to progress", () => {
    expect(readLogStatus("INFO:     Started server process [123]")).toEqual({
      text: "Started server process [123]",
      progress: 40,
    });

    expect(readLogStatus("INFO:     Application startup complete.").progress).toBe(75);
    expect(readLogStatus("INFO:     Uvicorn running on http://127.0.0.1:8137").progress).toBe(88);
  });

  it("shows other lines without moving the progress bar", () => {
    expect(readLogStatus("WARNING:  something else happened")).toEqual({
      text: "something else happened",
      progress: null,
    });
  });

  it("ignores empty lines and health checks", () => {
    expect(readLogStatus("   ")).toBeNull();
    expect(readLogStatus('INFO:     127.0.0.1:5000 - "GET /api/health HTTP/1.1" 200 OK')).toBeNull();
  });
});

describe("readBackendPort", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the default port when nothing is set", () => {
    vi.stubEnv("ROUTERCHAT_ELECTRON_PORT", "");

    expect(readBackendPort()).toBe(8137);
  });

  it("uses a valid configured port", () => {
    vi.stubEnv("ROUTERCHAT_ELECTRON_PORT", "8138");

    expect(readBackendPort()).toBe(8138);
  });

  it.each(["80", "70000", "8137.5", "abc"])("rejects %s", (value) => {
    vi.stubEnv("ROUTERCHAT_ELECTRON_PORT", value);

    expect(() => readBackendPort()).toThrow("ROUTERCHAT_ELECTRON_PORT");
  });
});
