import { setTimeout as sleep } from "node:timers/promises";

import { app, dialog } from "electron";

import { killBackendNow, startBackend, stopBackend } from "./backend/backendProcess.js";
import { windowIcon } from "./config.js";
import { readLogStatus } from "./splash/logStatus.js";
import { hideSplash, setSplashStatus, showSplash } from "./splash/splashScreen.js";
import { createWindow, loadApp } from "./window/createWindow.js";
import { revealApp, waitForStartupReady } from "./window/revealApp.js";

const minimumSplashTime = 900;

let appWindow = null;
let backendStopped = false;
let startingUp = true;

function focusWindow() {
  if (!appWindow || appWindow.isDestroyed()) {
    return;
  }

  if (appWindow.isMinimized()) {
    appWindow.restore();
  }

  appWindow.focus();
}

function showBackendLog(line) {
  if (!startingUp) {
    return;
  }

  const status = readLogStatus(line);

  if (status) {
    setSplashStatus(status.text, status.progress);
  }
}

function watchBackend(backend) {
  backend.once("exit", () => {
    if (!backendStopped) {
      dialog.showErrorBox("RouterChat", "The RouterChat backend stopped unexpectedly.");
      app.quit();
    }
  });
}

async function launch() {
  if (process.platform === "darwin") {
    app.dock.setIcon(windowIcon);
  }

  try {
    appWindow = createWindow();
    await showSplash(appWindow);

    const splashShown = sleep(minimumSplashTime);
    setSplashStatus("Starting RouterChat", 12);

    watchBackend(await startBackend(showBackendLog));
    startingUp = false;

    setSplashStatus("Signing in", 92);
    const hiddenStyleKey = await loadApp(appWindow);

    setSplashStatus("Verifying API keys", 96);
    const keysChecked = await waitForStartupReady(appWindow);
    await splashShown;

    setSplashStatus(keysChecked ? "Ready" : "Could not verify API keys, opening anyway", 100);
    await hideSplash(appWindow);
    await revealApp(appWindow, hiddenStyleKey);
  } catch (error) {
    if (appWindow && appWindow.isDestroyed()) {
      return;
    }

    dialog.showErrorBox("RouterChat could not start", error.message);
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("RouterChat");
  app.on("second-instance", focusWindow);
  app.on("window-all-closed", () => app.quit());

  app.on("will-quit", (event) => {
    if (backendStopped) {
      return;
    }

    event.preventDefault();
    backendStopped = true;
    stopBackend().finally(() => app.quit());
  });

  process.on("exit", killBackendNow);

  app.whenReady().then(launch);
}
