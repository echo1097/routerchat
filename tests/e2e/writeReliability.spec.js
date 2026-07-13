import { test, expect } from "@playwright/test";
import { installWriteApi } from "./writeReliability.fixture.js";

async function editCanvas(page, content) {
  const editor = page.getByPlaceholder("Start writing here, or prompt the model to begin.");
  if (!await editor.isVisible()) {
    await page.getByRole("textbox", { name: "Chapter canvas" }).click();
  }
  await editor.fill(content);
}

async function reloadAndRead(page) {
  await page.reload();
  return page.getByRole("textbox", { name: "Chapter canvas" });
}

async function canvasMetrics(page) {
  return page.locator('[data-tour="write-chapter-canvas"]').evaluate((node) => ({
    scrollTop: node.scrollTop,
    maxScroll: Math.max(node.scrollHeight - node.clientHeight, 0),
  }));
}

async function thinkingMetrics(page) {
  return page.getByTestId("write-thinking-scroll").evaluate((node) => ({
    scrollTop: node.scrollTop,
    maxScroll: Math.max(node.scrollHeight - node.clientHeight, 0),
  }));
}

test.describe.configure({ mode: "serial" });

test("keeps the newest debounced draft through a controlled save response", async ({ page }) => {
  const api = await installWriteApi(page);
  await api.open();
  const firstSave = api.deferSave();

  await editCanvas(page, "first draft");
  await page.waitForTimeout(650);
  await editCanvas(page, "newest draft");
  firstSave.resolve();

  await expect.poll(() => api.state.saveRequests.length).toBe(2);
  await expect.poll(() => api.state.chapters[0].content).toBe("newest draft");
  await expect(await reloadAndRead(page)).toContainText("newest draft");
});

test("flushes typing before an existing-chapter generation starts", async ({ page }) => {
  const api = await installWriteApi(page);
  await api.open();
  const saveGate = api.deferSave();
  await editCanvas(page, "manual draft");
  await page.getByPlaceholder(/Ask Test model to write anything/).fill("rewrite this");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => api.state.saveRequests.length).toBe(1);
  saveGate.resolve();
  await expect.poll(() => api.state.generationRequests.length).toBe(1);
  expect(api.state.generationRequests[0].chapter_revision).toBe(1);
  await expect(await reloadAndRead(page)).toContainText("generated text");
});

test("locks navigation during generation and keeps the other chapter unchanged", async ({ page }) => {
  const api = await installWriteApi(page, { twoChapters: true });
  await api.open();
  const generationGate = api.deferGeneration();
  await page.getByPlaceholder(/Ask Test model to write anything/).fill("write more");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => api.state.generationRequests.length).toBe(1);
  await expect(page.getByRole("button", { name: "Second", exact: true })).toBeDisabled();
  generationGate.resolve();
  await expect(await reloadAndRead(page)).toContainText("generated text");
  expect(api.state.chapters[1].content).toBe("saved second");
});

test("follows the chapter bottom until the user scrolls upward", async ({ page }) => {
  const api = await installWriteApi(page, { longContent: true });
  await api.open();
  const canvas = page.locator('[data-tour="write-chapter-canvas"]');
  const generationGate = api.deferGeneration();

  await page.getByPlaceholder(/Ask Test model to write anything/).fill("write more");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => api.state.generationRequests.length).toBe(1);
  await expect.poll(async () => {
    const metrics = await canvasMetrics(page);
    return metrics.maxScroll - metrics.scrollTop;
  }).toBeLessThan(2);

  await canvas.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    node.scrollTop = Math.max(node.scrollTop - node.clientHeight, 0);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const pausedMetrics = await canvasMetrics(page);
  expect(pausedMetrics.scrollTop).toBeLessThan(pausedMetrics.maxScroll - 100);

  generationGate.resolve();
  await expect(page.getByText("Finished chapter")).toBeVisible();

  const afterGeneration = await canvasMetrics(page);
  expect(afterGeneration.scrollTop).toBeLessThan(afterGeneration.maxScroll - 80);
});

test("resumes chapter auto-follow when the user returns to the bottom", async ({ page }) => {
  const api = await installWriteApi(page, { longContent: true });
  await api.open();
  const canvas = page.locator('[data-tour="write-chapter-canvas"]');
  const generationGate = api.deferGeneration();

  await page.getByPlaceholder(/Ask Test model to write anything/).fill("write more");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => api.state.generationRequests.length).toBe(1);
  await expect.poll(async () => {
    const metrics = await canvasMetrics(page);
    return metrics.maxScroll - metrics.scrollTop;
  }).toBeLessThan(2);

  await canvas.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    node.scrollTop = Math.max(node.scrollTop - node.clientHeight, 0);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await canvas.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(async () => {
    const metrics = await canvasMetrics(page);
    return metrics.maxScroll - metrics.scrollTop;
  }).toBeLessThan(2);

  generationGate.resolve();
  await expect(page.getByText("Finished chapter")).toBeVisible();

  const afterGeneration = await canvasMetrics(page);
  expect(afterGeneration.maxScroll - afterGeneration.scrollTop).toBeLessThan(2);
});

