import { test, expect } from "@playwright/test";
import { installWriteApi } from "./writeReliability.fixture.js";

const modes = [
  { name: "chat", path: "/chat/chat-1" },
  { name: "write", path: "/write/story/story-1/chapter/chapter-1" },
  { name: "brainstorm", path: "/write/story/story-1/brainstorm" },
];

for (const mode of modes) {
  for (const width of [1440, 390, 320]) {
    test(`${mode.name} composer compacts and expands at ${width}px`, async ({ page }) => {
      await installWriteApi(page);
      await page.route("**/api/chats/chat-1", (route) => route.fulfill({ json: {
        chat: { id: "chat-1", title: "Test chat", model: "test/model" },
        messages: [{ id: "message-1", role: "user", content: "Hello" }],
      } }));
      await page.setViewportSize({ width, height: 900 });
      await page.goto(mode.path);
      const surface = page.locator(".adaptive-composer");
      const input = surface.locator("textarea");
      await expect(surface).toHaveClass(/compact-composer/);
      await expect(input).toBeVisible();
      await input.fill("Hi");
      await expect(surface).toHaveClass(/compact-composer/);
      const background = await surface.evaluate((element) => getComputedStyle(element).backgroundColor);
      const bounds = await surface.boundingBox();
      expect(bounds.height).toBeLessThanOrEqual(54);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      for (const control of await surface.locator(".composer-left, .composer-input, .composer-right").all()) {
        const controlBounds = await control.boundingBox();
        expect(controlBounds.x).toBeGreaterThanOrEqual(bounds.x);
        expect(controlBounds.x + controlBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(Math.abs(controlBounds.y + controlBounds.height / 2 - bounds.y - bounds.height / 2)).toBeLessThanOrEqual(1);
      }
      await page.screenshot({ path: `/tmp/compact-${mode.name}-${width}.png`, animations: "disabled" });
      await input.fill("First line\nSecond line");
      await expect(surface).not.toHaveClass(/compact-composer/);
      await expect(surface).toHaveCSS("background-color", background);
      await input.fill("This is a long prompt that wraps across the available space. ".repeat(12));
      await expect(surface).not.toHaveClass(/compact-composer/);
      await input.fill("");
      await expect(surface).toHaveClass(/compact-composer/);
      if (mode.name === "write") {
        await surface.getByRole("button", { name: /Writing tools/ }).click();
        await expect(page.getByRole("menuitem", { name: /Lorebook Story knowledge/ })).toBeVisible();
      }
      if (mode.name === "brainstorm") {
        await surface.getByRole("button", { name: /New ideas:/ }).click();
        await expect(page.getByRole("slider", { name: "Number of new ideas" })).toBeVisible();
      }
    });
  }
}
