const computerHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isPhoneBrowser(hostname = window.location.hostname) {
  return !computerHosts.has(hostname);
}

export function readPairingCode(hash = window.location.hash) {
  const match = /^#pair=([A-Za-z0-9-]{1,32})$/.exec(hash);
  return match ? match[1].toUpperCase() : "";
}

export function guessDeviceName(userAgent = window.navigator.userAgent) {
  if (/iPad/.test(userAgent)) return "iPad";
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/Android/.test(userAgent) && /Mobile/.test(userAgent)) return "Android phone";
  if (/Android/.test(userAgent)) return "Android tablet";
  return "My device";
}
