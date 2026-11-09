import { setTimeout as sleep } from "node:timers/promises";

import { backendUrl } from "../config.js";

const healthUrl = `${backendUrl}/api/health`;
const startupTimeout = 30_000;
const pollDelay = 150;

export async function isBackendHealthy() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });

    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForHealth(backend) {
  const deadline = Date.now() + startupTimeout;

  while (Date.now() < deadline) {
    if (backend.exitCode !== null || backend.signalCode !== null) {
      throw new Error("The RouterChat backend stopped before it was ready.");
    }

    if (await isBackendHealthy()) {
      return;
    }

    await sleep(pollDelay);
  }

  throw new Error("Timed out waiting for the RouterChat backend to start.");
}
