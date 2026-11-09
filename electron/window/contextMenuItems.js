const separator = { type: "separator" };

function buildSpellingItems(params, actions) {
  const word = params.misspelledWord;
  const suggestions = params.dictionarySuggestions || [];

  const suggestionItems = suggestions.map((suggestion) => ({
    label: suggestion,
    click: () => actions.replaceWord(suggestion),
  }));

  if (suggestionItems.length === 0) {
    suggestionItems.push({ label: "No suggestions", enabled: false });
  }

  return [
    ...suggestionItems,
    separator,
    { label: "Add to Dictionary", click: () => actions.addToDictionary(word) },
  ];
}

function buildEditItems(params) {
  const editFlags = params.editFlags || {};

  return [
    { role: "cut", enabled: Boolean(editFlags.canCut) },
    { role: "copy", enabled: Boolean(editFlags.canCopy) },
    { role: "paste", enabled: Boolean(editFlags.canPaste) },
    separator,
    { role: "selectAll", enabled: Boolean(editFlags.canSelectAll) },
  ];
}

export function buildMenuItems(params, actions) {
  const hasSelection = Boolean(params.selectionText && params.selectionText.trim());

  if (params.isEditable) {
    const editItems = buildEditItems(params);

    if (!params.misspelledWord) {
      return editItems;
    }

    return [...buildSpellingItems(params, actions), separator, ...editItems];
  }

  if (hasSelection) {
    return [{ role: "copy" }];
  }

  return [];
}
