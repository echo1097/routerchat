import { test, expect } from "@playwright/test";
import { installWriteApi } from "./writeReliability.fixture.js";

async function editCanvas(page, content) {
  const editor = page.getByRole("textbox", { name: "Chapter canvas" });
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

test("opens existing Markdown in the rich canvas without rewriting it", async ({ page }) => {
  const legacyContent = [
    "# Legacy chapter",
    "",
    "A **bold passage** with *quiet emphasis* and `inline code`.",
    "",
    "1. First route",
    "    - Nested route",
    "",
    "> An old warning remains.",
    "",
    "```text",
    "the sealed door",
    "```",
    "",
    "[Open map](https://example.com/map)",
  ].join("\n");
  const api = await installWriteApi(page, { legacyContent });
  await api.open();

  const editor = page.getByRole("textbox", { name: "Chapter canvas" });
  await expect(editor.locator("h1")).toHaveText("Legacy chapter");
  await expect(editor.locator("strong")).toHaveText("bold passage");
  await expect(editor.locator("em")).toHaveText("quiet emphasis");
  await expect(editor.locator("ol")).toContainText("First route");
  await expect(editor.locator("ul").filter({ hasText: "Nested route" }).first()).toContainText("Nested route");
  await expect(editor.locator("blockquote")).toContainText("An old warning remains.");
  await expect(editor.locator("code").filter({ hasText: "the sealed door" })).toContainText("the sealed door");
  await expect(editor.getByRole("link", { name: "Open map" })).toBeVisible();

  await page.waitForTimeout(750);
  expect(api.state.saveRequests).toHaveLength(0);
  expect(api.state.chapters[0].content).toBe(legacyContent);
});

test("uses native click placement and keeps the canvas stable while editing", async ({ page }) => {
  const legacyContent = Array.from(
    { length: 48 },
    (_, index) => `paragraph ${index + 1} has a stable target for precise canvas editing.`,
  ).join("\n\n");
  const api = await installWriteApi(page, { legacyContent });
  await api.open();

  const canvas = page.locator('[data-tour="write-chapter-canvas"]');
  const editor = page.getByRole("textbox", { name: "Chapter canvas" });
  const targetParagraph = editor.locator("p").nth(24);
  await targetParagraph.scrollIntoViewIfNeeded();

  const beforeMetrics = await targetParagraph.evaluate((node) => {
    const scroller = node.closest('[data-tour="write-chapter-canvas"]');
    return {
      scrollTop: scroller.scrollTop,
      top: node.getBoundingClientRect().top,
    };
  });
  const targetBox = await targetParagraph.boundingBox();
  await page.mouse.click(
    (targetBox?.x || 0) + (targetBox?.width || 0) - 2,
    (targetBox?.y || 0) + Math.min((targetBox?.height || 32) / 2, 16),
  );
  await page.keyboard.type(" Added at the clicked end.");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("!");

  await expect(targetParagraph).toHaveText(
    "paragraph 25 has a stable target for precise canvas editing. Added at the clicked end!",
  );
  const afterMetrics = await targetParagraph.evaluate((node) => {
    const scroller = node.closest('[data-tour="write-chapter-canvas"]');
    return {
      scrollTop: scroller.scrollTop,
      top: node.getBoundingClientRect().top,
    };
  });

  expect(Math.abs(afterMetrics.scrollTop - beforeMetrics.scrollTop)).toBeLessThan(2);
  expect(Math.abs(afterMetrics.top - beforeMetrics.top)).toBeLessThan(2);
  const canvasAfterEdit = await canvasMetrics(page);
  expect(canvasAfterEdit.scrollTop).toBeGreaterThan(0);
  expect(canvasAfterEdit.scrollTop).toBeLessThan(canvasAfterEdit.maxScroll);
  await expect.poll(() => api.state.saveRequests.length).toBe(1);
  expect(api.state.saveRequests[0].content).toContain("Added at the clicked end!");

  await page.setViewportSize({ width: 390, height: 700 });
  const mobileEditorBox = await editor.boundingBox();
  expect(mobileEditorBox?.x).toBeGreaterThanOrEqual(0);
  expect((mobileEditorBox?.x || 0) + (mobileEditorBox?.width || 0)).toBeLessThanOrEqual(390);
});

test("edits and reloads migrated Markdown with working undo and redo", async ({ page }) => {
  const legacyContent = "# Existing title\n\nA paragraph with **old formatting**.";
  const api = await installWriteApi(page, { legacyContent });
  await api.open();

  const editor = page.getByRole("textbox", { name: "Chapter canvas" });
  const paragraph = editor.locator("p");
  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Added sentence.");
  await expect(paragraph).toContainText("Added sentence.");

  const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
  const redoKey = process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z";
  await page.keyboard.press(undoKey);
  await expect(paragraph).not.toContainText("Added sentence.");
  await page.keyboard.press(redoKey);
  await expect(paragraph).toContainText("Added sentence.");

  await expect.poll(() => api.state.chapters[0].content).toContain("Added sentence.");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Chapter canvas" }).locator("h1")).toHaveText("Existing title");
  await expect(page.getByRole("textbox", { name: "Chapter canvas" }).locator("strong")).toHaveText("old formatting");
  await expect(page.getByRole("textbox", { name: "Chapter canvas" })).toContainText("Added sentence.");
});

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
  await expect(page.getByRole("textbox", { name: "Chapter canvas" })).toHaveText("local draft");
  await expect(await reloadAndRead(page)).toContainText("server draft");
});
