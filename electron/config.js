import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultPort = 8137;

export const electronDir = dirname(fileURLToPath(import.meta.url));
export const projectDir = resolve(electronDir, "..");
export const frontendBuildFile = join(projectDir, "dist", "index.html");
export const windowIcon = join(electronDir, "assets", "icon.png");

export const pythonBin = process.platform === "win32"
  ? join(projectDir, ".venv", "Scripts", "python.exe")
  : join(projectDir, ".venv", "bin", "python");

export function readBackendPort() {
  const configuredPort = process.env.ROUTERCHAT_ELECTRON_PORT;

  if (!configuredPort) {
    return defaultPort;
  }

  const port = Number(configuredPort);

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("ROUTERCHAT_ELECTRON_PORT must be a port number between 1024 and 65535.");
  }

  return port;
}

const backendPort = readBackendPort();

export const backendUrl = `http://127.0.0.1:${backendPort}`;
export const secretFile = join(projectDir, ".routerchat-run", `electron-api-secret-${backendPort}`);
