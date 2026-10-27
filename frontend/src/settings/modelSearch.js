import { isBatchModel, isFreeModel, modelDisplayName } from "../modelFormatting.js";

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function loosen(value) {
  return value.replace(/[-_/:]+/g, " ").replace(/\s+/g, " ").trim();
}

function startsAWord(text, query) {
  return text.split(" ").some((_, index, words) => words.slice(index).join(" ").startsWith(query));
}

function matchScore(model, query) {
  const displayName = normalize(modelDisplayName(model));
  const fullName = normalize(model.name);
  const id = normalize(model.id);
  const idName = loosen(id.split("/").pop() || "");
  const description = normalize(model.description);
  const looseQuery = loosen(query);

  if (displayName === query || fullName === query || idName === looseQuery) return 0;
  if (displayName.startsWith(query) || fullName.startsWith(query) || idName.startsWith(looseQuery)) return 1;
  if (startsAWord(displayName, query) || startsAWord(fullName, query)) return 2;
  if (displayName.includes(query) || fullName.includes(query)) return 3;
  if (id.includes(query) || loosen(id).includes(looseQuery)) return 4;

  const words = looseQuery.split(" ");
  const searchable = `${loosen(fullName)} ${loosen(id)}`;
  if (words.every((word) => searchable.includes(word))) return 5;
  if (description.includes(query)) return 6;

  return -1;
}

export function searchModels(models, query, { hideFree = false, hideBatch = false } = {}) {
  const visibleModels = models.filter((model) => {
    if (hideFree && isFreeModel(model)) return false;
    if (hideBatch && isBatchModel(model)) return false;
    return true;
  });

  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return visibleModels;

  return visibleModels
    .map((model, index) => ({ model, index, score: matchScore(model, normalizedQuery) }))
    .filter((entry) => entry.score >= 0)
    .sort((first, second) => first.score - second.score || first.index - second.index)
    .map((entry) => entry.model);
}
