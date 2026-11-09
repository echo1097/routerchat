import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import { backendUrl, frontendBuildFile, projectDir, pythonBin, secretFile } from "../config.js";
import { clearStaleSecret } from "./apiSecret.js";
import { forwardLogs } from "./backendLogs.js";
import { isBackendHealthy, waitForHealth } from "./waitForHealth.js";

const stopTimeout = 5000;

let backend = null;

function checkRequirements() {
  if (!existsSync(pythonBin)) {
    throw new Error(`The RouterChat virtual environment is missing. Expected ${pythonBin}`);
  }

  if (!existsSync(frontendBuildFile)) {
    throw new Error("The frontend build is missing. Run npm run build first.");
  }
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function startBackend(onLog) {
  checkRequirements();

  if (await isBackendHealthy()) {
    throw new Error(`${backendUrl} is already in use. Stop the other RouterChat first.`);
  }

  await clearStaleSecret();

  backend = spawn(
    pythonBin,
    [
      "-m",
      "backend.local_access",
      "serve",
      "--secret-file",
      secretFile,
      "--base-url",
      backendUrl,
      "--trusted-origin",
      backendUrl,
    ],
    {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    },
  );

  forwardLogs(backend, onLog);

  await Promise.race([
    waitForHealth(backend),
    once(backend, "error").then(([error]) => {
      throw error;
    }),
  ]);

  return backend;
}

export async function stopBackend() {
  if (!backend || hasExited(backend)) {
    return;
  }

  const exited = once(backend, "exit");
  backend.kill("SIGTERM");

  const stoppedInTime = await Promise.race([
    exited.then(() => true),
    sleep(stopTimeout).then(() => false),
  ]);

  if (!stoppedInTime) {
    backend.kill("SIGKILL");
  }

  await clearStaleSecret();
}

export function killBackendNow() {
  if (backend && !hasExited(backend)) {
    backend.kill("SIGKILL");
  }
}
