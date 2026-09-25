import { test, expect } from "@playwright/test";
import { installWriteApi } from "./writeReliability.fixture.js";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

const models = [
  { id: "test/model", name: "Test model", pricing: { prompt: "0.000001", completion: "0.000002" }, architecture: { output_modalities: ["text"] }, supported_parameters: [] },
  { id: "test/model:batch", name: "Test model (batch)", pricing: { prompt: "0.0000005", completion: "0.000001" }, architecture: { output_modalities: ["text"] }, supported_parameters: [] },
];

test("hides batch models from the model list when disabled", async ({ page }) => {
  const fixture = await installWriteApi(page);
  const patches = [];
  await page.route("**/api/models", (route) => route.fulfill({ json: { models } }));
  await page.route("**/api/settings", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON();
    patches.push(body);
    return route.fulfill({ json: { default_model: "test/model", ...body } });
  });

  await fixture.open();
  await page.locator('[data-tour="model-button"]').click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();

  const batchSwitch = page.getByRole("switch", { name: "Hide batch models" });
  await expect(batchSwitch).toBeVisible();
  await batchSwitch.click();
  await expect.poll(() => patches).toContainEqual({ hide_batch_models: true });

  await page.getByRole("button", { name: "Models", exact: true }).click();
  const modelsPage = page.getByRole("dialog", { name: "Models", exact: true });
  await expect(modelsPage).toContainText("Test model");
  await expect(modelsPage).not.toContainText("Test model (batch)");

  await page.getByRole("button", { name: "API", exact: true }).click();
  await page.getByRole("switch", { name: "Hide batch models" }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Models", exact: true })).toContainText("Test model (batch)");
});

test("turns prompt caching off from the api settings", async ({ page }) => {
  const fixture = await installWriteApi(page);
  const patches = [];
  await page.route("**/api/models", (route) => route.fulfill({ json: { models } }));
  await page.route("**/api/settings", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON();
    patches.push(body);
    return route.fulfill({ json: { default_model: "test/model", ...body } });
  });

  await fixture.open();
  await page.locator('[data-tour="model-button"]').click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();

  const cachingSwitch = page.getByRole("switch", { name: "Disable prompt caching" });
  await expect(cachingSwitch).toBeVisible();
  await expect(cachingSwitch).not.toBeChecked();
  await cachingSwitch.click();
  await expect.poll(() => patches).toContainEqual({ disable_prompt_caching: true });
  await expect(cachingSwitch).toBeChecked();
});

test("shows model names without the maker prefix and the maker underneath", async ({ page }) => {
  const fixture = await installWriteApi(page);
  const glm = { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", pricing: { prompt: "0.000001", completion: "0.000002" }, architecture: { output_modalities: ["text"] }, supported_parameters: [] };
  await page.route("**/api/models", (route) => route.fulfill({ json: { models: [...models, glm] } }));

  await fixture.open();
  await page.locator('[data-tour="model-button"]').click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();

  const modelsPage = page.getByRole("dialog", { name: "Models", exact: true });
  await expect(modelsPage).toContainText("GLM 5.3");
  await expect(modelsPage).toContainText("Z.ai");
  await expect(modelsPage).not.toContainText("Z.ai: GLM 5.3");
  await expect(modelsPage).not.toContainText("z-ai/glm-5.3");
});
