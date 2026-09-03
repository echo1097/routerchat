import { describe, expect, it } from "vitest";

import {
  nextEditPreview,
  parseStreamingEditPreview,
} from "../../../frontend/src/writing/chapterGenerationEvents.js";

//mirrors the gate WriteOperationStatus uses to decide whether the panel exists at all
function panelVisible(preview) {
  return Boolean(preview && (preview.newText || preview.operation));
}

//replays a whole run the way the content handler does, one delta at a time
function replay(full) {
  const states = [];
  let preview = null;
  for (let length = 1; length <= full.length; length += 1) {
    preview = nextEditPreview(preview, parseStreamingEditPreview(full.slice(0, length)));
    states.push(preview);
  }
  return states;
}

//feeds a buffer one character at a time the way the content deltas actually arrive
function scan(full) {
  const frames = [];
  for (let length = 1; length <= full.length; length += 1) {
    frames.push(parseStreamingEditPreview(full.slice(0, length)));
  }
  return frames;
}

const replaceBlockBatch = JSON.stringify({
  chapterRevision: 7,
  edits: [
    {
      operation: "replaceBlock",
      blockId: "p_003",
      anchorText: "She turned toward the door.",
      newText: "She turned toward the door, hesitating.\n\nThe hallway beyond was dark.",
    },
    { operation: "appendToChapter", newText: "And then it was over." },
  ],
});

//replaceBlockRange declares newText before operation in the schema, so the prose lands first
const rangeBatch = JSON.stringify({
  chapterRevision: 2,
  edits: [
    {
      newText: "A rewritten span of prose.",
      startBlockId: "p_002",
      startAnchorText: "start anchor",
      endBlockId: "p_004",
      endAnchorText: "end anchor",
      operation: "replaceBlockRange",
    },
  ],
});

