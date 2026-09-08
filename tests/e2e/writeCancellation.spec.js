import { test, expect } from "@playwright/test";
import { installWriteApi } from "./writeReliability.fixture.js";

test("Stop waits for delayed saving before replacing streamed prose", async ({ page }) => {
  const api = await installWriteApi(page, { controlledReasoningStream: true, legacyContent: "" });
  let settled = false;
  let statusRequests = 0;
  await page.route("**/generations/cancelled-run", async (route) => {
    statusRequests += 1;
    await route.fulfill({ json: { settled } });
  });
  await api.open();
  await page.getByPlaceholder(/Ask Test model to write anything/).fill("write more");
  await page.getByRole("button", { name: "Send" }).click();
  await api.waitForReasoningStream();
  await page.evaluate(() => {
    const stream = window.__writeReasoningStream;
    stream.controller.enqueue(new TextEncoder().encode(`${JSON.stringify({
      type: "content",
      runId: stream.requestBody.generation_run_id,
      storyId: "story-1",
      chapterId: "chapter-1",
      generationId: "cancelled-run",
      value: "The streamed paragraph.",
    })}\n`));
  });
  const canvas = page.getByRole("textbox", { name: "Chapter canvas" });
  await expect(canvas).toContainText("The streamed paragraph.");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => statusRequests).toBeGreaterThanOrEqual(2);
  await expect(canvas).toContainText("The streamed paragraph.");
  expect(api.state.chapters[0].content).toBe("");

  api.state.chapters[0].content = "The streamed paragraph. Saved ending.";
  api.state.chapters[0].revision = 1;
  settled = true;
  await expect(canvas).toContainText("The streamed paragraph. Saved ending.");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});
