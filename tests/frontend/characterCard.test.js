import { describe, expect, it } from "vitest";
import { characterFromCard, readCharacterCard } from "../../frontend/src/roleplay/characterCard.js";

const V2_CARD = {
  spec: "chara_card_v2",
  data: {
    name: "Maya",
    description: "{{char}} runs the late shift.",
    personality: "Dry, deflects.",
    scenario: "A diner at 3am.",
    first_mes: "you're up late",
    mes_example: "{{user}}: you ok?\n{{char}}: define ok",
  },
};

function cardFile(name, contents) {
  return { name, text: async () => contents };
}

function pngChunk(type, data) {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.length);
  const typeBytes = Uint8Array.from(type, (character) => character.charCodeAt(0));
  return [...length, ...typeBytes, ...data, 0, 0, 0, 0];
}

function pngCardFile(name, payload, key = "chara") {
  const base64 = btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))),
  );
  const text = [
    ...Uint8Array.from(`${key}`, (character) => character.charCodeAt(0)),
    0,
    ...Uint8Array.from(base64, (character) => character.charCodeAt(0)),
  ];
  const bytes = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...pngChunk("IHDR", new Uint8Array(13)),
    ...pngChunk("tEXt", text),
    ...pngChunk("IEND", new Uint8Array(0)),
  ]);

  return { name, arrayBuffer: async () => bytes.buffer };
}

describe("characterFromCard", () => {
  it("reads a v2 card out of its data wrapper", () => {
    const result = characterFromCard(V2_CARD);

    expect(result.character.name).toBe("Maya");
    expect(result.character.description).toBe("{{char}} runs the late shift.");
    expect(result.character.personality).toBe("Dry, deflects.");
    expect(result.character.greeting).toBe("you're up late");
    expect(result.character.example_dialogue).toContain("define ok");
    expect(result.scenario).toBe("A diner at 3am.");
  });

  it("reads a flat v1 card too", () => {
    const result = characterFromCard({ name: "Jon", description: "Back in town." });

    expect(result.character.name).toBe("Jon");
    expect(result.character.description).toBe("Back in town.");
    expect(result.scenario).toBe("");
  });

  it("falls back to the first alternate greeting", () => {
    const result = characterFromCard({
      name: "Maya",
      alternate_greetings: ["second chance", "third"],
    });

    expect(result.character.greeting).toBe("second chance");
  });

  it("rejects anything without a name", () => {
    expect(characterFromCard({ description: "no name" })).toBeNull();
    expect(characterFromCard(null)).toBeNull();
    expect(characterFromCard("nope")).toBeNull();
  });

  it("imports as cast, never as you", () => {
    expect(characterFromCard(V2_CARD).character.kind).toBe("cast");
  });
});

describe("readCharacterCard", () => {
  it("reads a json card", async () => {
    const result = await readCharacterCard(cardFile("maya.json", JSON.stringify(V2_CARD)));

    expect(result.character.name).toBe("Maya");
  });

  it("reads a card embedded in a png", async () => {
    const result = await readCharacterCard(pngCardFile("maya.png", V2_CARD));

    expect(result.character.name).toBe("Maya");
    expect(result.character.greeting).toBe("you're up late");
  });

  it("reads the v3 chunk key too", async () => {
    const result = await readCharacterCard(pngCardFile("maya.png", V2_CARD, "ccv3"));

    expect(result.character.name).toBe("Maya");
  });

  it("returns nothing for a png with no card in it", async () => {
    const bare = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10,
      ...pngChunk("IHDR", new Uint8Array(13)),
      ...pngChunk("IEND", new Uint8Array(0)),
    ]);

    expect(
      await readCharacterCard({ name: "plain.png", arrayBuffer: async () => bare.buffer }),
    ).toBeNull();
  });

  it("ignores a file that is neither json nor png", async () => {
    expect(await readCharacterCard(cardFile("maya.txt", "Maya"))).toBeNull();
  });
});
