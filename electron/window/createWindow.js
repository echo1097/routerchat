import { BrowserWindow } from "electron";

import { readSecret } from "../backend/apiSecret.js";
import { backendUrl, windowIcon } from "../config.js";
import { hideUntilRevealed } from "./revealApp.js";
import { secureWindow } from "./windowSecurity.js";

async function signIn(appWindow) {
  const secret = await readSecret();
  const formBody = new URLSearchParams({ secret }).toString();

  await appWindow.loadURL(`${backendUrl}/api/bootstrap`, {
    postData: [{ type: "rawData", bytes: Buffer.from(formBody) }],
    extraHeaders: "Content-Type: application/x-www-form-urlencoded",
  });
}

export function createWindow() {
  const appWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 520,
    title: "RouterChat",
    icon: windowIcon,
    backgroundColor: "#000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  secureWindow(appWindow);

  return appWindow;
}

export async function loadApp(appWindow) {
  const hidden = hideUntilRevealed(appWindow);

  await signIn(appWindow);

  return hidden;
}
