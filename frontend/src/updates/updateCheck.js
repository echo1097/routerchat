import { useSyncExternalStore } from "react";
import { APP_VERSION } from "../appInfo.js";

const GITHUB_RELEASES_LATEST_URL = "https://api.github.com/repos/echo1097/routerchat/releases/latest";

let availableUpdate = null;
let checkStarted = false;
const listeners = new Set();

function setAvailableUpdate(next) {
  availableUpdate = next;
  listeners.forEach((listener) => listener());
}

function versionParts(version) {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewerVersion(latestVersion, currentVersion) {
  const latestParts = versionParts(latestVersion);
  const currentParts = versionParts(currentVersion);

  for (let index = 0; index < 3; index += 1) {
    if (latestParts[index] > currentParts[index]) return true;
    if (latestParts[index] < currentParts[index]) return false;
  }

  return false;
}

export function checkForUpdate() {
  if (checkStarted) return;
  checkStarted = true;

  fetch(GITHUB_RELEASES_LATEST_URL, {
    headers: { Accept: "application/vnd.github+json" },
  })
    .then((response) => {
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      return response.json();
    })
    .then((release) => {
      if (!checkStarted) return;
      const latestVersion = String(release?.tag_name || "").replace(/^v/i, "");
      if (!latestVersion || !isNewerVersion(latestVersion, APP_VERSION)) return;
      setAvailableUpdate({ version: latestVersion, url: release.html_url });
    })
    .catch(() => {
      checkStarted = false;
    });
}

export function clearUpdateCheck() {
  checkStarted = false;
  setAvailableUpdate(null);
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return availableUpdate;
}

export function useAvailableUpdate() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
