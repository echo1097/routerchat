import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDesktopSettings, saveDesktopSetting } from "../../../electron/settings/desktopSettings.js";

describe("desktop settings file", () => {
  let folder;
  let settingsFile;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "routerchat-desktop-"));
    settingsFile = join(folder, "nested", "desktopSettings.json");
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it("reads nothing when the file does not exist", () => {
    expect(readDesktopSettings(settingsFile)).toEqual({});
  });

  it("saves a setting and reads it back", () => {
    saveDesktopSetting(settingsFile, "startupSoundMuted", true);

    expect(readDesktopSettings(settingsFile)).toEqual({ startupSoundMuted: true });
  });

  it("keeps other settings when one changes", () => {
    saveDesktopSetting(settingsFile, "startupSoundMuted", true);
    saveDesktopSetting(settingsFile, "somethingElse", 3);
    saveDesktopSetting(settingsFile, "startupSoundMuted", false);

    expect(readDesktopSettings(settingsFile)).toEqual({ startupSoundMuted: false, somethingElse: 3 });
  });

  it("ignores a broken or unexpected file", () => {
    saveDesktopSetting(settingsFile, "startupSoundMuted", true);

    writeFileSync(settingsFile, "not json");
    expect(readDesktopSettings(settingsFile)).toEqual({});

    writeFileSync(settingsFile, "[1, 2]");
    expect(readDesktopSettings(settingsFile)).toEqual({});
  });
});
