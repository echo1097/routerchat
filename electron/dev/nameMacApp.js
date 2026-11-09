import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { projectDir } from "../config.js";

const appName = "RouterChat";
const nameKeys = ["CFBundleName", "CFBundleDisplayName"];
const infoFile = join(
  projectDir,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "Info.plist",
);

function readName(nameKey) {
  return execFileSync("plutil", ["-extract", nameKey, "raw", infoFile], { encoding: "utf8" }).trim();
}

function nameMacApp() {
  if (process.platform !== "darwin" || !existsSync(infoFile)) {
    return;
  }

  for (const nameKey of nameKeys) {
    if (readName(nameKey) !== appName) {
      execFileSync("plutil", ["-replace", nameKey, "-string", appName, infoFile]);
    }
  }
}

nameMacApp();
