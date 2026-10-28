import { describe, expect, it } from "vitest";

import { cachedPriceLabel } from "../../frontend/src/modelFormatting.js";

function model(inputCacheRead) {
  return { id: "test/model", pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: inputCacheRead } };
}


describe("cachedPriceLabel", () => {
  it("shows the cached input price per million tokens", () => {
    expect(cachedPriceLabel(model("0.0000002"))).toBe("$0.20");
    expect(cachedPriceLabel(model("0.0000025"))).toBe("$2.50");
    expect(cachedPriceLabel(model("0.000001"))).toBe("$1");
  });

  it("is not thrown off by floating point rounding", () => {
    expect(cachedPriceLabel(model("0.0000001"))).toBe("$0.10");
    expect(cachedPriceLabel(model("0.0000003"))).toBe("$0.30");
  });

  it("keeps very small cached prices readable", () => {
    expect(cachedPriceLabel(model("0.00000001"))).toBe("$0.01");
    expect(cachedPriceLabel(model("0.000000025"))).toBe("$0.025");
  });

  it("returns nothing when the model has no cached price", () => {
    expect(cachedPriceLabel({ id: "test/model", pricing: {} })).toBe("");
    expect(cachedPriceLabel({ id: "test/model" })).toBe("");
    expect(cachedPriceLabel(model("0"))).toBe("");
    expect(cachedPriceLabel(model("-1"))).toBe("");
  });
});
