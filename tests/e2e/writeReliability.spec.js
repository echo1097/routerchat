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
