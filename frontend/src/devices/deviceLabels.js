const dayLength = 24 * 60 * 60 * 1000;

export function lastUsedLabel(lastSeenAt, now = Date.now()) {
  const lastSeen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(lastSeen)) return "";

  const days = Math.floor(Math.max(0, now - lastSeen) / dayLength);
  if (days === 0) return "Used today";
  if (days === 1) return "Used yesterday";
  return `Used ${days} days ago`;
}

export function countdownLabel(secondsLeft) {
  const seconds = Math.max(0, Math.ceil(secondsLeft));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function spacedCode(code) {
  return `${code.slice(0, 4)} ${code.slice(4)}`.trim();
}

export function plainAddress(address) {
  return String(address || "").replace(/^http:\/\//, "");
}
