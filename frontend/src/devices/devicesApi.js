import { api } from "../api.js";

export function readPhoneStatus(payload) {
  if (!payload || !Array.isArray(payload.devices)) {
    throw new Error("Phone access settings could not be loaded");
  }

  return payload;
}

export async function loadDevices() {
  return readPhoneStatus(await api("/api/devices"));
}

export async function setPhoneAccess(enabled) {
  const payload = await api("/api/devices/access", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });

  return readPhoneStatus(payload);
}

export function startPairing() {
  return api("/api/devices/pairing-code", { method: "POST" });
}

export async function cancelPairing() {
  return readPhoneStatus(await api("/api/devices/pairing-code", { method: "DELETE" }));
}

export async function removeDevice(deviceId) {
  const payload = await api(`/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });

  return readPhoneStatus(payload);
}

export function pairThisDevice(code, name) {
  return api("/api/devices/pair", {
    method: "POST",
    body: JSON.stringify({ code, name }),
  });
}
