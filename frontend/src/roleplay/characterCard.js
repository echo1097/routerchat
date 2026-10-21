const TEXT_CHUNK_KEYS = ["chara", "ccv3"];

function cardBody(payload) {
  if (!payload || typeof payload !== "object") return null;
  const body = payload.data && typeof payload.data === "object" ? payload.data : payload;
  return typeof body.name === "string" && body.name.trim() ? body : null;
}

function joinGreetings(body) {
  const first = String(body.first_mes || "").trim();
  if (first) return first;

  const alternates = Array.isArray(body.alternate_greetings) ? body.alternate_greetings : [];
  return String(alternates[0] || "").trim();
}

export function characterFromCard(payload) {
  const body = cardBody(payload);
  if (!body) return null;

  return {
    character: {
      name: String(body.name).trim().slice(0, 80),
      kind: "cast",
      description: String(body.description || "").trim(),
      appearance: "",
      personality: String(body.personality || "").trim(),
      speech_style: "",
      greeting: joinGreetings(body),
      example_dialogue: String(body.mes_example || "").trim(),
      color: "",
      disabled: false,
    },
    scenario: String(body.scenario || "").trim(),
  };
}

function readTextChunks(bytes) {
  const chunks = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === "tEXt") {
      const separator = data.indexOf(0);
      if (separator > 0) {
        const key = String.fromCharCode(...data.subarray(0, separator));
        chunks[key.toLowerCase()] = data.subarray(separator + 1);
      }
    }

    if (type === "IEND") break;
    offset += 12 + length;
  }

  return chunks;
}

function decodeBase64Utf8(bytes) {
  const base64 = new TextDecoder("latin1").decode(bytes);
  const binary = atob(base64.replace(/\s/g, ""));
  const raw = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8").decode(raw);
}

export async function readCharacterCard(file) {
  const name = String(file.name || "").toLowerCase();

  if (name.endsWith(".json")) {
    return characterFromCard(JSON.parse(await file.text()));
  }

  if (name.endsWith(".png")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chunks = readTextChunks(bytes);
    const key = TEXT_CHUNK_KEYS.find((candidate) => chunks[candidate]);
    if (!key) return null;
    return characterFromCard(JSON.parse(decodeBase64Utf8(chunks[key])));
  }

  return null;
}
