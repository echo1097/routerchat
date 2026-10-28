import { describe, expect, it } from "vitest";

import { transcriptionPrice } from "../../../frontend/src/transcription/transcriptionPrice.js";

function model(prompt, completion = "0") {
  return { id: "test/stt", name: "Test", pricing: { prompt, completion } };
}


describe("transcriptionPrice", () => {
  it("turns a per second price into a per hour price", () => {
    expect(transcriptionPrice(model("0.0001"))).toEqual({ label: "$0.36 / hr", title: "Per hour of audio" });
    expect(transcriptionPrice(model("0.0000583333")).label).toBe("$0.21 / hr");
  });

  it("keeps small hourly prices readable", () => {
    expect(transcriptionPrice(model("0.00000333")).label).toBe("$0.012 / hr");
    expect(transcriptionPrice(model("0.0000075")).label).toBe("$0.027 / hr");
  });

  it("reads large prices as already per hour", () => {
    expect(transcriptionPrice(model("0.36")).label).toBe("$0.36 / hr");
    expect(transcriptionPrice(model("0.1")).label).toBe("$0.10 / hr");
  });

  it("shows token priced models per million tokens", () => {
    expect(transcriptionPrice(model("0.0000025", "0.00001"))).toEqual({
      label: "$3 / $10 per M",
      title: "Per million input and output tokens",
    });
  });

  it("returns nothing when there is no usable price", () => {
    expect(transcriptionPrice({ id: "test/stt" })).toBeNull();
    expect(transcriptionPrice(model("0"))).toBeNull();
    expect(transcriptionPrice(model("not a number"))).toBeNull();
    expect(transcriptionPrice(model("-1"))).toBeNull();
  });
});
