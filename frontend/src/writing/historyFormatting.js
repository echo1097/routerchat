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

function historyModelName(entries) {
  for (const entry of entries) {
    const label = String(entry?.label || "");
    for (const pattern of HISTORY_MODEL_PATTERNS) {
      const match = label.match(pattern);
      if (match) return match[1];
    }
  }
  return "Model";
}

function historyEntryIsTimeline(entry) {
  return / updated Timeline$/.test(String(entry?.label || ""));
}

const HISTORY_FOLDABLE_KINDS = new Set(["lore_create", "lore_update", "lore_hide"]);

function historyFoldGroup(entry) {
  if (!HISTORY_FOLDABLE_KINDS.has(entry?.kind)) return null;
  if (historyEntryIsTimeline(entry)) return null;
  return entry.kind;
}

const HISTORY_LORE_KINDS = new Set([
  "lore_create",
  "lore_update",
  "lore_hide",
  "lore_summary",
]);

function historyActivityRows(actions) {
  const rows = [];
  let pass = null;

  actions.forEach((entry) => {
    if (!HISTORY_LORE_KINDS.has(entry.kind)) {
      pass = null;
      rows.push({ id: entry.id, group: null, entries: [entry] });
      return;
    }

    if (!pass) {

      pass = { id: `pass:${entry.id}`, group: "lore_pass", entries: [] };
      rows.push(pass);
    }
    pass.entries.push(entry);

    if (entry.kind === "lore_summary") pass = null;
  });

  return rows;
}

function historyLoreRows(entries) {
  const rows = [];
  const rowsByGroup = new Map();

  entries.forEach((entry) => {
    if (entry.kind === "lore_summary") return;

    const group = historyFoldGroup(entry);
    if (!group) {
      rows.push({ id: `lore:${entry.id}`, group: null, entries: [entry], lore: true });
      return;
    }

    const existing = rowsByGroup.get(group);
    if (existing) {
      existing.entries.push(entry);
      return;
    }

    const row = { id: `fold:${group}:${entry.id}`, group, entries: [entry], lore: true };
    rowsByGroup.set(group, row);
    rows.push(row);
  });

  return rows;
}

export function historyRunRows(run) {
  const promptLed = isPromptEntry(run.prompt);
  const actions = promptLed ? run.actions : [run.prompt, ...run.actions];
  const rows = historyActivityRows(actions);

  if (promptLed) {
    rows.unshift({ id: run.prompt.id, group: null, entries: [run.prompt] });
  }

  return rows;
}

export function historyRowText(row) {
  if (row.name || row.lore || row.entries.length !== 1) return null;

  const entry = row.entries[0];
  if (isPromptEntry(entry)) return { kind: "prompt", text: String(entry.detail || "").trim() };
  if (entry.kind !== "thinking") return null;

  return { kind: "thinking", text: String(entry.detail || "").trim() };
}

export function historyRowChildren(row) {
  if (row.group === "lore_pass") return historyLoreRows(row.entries);
  if (row.entries.length > 1) {
    return row.entries.map((entry) => ({
      id: `name:${entry.id}`,
      group: null,
      entries: [entry],
      name: true,
    }));
  }
  return [];
}

function historyEntryName(entry) {
  const label = String(entry?.label || "");
  const match =
    label.match(/ added (.+) to Lorebook$/)
    || label.match(/ updated (.+) in Lorebook$/)
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

function historyPassLabel(row) {
  const summary = row.entries.find((entry) => entry.kind === "lore_summary");
  const label = String(summary?.label || "");

  const finished = label.match(/^(.+?) finished editing Lorebook after (.+)$/);
  if (finished) return `${finished[1]} edited Lorebook for ${finished[2]}`;

  if (label) return label;
  return `${historyModelName(row.entries)} edited Lorebook`;
}

export function historyRowLabel(row) {
  if (row.group === "lore_pass") return historyPassLabel(row);
  if (row.name) return historyEntryName(row.entries[0]);

  if (row.entries.length === 1) {
    const label = row.entries[0].label;
    return row.lore ? historyLabelBody(label) : String(label || "");
  }

  const count = row.entries.length;
  const noun = count === 1 ? "entry" : "entries";

  if (row.group === "lore_create") return `Added ${count} ${noun} to Lorebook`;
  if (row.group === "lore_hide") return `Excluded ${count} ${noun} from context`;
  return `Updated ${count} ${noun} in Lorebook`;
}

export function historyRowWords(row) {

  const summary = row.entries.find((entry) => entry.kind === "lore_summary");
  const counted = summary ? [summary] : row.entries;

  return counted.reduce(
    (totals, entry) => ({
      added: totals.added + (toFiniteNumber(entry.words_added) || 0),
      removed: totals.removed + (toFiniteNumber(entry.words_removed) || 0),
    }),
    { added: 0, removed: 0 },
  );
}

export function historyWordTotals(entries) {

  return entries.reduce(
    (totals, entry) => {
      if (entry.kind === "lore_hide" || entry.kind === "lore_summary") return totals;
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
