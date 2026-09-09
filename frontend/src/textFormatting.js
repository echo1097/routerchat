

export function truncatePromptText(value, maxLength = 96) {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact || "Empty prompt";
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

export function exportFileName(chat) {
  const title = (chat?.title || "chat")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "chat";
  return `routerchat-${title}-${new Date().toISOString().slice(0, 10)}.json`;
}

export function storyExportFileName(story) {
  const title = (story?.title || "story")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "story";
  return `routerchat-story-${title}-${new Date().toISOString().slice(0, 10)}.json`;
}

export function shortTitle(title) {
  const trimmed = (title || "").trim();
  if (trimmed.length <= 48) return trimmed;
  return `${trimmed.slice(0, 48).trimEnd()}…`;
}

export function formatThoughtDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatInteger(value) {
  if (!isFiniteNumber(value)) return "Unavailable";
  return new Intl.NumberFormat().format(value);
}

export function formatCost(value) {
  if (!isFiniteNumber(value)) return "Unavailable";
  if (value > 0 && value < 1) {
    const cents = value * 100;
    const centsText = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: cents < 0.1 ? 3 : 1,
      maximumFractionDigits: cents < 0.1 ? 3 : 1,
    }).format(cents);

    return `${centsText}¢`;
  }

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value >= 1 ? 2 : 6,
  }).format(value);
}