describe("parseStreamingEditPreview", () => {
  it("reports nothing before the edits array opens", () => {
    expect(parseStreamingEditPreview('{"chapterRevision": 7')).toEqual({
      completedCount: 0,
      current: null,
    });
  });

  it("never leaks raw json syntax into the prose it surfaces", () => {
    for (const frame of scan(replaceBlockBatch)) {
      if (!frame.current) continue;
      expect(frame.current.newText).not.toMatch(/["{}[\]]|\\n|newText|blockId/);
    }
  });

  it("grows the prose monotonically as the buffer fills", () => {
    const texts = scan(replaceBlockBatch)
      .filter((frame) => frame.current && frame.completedCount === 0)
      .map((frame) => frame.current.newText);

    for (let index = 1; index < texts.length; index += 1) {
      expect(texts[index].startsWith(texts[index - 1])).toBe(true);
    }
    expect(texts.at(-1)).toBe("She turned toward the door, hesitating.\n\nThe hallway beyond was dark.");
  });

  it("decodes escapes rather than showing them, even mid sequence", () => {
    const upTo = replaceBlockBatch.indexOf("hesitating") + "hesitating.\\n".length;
    const frame = parseStreamingEditPreview(replaceBlockBatch.slice(0, upTo));
    expect(frame.current.newText).toBe("She turned toward the door, hesitating.\n");
    expect(frame.current.newTextComplete).toBe(false);
  });

  it("counts finished edits and moves on to the next one", () => {
    const second = replaceBlockBatch.indexOf("And then") + "And then".length;
    const frame = parseStreamingEditPreview(replaceBlockBatch.slice(0, second));
    expect(frame.completedCount).toBe(1);
    expect(frame.current.operation).toBe("appendToChapter");
    expect(frame.current.newText).toBe("And then");
  });

  it("marks the value complete once its closing quote lands", () => {
    const closed = replaceBlockBatch.indexOf("dark.") + "dark.\"".length;
    expect(parseStreamingEditPreview(replaceBlockBatch.slice(0, closed)).current.newTextComplete).toBe(true);
  });

  it("surfaces prose for replaceBlockRange even though operation streams last", () => {
    const partial = rangeBatch.slice(0, rangeBatch.indexOf("span of"));
    const frame = parseStreamingEditPreview(partial);
    expect(frame.current.operation).toBe("");
    expect(frame.current.newText).toBe("A rewritten ");
  });

  it("reports no open edit once the array closes", () => {
    expect(parseStreamingEditPreview(replaceBlockBatch).current).toBeNull();
    expect(parseStreamingEditPreview(replaceBlockBatch).completedCount).toBe(2);
  });

  it("keeps working when the model emits compact json", () => {
    const compact = '{"chapterRevision":1,"edits":[{"operation":"replaceBlock","blockId":"p_1","anchorText":"a","newText":"hello wor';
    const frame = parseStreamingEditPreview(compact);
    expect(frame.current.operation).toBe("replaceBlock");
    expect(frame.current.anchor).toBe("a");
    expect(frame.current.newText).toBe("hello wor");
  });

  it("never hides the panel again once it has shown, including between edits", () => {
    const visible = replay(replaceBlockBatch).map(panelVisible);
    const firstShown = visible.indexOf(true);

    expect(firstShown).toBeGreaterThan(-1);
    //once up it stays up, a false in here is the panel tearing down mid run
    expect(visible.slice(firstShown).every(Boolean)).toBe(true);
  });

  it("holds the last edit on screen after the batch closes", () => {
    const finalPreview = replay(replaceBlockBatch).at(-1);
    expect(finalPreview.operation).toBe("appendToChapter");
    expect(finalPreview.newText).toBe("And then it was over.");
    expect(finalPreview.newTextComplete).toBe(true);
  });

  it("advances the edit index as the batch works through it", () => {
    const indexes = replay(replaceBlockBatch)
      .filter(panelVisible)
      .map((preview) => preview.editIndex);

    expect(indexes[0]).toBe(0);
    expect(indexes.at(-1)).toBe(1);
    //never counts backwards
    for (let i = 1; i < indexes.length; i += 1) {
      expect(indexes[i]).toBeGreaterThanOrEqual(indexes[i - 1]);
    }
  });

  it("stays hidden for a run that never produces an edit", () => {
    expect(replay('{"chapterRevision":1,"edits":[').every((p) => !panelVisible(p))).toBe(true);
  });

  it("is not fooled by json punctuation inside the prose", () => {
    const tricky = '{"chapterRevision":1,"edits":[{"operation":"appendToChapter","newText":"He said {\\"stop\\"} and [left]';
    const frame = parseStreamingEditPreview(tricky);
    expect(frame.completedCount).toBe(0);
    expect(frame.current.newText).toBe('He said {"stop"} and [left]');
  });
});

describe("parseStreamingEditPreview with paragraph arrays", () => {
  const arrayBatch = JSON.stringify({
    chapterRevision: 7,
    edits: [
      {
        operation: "replaceBlock",
        blockId: "p_003",
        anchorText: "She turned toward the door.",
        newText: ["She turned toward the door, hesitating.", "The hallway beyond was dark."],
      },
      { operation: "appendToChapter", newText: ["And then it was over."] },
    ],
  });

  it("rejoins the finished paragraphs the way the server will", () => {
    const finalPreview = replay(arrayBatch).at(-1);
    expect(finalPreview.operation).toBe("appendToChapter");
    expect(finalPreview.newText).toBe("And then it was over.");
    expect(finalPreview.newTextComplete).toBe(true);
  });

  it("shows earlier paragraphs while a later one is still streaming", () => {
    const partial = '{"chapterRevision":7,"edits":[{"operation":"replaceBlock","newText":["First paragraph.","Second para';
    const frame = parseStreamingEditPreview(partial);
    expect(frame.current.newText).toBe("First paragraph.\n\nSecond para");
    expect(frame.current.newTextComplete).toBe(false);
  });

  it("only reports complete once the array has closed", () => {
    const open = '{"chapterRevision":7,"edits":[{"operation":"appendToChapter","newText":["Done."';
    expect(parseStreamingEditPreview(open).current.newTextComplete).toBe(false);

    const closed = `${open}]`;
    expect(parseStreamingEditPreview(closed).current.newTextComplete).toBe(true);
  });

  it("only ever shows a prefix of the prose that edit ends up with", () => {
    const finished = [
      "She turned toward the door, hesitating.\n\nThe hallway beyond was dark.",
      "And then it was over.",
    ];
    const texts = scan(arrayBatch)
      .map((frame) => frame.current && frame.current.newText)
      .filter(Boolean);

    for (const text of texts) {
      expect(finished.some((whole) => whole.startsWith(text))).toBe(true);
    }
  });
});
