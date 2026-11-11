import { join } from "node:path";

import { app, ipcMain } from "electron";

import { isAppUrl } from "../window/windowSecurity.js";
import { readDesktopSettings, saveDesktopSetting } from "./desktopSettings.js";

function desktopSettingsFile() {
  return join(app.getPath("userData"), "desktopSettings.json");
}

function requireAppPage(event) {
  if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) {
    throw new Error("Only RouterChat can change desktop settings.");
  }
}

export function isStartupSoundMuted() {
  return readDesktopSettings(desktopSettingsFile()).startupSoundMuted === true;
}

export function registerSettingsBridge() {
  ipcMain.handle("desktop:getStartupSoundMuted", (event) => {
    requireAppPage(event);

    return isStartupSoundMuted();
  });

  ipcMain.handle("desktop:setStartupSoundMuted", (event, muted) => {
    requireAppPage(event);
    saveDesktopSetting(desktopSettingsFile(), "startupSoundMuted", muted === true);

    return muted === true;
  });
}
