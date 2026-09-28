import { toFiniteNumber } from "../modelFormatting.js";
import { isFiniteNumber } from "../textFormatting.js";

export function isPromptEntry(entry) {

  return entry.kind === "prompt" || entry.label === "User prompt";
}

export function historyRunGroups(entries) {
  const groups = [];
  entries.forEach((entry) => {
    if (isPromptEntry(entry) || groups.length === 0) {
      groups.push({
        id: entry.id,
        prompt: entry,
        actions: [],
      });
      return;
    }
    groups[groups.length - 1].actions.push(entry);
  });
  return groups;
}

const HISTORY_MODEL_PATTERNS = [
  /^(.+?) thought for /,
  /^(.+?) wrote for /,
  /^(.+?) applied \d/,
  /^(.+?) could not /,
  /^(.+?) added .+ to Lorebook$/,
  /^(.+?) updated .+ in Lorebook$/,
  /^(.+?) updated Timeline$/,
  /^(.+?) excluded .+ from context$/,
  /^(.+?) finished editing Lorebook after /,
  /^(.+?) found no Lorebook changes after /,
];

const HISTORY_LORE_CHANGE_KINDS = new Set(["lore_create", "lore_update", "lore_hide"]);

const HISTORY_LORE_KIND_NAMES = {
  lore_create: "Added",
  lore_update: "Updated",
  lore_hide: "Excluded",
};

function historyModelName(entries) {
  for (const entry of entries) {
    const label = String(entry?.label || "");
    for (const pattern of HISTORY_MODEL_PATTERNS) {
      const match = label.match(pattern);
      if (match) return match[1];
    }
  }
  return "";
}

function historyEntryName(entry) {
  const label = String(entry?.label || "");
  const match =
    label.match(/ added (.+) to Lorebook$/)
    || label.match(/ updated (.+) in Lorebook$/)
    || label.match(/ updated (Timeline)$/)
    || label.match(/ excluded (.+) from context$/);
  return match ? match[1] : label;
}

function historyLabelBody(label) {
  const text = String(label || "");

  for (const pattern of HISTORY_MODEL_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;

    const body = text.slice(match[1].length).trimStart();
    return body ? body[0].toUpperCase() + body.slice(1) : text;
  }

  return text;
}

function historyEntryWords(entry) {
  return {
    added: toFiniteNumber(entry.words_added) || 0,
    removed: toFiniteNumber(entry.words_removed) || 0,
  };
}

export function historyRunPrompt(run) {
  if (!isPromptEntry(run.prompt)) return "";
  return String(run.prompt.detail || "").trim();
}

function isLoreEntry(entry) {
  return entry.kind === "lore_summary" || HISTORY_LORE_CHANGE_KINDS.has(entry.kind);
}

export function historyRunStoryModel(run) {
  return historyModelName(run.actions.filter((entry) => !isLoreEntry(entry)));
}

export function historyRunLoreModel(run) {
  return historyModelName(run.actions.filter(isLoreEntry));
}

export function historyRunFailed(run) {
  return run.actions.some((entry) => entry.kind === "write_failed");
}

export function historyRunSteps(run) {
  const actions = isPromptEntry(run.prompt) ? run.actions : [run.prompt, ...run.actions];

  return actions
    .filter((entry) => !HISTORY_LORE_CHANGE_KINDS.has(entry.kind))
    .filter((entry) => !(entry.kind === "lore_summary" && / finished editing Lorebook after /.test(String(entry.label || ""))))
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      label: historyLabelBody(entry.label),
      detail: String(entry.detail || "").trim(),
      ...historyEntryWords(entry),
    }));
}

export function historyRunLore(run) {
  const changes = run.actions
    .filter((entry) => HISTORY_LORE_CHANGE_KINDS.has(entry.kind))
    .map((entry) => ({
      id: entry.id,
      kind: HISTORY_LORE_KIND_NAMES[entry.kind],
      name: historyEntryName(entry),
      ...historyEntryWords(entry),
    }));

  if (changes.length === 0) return null;

  return { changes };
}

export function historyWordTotals(entries) {

  return entries.reduce(
    (totals, entry) => {
      if (isLoreEntry(entry)) return totals;
      return {
        added: totals.added + (toFiniteNumber(entry.words_added) || 0),
        removed: totals.removed + (toFiniteNumber(entry.words_removed) || 0),
      };
    },
    { added: 0, removed: 0 },
  );
}

export function historyCostTotal(entries) {

  return entries.reduce((total, entry) => {
    const cost = toFiniteNumber(entry.cost);
    return isFiniteNumber(cost) ? total + cost : total;
  }, 0);
}

export function historyTimeAgo(value, now = Date.now()) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";

  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}
