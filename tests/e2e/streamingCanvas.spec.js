import { test, expect } from "@playwright/test";
import { installWriteApi } from "./writeReliability.fixture.js";

//lexical cannot hold the word spans, so a chapter streams through a stand in canvas and hands control
//back to the real editor once the run finishes

async function enableSmoothText(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "routerchat.appSettings",
      JSON.stringify({ smooth_streaming: true }),
    );
  });
}

async function pushContent(page, value) {
  await page.evaluate((nextValue) => {
    const stream = window.__writeReasoningStream;
    if (!stream) throw new Error("stream is not ready");

    const event = {
      type: "content",
      runId: stream.requestBody.generation_run_id,
      storyId: "story-1",
      chapterId: "chapter-1",
      revision: stream.requestBody.chapter_revision,
      value: nextValue,
    };
    stream.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
  }, value);
}

test("streams a chapter through the word canvas and hands back to the editor", async ({ page }) => {
  await enableSmoothText(page);
  const api = await installWriteApi(page, {
    controlledReasoningStream: true,
    legacyContent: "",
  });
  await api.open();

  await page.getByPlaceholder(/Ask Test model to write anything/).fill("open with a storm");
  await page.getByRole("button", { name: "Send" }).click();
  await api.waitForReasoningStream();

  await pushContent(page, "the storm arrived before anyone had finished packing the truck");

  const streamCanvas = page.locator(".chapter-stream");
  await expect(streamCanvas).toBeVisible();

  //the real editor steps aside while the stand in is up
  await expect(page.getByRole("textbox", { name: "Chapter canvas" })).toHaveCount(0);

  const words = streamCanvas.locator(".t-stream-w");
  await expect.poll(() => words.count()).toBe(10);

  //words resolve in order rather than all at once
  await expect.poll(() => streamCanvas.locator(".t-stream-w.is-in").count()).toBeGreaterThan(0);
  await expect
    .poll(async () => streamCanvas.locator(".t-stream-w.is-in").count(), { timeout: 5000 })
    .toBe(10);

  //the run reconciles against the server when it finishes, so the mock has to agree
  const finalText = "the storm arrived before anyone had finished packing the truck";
  const chapter = api.state.chapters[0];
  chapter.content = finalText;
  chapter.revision += 1;
  chapter.word_count = finalText.split(/\s+/).length;

  await page.evaluate((nextChapter) => {
    const stream = window.__writeReasoningStream;
    const event = {
      type: "chapter_updated",
      runId: stream.requestBody.generation_run_id,
      storyId: "story-1",
      chapterId: "chapter-1",
      revision: nextChapter.revision,
      value: { chapter: nextChapter },
    };
    stream.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
  }, chapter);

  await api.closeReasoningStream();

  //the editor comes back with the finished prose and the stand in disappears
  const editor = page.getByRole("textbox", { name: "Chapter canvas" });
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("the storm arrived");
  await expect(page.locator(".chapter-stream")).toHaveCount(0);
});
