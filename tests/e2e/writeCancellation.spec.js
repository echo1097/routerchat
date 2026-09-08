import { test, expect } from "@playwright/test";
import { installWriteApi } from "./writeReliability.fixture.js";

for (const sendContent of [true, false]) {
  test(`Stop waits for delayed saving ${sendContent ? "after content" : "before the first event"}`, async ({ page }) => {
    const api = await installWriteApi(page, { controlledReasoningStream: true, legacyContent: "" });
    let settled = false;
    let statusRequests = 0;
    let expectedGenerationId;
    await page.route("**/generations/*", async (route) => {
      expect(route.request().url().split("/").at(-1)).toBe(expectedGenerationId);
      statusRequests += 1;
      await route.fulfill({ json: { settled } });
    });
    await api.open();
    await page.getByPlaceholder(/Ask Test model to write anything/).fill("write more");
    await page.getByRole("button", { name: "Send" }).click();
    await api.waitForReasoningStream();
    expectedGenerationId = await page.evaluate(() => window.__writeReasoningStream.requestBody.generation_status_id);
    expect(expectedGenerationId).toBeTruthy();
    if (sendContent) await page.evaluate(() => {
      const stream = window.__writeReasoningStream;
      stream.controller.enqueue(new TextEncoder().encode(`${JSON.stringify({
        type: "content",
        runId: stream.requestBody.generation_run_id,
        storyId: "story-1",
        chapterId: "chapter-1",
        generationId: stream.requestBody.generation_status_id,
        value: "The streamed paragraph.",
      })}\n`));
    });
    const canvas = page.getByRole("textbox", { name: "Chapter canvas" });
    if (sendContent) await expect(canvas).toContainText("The streamed paragraph.");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => statusRequests).toBeGreaterThanOrEqual(2);
    if (sendContent) await expect(canvas).toContainText("The streamed paragraph.");
    expect(api.state.chapters[0].content).toBe("");

    api.state.chapters[0].content = "The streamed paragraph. Saved ending.";
    api.state.chapters[0].revision = 1;
    settled = true;
    await expect(canvas).toContainText("The streamed paragraph. Saved ending.");
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  });
}
