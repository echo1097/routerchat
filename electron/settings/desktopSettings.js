import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readDesktopSettings(settingsFile) {
  try {
    const saved = JSON.parse(readFileSync(settingsFile, "utf8"));
    const isPlainObject = saved !== null && typeof saved === "object" && !Array.isArray(saved);

    return isPlainObject ? saved : {};
  } catch {
    return {};
  }
}

export function saveDesktopSetting(settingsFile, name, value) {
  const settings = { ...readDesktopSettings(settingsFile), [name]: value };

  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  return settings;
}
