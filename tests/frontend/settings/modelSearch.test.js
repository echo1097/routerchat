import { describe, expect, it } from "vitest";

import { searchModels } from "../../../frontend/src/settings/modelSearch.js";

function model(id, name, description = "", pricing = { prompt: "0.000001", completion: "0.000002" }) {
  return { id, name, description, pricing };
}

const models = [
  model("moonshotai/kimi-k3.1-pro", "MoonshotAI: Kimi K3.1 Pro", "The pro tier of Kimi K3.1"),
  model("fireworks/ember-1", "Fireworks: Ember-1", "A fine tune of Kimi K3"),
  model("sakana/namazu", "Sakana: Sakana Namazu", "Trained with Kimi K2 style data"),
  model("moonshotai/kimi-k3", "MoonshotAI: Kimi K3"),
  model("moonshotai/kimi-k2.7-code", "MoonshotAI: Kimi K2.7 Code"),
  model("meta/llama-5:free", "Meta: Llama 5 (free)", "", { prompt: "0", completion: "0" }),
];

function names(results) {
  return results.map((entry) => entry.id);
}

describe("searchModels", () => {
  it("puts an exact name match first", () => {
    expect(names(searchModels(models, "Kimi K3"))).toEqual([
      "moonshotai/kimi-k3",
      "moonshotai/kimi-k3.1-pro",
      "fireworks/ember-1",
    ]);
  });

  it("ranks name matches above description matches", () => {
    expect(names(searchModels(models, "kimi k"))).toEqual([
      "moonshotai/kimi-k3.1-pro",
      "moonshotai/kimi-k3",
      "moonshotai/kimi-k2.7-code",
      "fireworks/ember-1",
      "sakana/namazu",
    ]);
  });

  it("matches words in any order and ignores id punctuation", () => {
    expect(names(searchModels(models, "code k2.7"))).toEqual(["moonshotai/kimi-k2.7-code"]);
    expect(names(searchModels(models, "kimi-k3"))[0]).toBe("moonshotai/kimi-k3");
  });

  it("keeps the original order without a query and applies the filters", () => {
    expect(names(searchModels(models, "  "))).toEqual(names(models));
    expect(names(searchModels(models, "", { hideFree: true }))).not.toContain("meta/llama-5:free");
  });
});
