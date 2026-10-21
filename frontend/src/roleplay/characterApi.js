import { api } from "../api.js";

function charactersPath(roleplayId) {
  return `/api/roleplays/${encodeURIComponent(roleplayId)}/characters`;
}

export async function listCharacters(roleplayId) {
  const payload = await api(charactersPath(roleplayId));
  return payload.characters || [];
}

export async function createCharacter(roleplayId, body) {
  const payload = await api(charactersPath(roleplayId), {
    method: "POST",
    body: JSON.stringify(body),
  });
  return payload.character;
}

export async function updateCharacter(roleplayId, characterId, body) {
  const payload = await api(`${charactersPath(roleplayId)}/${encodeURIComponent(characterId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return payload.character;
}

export async function deleteCharacter(roleplayId, characterId) {
  await api(`${charactersPath(roleplayId)}/${encodeURIComponent(characterId)}`, {
    method: "DELETE",
  });
}
