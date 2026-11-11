import { api } from "../api.js";

export function loadDevices() {
  return api("/api/devices");
}

export function setPhoneAccess(enabled) {
  return api("/api/devices/access", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export function startPairing() {
  return api("/api/devices/pairing-code", { method: "POST" });
}

export function cancelPairing() {
  return api("/api/devices/pairing-code", { method: "DELETE" });
}

export function removeDevice(deviceId) {
  return api(`/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
}

export function pairThisDevice(code, name) {
  return api("/api/devices/pair", {
    method: "POST",
    body: JSON.stringify({ code, name }),
  });
}
