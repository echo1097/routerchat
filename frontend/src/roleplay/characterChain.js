export const CHARACTER_COLORS = [
  "#f0a3b4",
  "#8fc7f2",
  "#b6dca0",
  "#f2cf8f",
  "#c6aef5",
  "#8fe0d4",
  "#f2a98f",
  "#c2c8d6",
];

export function characterColor(character, index = 0) {
  const chosen = String(character?.color || "").trim();
  if (chosen) return chosen;
  return CHARACTER_COLORS[index % CHARACTER_COLORS.length];
}

export function castCharacters(characters) {
  return (characters || []).filter((character) => character.kind !== "user");
}

export function userCharacter(characters) {
  return (characters || []).find((character) => character.kind === "user") || null;
}

export function withHardBreaks(text) {
  if (text.includes("```")) return text;
  return text.replace(/([^\n])\n(?!\n)/g, "$1  \n");
}

function speakerAt(line, names) {
  const separator = line.indexOf(":");
  if (separator < 1) return null;

  const candidate = line.slice(0, separator).trim();
  if (!candidate || candidate.length > 80) return null;

  const matched = names.find(
    (name) => name.toLowerCase() === candidate.toLowerCase(),
  );
  if (!matched) return null;

  return { speaker: matched, text: line.slice(separator + 1).trimStart() };
}

export function splitChainMessages(content, characters) {
  const text = String(content || "");
  const names = (characters || [])
    .map((character) => String(character.name || "").trim())
    .filter(Boolean);

  if (names.length === 0) return [{ speaker: null, content: text }];

  const bubbles = [];
  let current = null;

  for (const line of text.split("\n")) {
    const match = speakerAt(line, names);

    if (match) {
      current = { speaker: match.speaker, content: match.text };
      bubbles.push(current);
      continue;
    }

    if (!current) {
      if (!line.trim() && bubbles.length === 0) continue;
      current = { speaker: null, content: line };
      bubbles.push(current);
      continue;
    }

    current.content = `${current.content}\n${line}`;
  }

  if (bubbles.length === 0) return [{ speaker: null, content: text }];

  return bubbles
    .map((bubble) => ({ ...bubble, content: bubble.content.replace(/\s+$/, "") }))
    .filter((bubble) => bubble.speaker || bubble.content.trim());
}
