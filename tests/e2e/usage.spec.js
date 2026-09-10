import { test, expect } from "@playwright/test";
import { installWriteApi } from "./writeReliability.fixture.js";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

function makeUsage(empty = false) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const cost = empty ? 0 : [0.12, 0.48, 0.19, 0.76, 0.32, 0.15, 0.28][index];
    return {
      date: `2026-09-0${index + 3}`, cost, requests: empty ? 0 : index + 2,
      totalTokens: empty ? 0 : 20000 + index * 8000,
      promptTokens: empty ? 0 : 15000 + index * 6000,
      outputTokens: empty ? 0 : 4000 + index * 1500,
      reasoningTokens: empty ? 0 : 1000 + index * 500,
      blendedCost: empty ? null : 1.8,
      models: empty ? {} : { "test/model": cost * 0.7, "other/model": cost * 0.3 },
    };
  });
  const current = {
    cost: empty ? 0 : 2.3, requests: empty ? 0 : 35, totalTokens: empty ? 0 : 308000,
    blendedCost: empty ? null : 7.47, missingCost: 0, missingTokens: 0,
  };
  return {
    startDate: "2026-09-03", endDate: "2026-09-09", days, current,
    previous: { cost: 3.2, requests: 42, totalTokens: 420000, blendedCost: 7.62 },
    models: empty ? [] : [
      { id: "test/model", cost: 1.61, requests: 24, totalTokens: 215600 },
      { id: "other/model", cost: 0.69, requests: 11, totalTokens: 92400 },
    ],
  };
}

async function openUsage(page, data) {
  const fixture = await installWriteApi(page);
  await page.route("**/api/usage?**", (route) => route.fulfill({ json: data }));
  await fixture.open();
  await page.locator('[data-tour="model-button"]').click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  const usageControl = page.viewportSize().width < 768 ? page.getByRole("tab", { name: "Usage", exact: true }) : page.getByRole("button", { name: "Usage", exact: true });
  await usageControl.click();
  return page.getByRole("dialog", { name: "Usage", exact: true });
}

test("shows weekly spending and model details without provider requests", async ({ page }, testInfo) => {
  const dialog = await openUsage(page, makeUsage());
  await expect(dialog.getByRole("region", { name: "Total spend", exact: true })).toContainText("$2.30");
  await expect(dialog.getByRole("region", { name: "Requests", exact: true })).toContainText("35");
  await expect(dialog.getByRole("region", { name: "Usage by model", exact: true })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Token breakdown", exact: true })).toBeVisible();
  await expect(dialog.getByRole("table")).toContainText("Test model");
  await expect(dialog.getByRole("table")).toContainText("$1.61");
  await page.screenshot({ path: testInfo.outputPath("usage-desktop.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "API", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "API", exact: true })).toBeVisible();
});

test("fits the empty usage page on a narrow screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openUsage(page, makeUsage(true));
  await expect(dialog).toContainText("No recorded spend this week");
  await expect(dialog).toContainText("Your model usage will appear here.");
  await expect(dialog.getByRole("region", { name: "Cost / 1M tokens", exact: true })).toHaveCount(0);
  const overflow = await dialog.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("usage-mobile.png"), animations: "disabled" });
});

test("retries a failed request and reloads usage when reopened", async ({ page }) => {
  const fixture = await installWriteApi(page);
  let requestCount = 0;
  await page.route("**/api/usage?**", (route) => {
    requestCount += 1;
    return requestCount === 1 ? route.fulfill({ status: 500, json: { detail: "Unavailable" } }) : route.fulfill({ json: makeUsage() });
  });
  await fixture.open();
  await page.locator('[data-tour="model-button"]').click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Usage could not be loaded.");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "Total spend", exact: true })).toContainText("$2.30");
  await expect(page.getByRole("button", { name: "Refresh usage" })).toHaveCount(0);
  await page.getByRole("dialog", { name: "Usage", exact: true }).getByRole("button", { name: "Close settings" }).click();
  await page.locator('[data-tour="model-button"]').click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  await expect.poll(() => requestCount).toBe(3);
});

test("distinguishes missing costs from free usage", async ({ page }) => {
  const data = makeUsage();
  data.current.cost = null;
  data.current.missingCost = 35;
  data.current.missingTokens = 2;
  const dialog = await openUsage(page, data);
  await expect(dialog.getByRole("region", { name: "Total spend", exact: true })).toContainText("Unavailable");
  await expect(dialog).toContainText("35 requests have no recorded cost; 2 have incomplete token details.");
});

test("inspects daily summary values and restores weekly totals", async ({ page }, testInfo) => {
  const dialog = await openUsage(page, makeUsage());
  const metrics = [
    { name: "Total spend", daily: "$0.76", weekly: "$2.30" },
    { name: "Requests", daily: "5", weekly: "35" },
    { name: "Token volume", daily: "44K", weekly: "308K" },
  ];

  await expect(dialog.locator(".usage-metric")).toHaveCount(3);
  for (const metric of metrics) {
    const card = dialog.getByRole("region", { name: metric.name, exact: true });
    const graph = card.getByRole("slider");
    await graph.hover();
    await expect(card.locator("strong")).toHaveText(metric.daily);
    await expect(card.locator("p")).toHaveText("Sep 6");
    await expect(graph.locator("circle")).toBeVisible();
    await card.getByRole("heading").hover();
    await expect(card.locator("strong")).toHaveText(metric.weekly);
    await expect(graph.locator("circle")).toHaveCount(0);
  }

  const requests = dialog.getByRole("region", { name: "Requests", exact: true });
  const graph = requests.getByRole("slider");
  await graph.focus();
  await graph.press("Home");
  await expect(requests.locator("strong")).toHaveText("2");
  await expect(requests.locator("p")).toHaveText("Sep 3");
  await graph.press("ArrowRight");
  await expect(requests.locator("strong")).toHaveText("3");
  await expect(requests.locator("p")).toHaveText("Sep 4");
  await page.screenshot({ path: testInfo.outputPath("usage-daily-selection.png"), animations: "disabled" });
  await graph.press("Tab");
  await expect(requests.locator("strong")).toHaveText("35");
});
