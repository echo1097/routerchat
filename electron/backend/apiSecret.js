import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { secretFile } from "../config.js";

export async function clearStaleSecret() {
  await mkdir(dirname(secretFile), { recursive: true, mode: 0o700 });
  await rm(secretFile, { force: true });
}

export async function readSecret() {
  const secret = await readFile(secretFile, "ascii");

  return secret.trim();
}
