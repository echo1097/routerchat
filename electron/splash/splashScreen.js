import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { WebContentsView } from "electron";

import { electronDir } from "../config.js";

const splashFile = join(electronDir, "splash", "splash.html");
const leaveTime = 380;
const soundTailTime = 1600;

let splashView = null;

function fitSplash(appWindow) {
  const [width, height] = appWindow.getContentSize();

  splashView.setBounds({ x: 0, y: 0, width, height });
}

function runInSplash(script) {
  if (!splashView || splashView.webContents.isDestroyed()) {
    return Promise.resolve();
  }

  return splashView.webContents.executeJavaScript(script).catch(() => {});
}

function closeAfterSound(finishedView) {
  setTimeout(() => {
    if (!finishedView.webContents.isDestroyed()) {
      finishedView.webContents.close();
    }
  }, soundTailTime);
}

export async function showSplash(appWindow, soundMuted) {
  splashView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  splashView.setBackgroundColor("#000000");
  appWindow.contentView.addChildView(splashView);

  fitSplash(appWindow);
  appWindow.on("resize", () => {
    if (splashView) fitSplash(appWindow);
  });

  await splashView.webContents.loadFile(splashFile, {
    query: { sound: soundMuted ? "off" : "on" },
  });
}

export function setSplashStatus(text, progress = null) {
  return runInSplash(`window.setStatus(${JSON.stringify(text)}, ${JSON.stringify(progress)})`);
}

export async function hideSplash(appWindow) {
  await runInSplash("window.leaveSplash()");
  await sleep(leaveTime);

  if (!splashView) {
    return;
  }

  if (!appWindow.isDestroyed()) {
    appWindow.contentView.removeChildView(splashView);
  }

  closeAfterSound(splashView);
  splashView = null;
}