test("thinking dropdown follows new reasoning until the reader scrolls away", async ({ page }) => {
  const api = await installWriteApi(page, { controlledReasoningStream: true });
  await api.open();
  await page.getByPlaceholder(/Ask Test model to write anything/).fill("think through this");
  await page.getByRole("button", { name: "Send" }).click();
  await api.waitForReasoningStream();

  const openingReasoning = Array.from(
    { length: 36 },
    (_, index) => `step ${index + 1} checks another part of the scene before choosing what happens next.`,
  ).join("\n\n");
  await api.pushReasoning(`${openingReasoning}\n\n\`\`\`text\nquiet code block\n\`\`\``);

  const toggle = page.getByRole("button", { name: "Expand thinking details" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect((await toggle.boundingBox())?.height).toBeGreaterThanOrEqual(40);

  await toggle.focus();
  await toggle.press("Enter");
  await expect(page.getByRole("region", { name: "Thinking details" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse thinking details" })).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => {
    const metrics = await thinkingMetrics(page);
    return metrics.maxScroll - metrics.scrollTop;
  }).toBeLessThan(2);

  await api.pushReasoning("\n\na new thought arrives while the reader is following the output.");
  await expect.poll(async () => {
    const metrics = await thinkingMetrics(page);
    return metrics.maxScroll - metrics.scrollTop;
  }).toBeLessThan(2);

  const thinkingScroll = page.getByTestId("write-thinking-scroll");
  await thinkingScroll.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    node.scrollTop = Math.max(node.scrollTop - 180, 0);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const pausedMetrics = await thinkingMetrics(page);
  await api.pushReasoning("\n\nthis update should not steal the readers place.");
  await page.waitForTimeout(100);
  const afterPausedUpdate = await thinkingMetrics(page);
  expect(afterPausedUpdate.scrollTop).toBe(pausedMetrics.scrollTop);
  expect(afterPausedUpdate.maxScroll - afterPausedUpdate.scrollTop).toBeGreaterThan(32);

  await thinkingScroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await api.pushReasoning("\n\nfollowing resumes after the reader returns to the bottom.");
  await expect.poll(async () => {
    const metrics = await thinkingMetrics(page);
    return metrics.maxScroll - metrics.scrollTop;
  }).toBeLessThan(2);

  await page.setViewportSize({ width: 390, height: 700 });
  const popoverBox = await page.getByRole("region", { name: "Thinking details" }).boundingBox();
  expect(popoverBox?.x).toBeGreaterThanOrEqual(15);
  expect((popoverBox?.x || 0) + (popoverBox?.width || 0)).toBeLessThanOrEqual(375);

  await api.closeReasoningStream();
});

test("stopping a pending generation does not persist partial output", async ({ page }) => {
  const api = await installWriteApi(page);
  await api.open();
  const generationGate = api.deferGeneration();
  await page.getByPlaceholder(/Ask Test model to write anything/).fill("write more");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => api.state.generationRequests.length).toBe(1);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Response stopped")).toBeVisible();
  api.state.suppressNextGenerationCommit = true;
  generationGate.resolve();
  expect(api.state.chapters[0].content).toBe("saved opening");
});

test("restores a draft across a reload during debounce", async ({ page }) => {
  const api = await installWriteApi(page);
  await api.open();
  await editCanvas(page, "reload draft");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Chapter canvas" })).toContainText("reload draft");
  await expect.poll(() => api.state.chapters[0].content).toBe("reload draft");
});

test("flushes a pending chapter draft before switching to chat", async ({ page }) => {
  const api = await installWriteApi(page);
  await api.open();
  const saveGate = api.deferSave();
  await editCanvas(page, "switch draft");
  await page.getByText("Chat", { exact: true }).first().click();
  await expect.poll(() => api.state.saveRequests.length).toBe(1);
  saveGate.resolve();
  await expect(page).toHaveURL(/\?mode=chat/);
  expect(api.state.chapters[0].content).toBe("switch draft");
});

test("preserves the local draft and exposes a server conflict", async ({ page }) => {
  const api = await installWriteApi(page);
  await api.open();
  api.state.chapters[0].content = "server draft";
  api.state.chapters[0].revision = 1;
  api.state.conflictNextSave = true;
  await editCanvas(page, "local draft");
  await page.waitForTimeout(650);
  await expect(page.getByText("Conflict", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Start writing here, or prompt the model to begin.")).toHaveValue("local draft");
  await expect(await reloadAndRead(page)).toContainText("server draft");
});
