import { test, expect } from "@playwright/test";
import { installWriteApi } from "./writeReliability.fixture.js";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

const capabilities = {
  webSearch: true,
  pdfParsing: true,
  cost: true,
  routingOptions: true,
  transcription: true,
  freeModels: true,
};

const providers = [
  { id: "openrouter", name: "OpenRouter", keyPlaceholder: "sk-or-v1-...", active: false, hasKey: true, capabilities },
  {
    id: "anthropic",
    name: "Anthropic",
    keyPlaceholder: "sk-ant-...",
    active: true,
    hasKey: true,
    capabilities: { ...capabilities, webSearch: false, routingOptions: false, transcription: false, freeModels: false },
  },
];

const openRouterModel = {
  id: "test/model",
  name: "Test model",
  pricing: { prompt: "0.000001", completion: "0.000002" },
  architecture: { output_modalities: ["text"] },
  supported_parameters: [],
};

const claudeModel = {
  id: "claude-sonnet-5-5",
  name: "Anthropic: Claude Sonnet 5.5",
  pricing: { prompt: "0.000002", completion: "0.00001" },
  architecture: { output_modalities: ["text"] },
  supported_parameters: [],
};

test("a story keeps its own provider until it is moved", async ({ page }) => {
  const fixture = await installWriteApi(page);
  const modelRequests = [];
  const moveRequests = [];
  fixture.state.story.provider = "openrouter";

  await page.route("**/api/providers", (route) => route.fulfill({ json: { active: "anthropic", providers } }));
  await page.route("**/api/models**", (route) => {
    const providerId = new URL(route.request().url()).searchParams.get("provider");
    modelRequests.push(providerId);
    return route.fulfill({ json: { models: [providerId === "openrouter" ? openRouterModel : claudeModel] } });
  });
  await page.route("**/api/stories/story-1/provider", (route) => {
    moveRequests.push(route.request().postDataJSON());
    fixture.state.story = {
      ...fixture.state.story,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      lorebook_model: "",
    };
    return route.fulfill({ json: { story: fixture.state.story } });
  });

  await fixture.open();
  await page.locator('[data-tour="model-button"]').click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();

  const modelsPage = page.getByRole("dialog", { name: "Models", exact: true });
  await expect(modelsPage).toContainText("This story uses OpenRouter, not Anthropic.");
  await expect(modelsPage).toContainText("Test model");
  await expect(modelsPage).not.toContainText("Claude Sonnet 5.5");
  expect(modelRequests).toContain("openrouter");

  await modelsPage.getByRole("button", { name: "Move to Anthropic" }).click();

  await expect.poll(() => moveRequests).toEqual([{ id: "anthropic" }]);
  await expect(modelsPage).not.toContainText("This story uses OpenRouter");
  await expect(modelsPage).toContainText("Claude Sonnet 5.5");
  await expect(modelsPage).not.toContainText("Test model");
  await expect(page.getByText("Story moved to Anthropic")).toBeVisible();
});
