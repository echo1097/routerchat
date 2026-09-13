import { test, expect } from "@playwright/test";

async function mockLanding(page) {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses = {
      "/api/tos": { hash: "test", accepted: true },
      "/api/settings/key-status": { has_key: true },
      "/api/settings": { default_model: "test/model" },
      "/api/models": { models: [{ id: "test/model", name: "Test model", context_length: 128000 }] },
      "/api/chats": { chats: [] },
      "/api/stories": { stories: [] },
      "/api/folders": { folders: [] },
    };
    return route.fulfill({ json: responses[path] || {} });
  });
  await page.goto("/");
}

test("landing prompt expands for wrapped text and collapses when cleared", async ({ page }) => {
  await mockLanding(page);
  const input = page.getByPlaceholder("Ask anything", { exact: true });
  const surface = page.locator(".voice-surface");
  await expect(surface).toHaveClass(/landing-composer-compact/);
  await input.fill("Hello there");
  await expect(surface).toHaveClass(/landing-composer-compact/);
  await input.fill("First line\nSecond line");
  await expect(surface).not.toHaveClass(/landing-composer-compact/);
  await input.fill("A longer prompt that will automatically wrap across several lines. ".repeat(6));
  await expect(surface).not.toHaveClass(/landing-composer-compact/);
  await input.fill("");
  await expect(surface).toHaveClass(/landing-composer-compact/);
  await page.screenshot({ path: "/tmp/landing-composer-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(surface).toHaveClass(/landing-composer-compact/);
  const bounds = await surface.boundingBox();
  expect(bounds.height).toBeLessThanOrEqual(56);
  expect(bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/landing-composer-mobile.png", animations: "disabled" });
  await input.fill("A prompt that fits on desktop but wraps on mobile");
  await expect(surface).not.toHaveClass(/landing-composer-compact/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(surface).toHaveClass(/landing-composer-compact/);
});
