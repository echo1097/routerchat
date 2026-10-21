import { describe, expect, it } from "vitest";
import {
  castCharacters,
  characterColor,
  splitChainMessages,
  userCharacter,
} from "../../frontend/src/roleplay/characterChain.js";

const CAST = [{ name: "Maya", kind: "cast" }, { name: "Jon", kind: "cast" }];

describe("splitChainMessages", () => {
  it("splits a thread into one bubble per speaker line", () => {
    const bubbles = splitChainMessages(
      "Maya: hey are you up?\nJon: barely\nMaya: good enough",
      CAST,
    );

    expect(bubbles).toEqual([
      { speaker: "Maya", content: "hey are you up?" },
      { speaker: "Jon", content: "barely" },
      { speaker: "Maya", content: "good enough" },
    ]);
  });

  it("keeps wrapped lines with the message above them", () => {
    const bubbles = splitChainMessages("Maya: first line\nsecond line", CAST);

    expect(bubbles).toEqual([
      { speaker: "Maya", content: "first line\nsecond line" },
    ]);
  });

  it("matches a name whatever case the model used", () => {
    expect(splitChainMessages("maya: hi", CAST)).toEqual([
      { speaker: "Maya", content: "hi" },
    ]);
  });

  it("leaves text that names nobody in one plain bubble", () => {
    expect(splitChainMessages("The room goes quiet.", CAST)).toEqual([
      { speaker: null, content: "The room goes quiet." },
    ]);
  });

  it("ignores a colon that is not a cast name", () => {
    expect(splitChainMessages("Maya: the plan: show up", CAST)).toEqual([
      { speaker: "Maya", content: "the plan: show up" },
    ]);
  });

  it("falls back to one bubble when there is no cast", () => {
    expect(splitChainMessages("Maya: hey", [])).toEqual([
      { speaker: null, content: "Maya: hey" },
    ]);
  });

  it("drops the empty lines between messages", () => {
    expect(splitChainMessages("Maya: hey\n\nJon: hi", CAST)).toEqual([
      { speaker: "Maya", content: "hey" },
      { speaker: "Jon", content: "hi" },
    ]);
  });
});

describe("cast helpers", () => {
  it("keeps the person you play out of the cast", () => {
    const characters = [...CAST, { name: "Alex", kind: "user" }];

    expect(castCharacters(characters).map((item) => item.name)).toEqual(["Maya", "Jon"]);
    expect(userCharacter(characters).name).toBe("Alex");
  });

  it("prefers a chosen color over the palette", () => {
    expect(characterColor({ color: "#123456" }, 0)).toBe("#123456");
    expect(characterColor({ color: "" }, 0)).toBe(characterColor({}, 0));
    expect(characterColor({}, 0)).not.toBe(characterColor({}, 1));
  });
});
