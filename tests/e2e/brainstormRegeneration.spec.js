import { test, expect } from "@playwright/test";
import { createDeferred, installWriteApi } from "./writeReliability.fixture.js";

async function setupBranch(page, options = {}) {
  const nodes = [
    ["root-prompt", "prompt", "Root prompt", 0, 180],
    ["original-idea", "idea", "Original idea", 390, 180],
    ["nested-prompt", "prompt", "Nested prompt", 780, 180],
    ["nested-idea", "idea", "Nested idea", 1170, 180],
    ["unrelated-idea", "idea", "Unrelated idea", 390, 500],
  ].map(([id, nodeType, title, positionX, positionY]) => ({
    id,
    story_id: "story-1",
    node_type: nodeType,
    title,
    content: title,
    position_x: positionX,
    position_y: positionY,
    status: "complete",
  }));
  const edges = [
    ["root-prompt", "original-idea"],
    ["original-idea", "nested-prompt"],
    ["nested-prompt", "nested-idea"],
  ].map(([sourceId, targetId]) => ({
    id: `${sourceId}-${targetId}`,
    source_node_id: sourceId,
    target_node_id: targetId,
  }));
  const api = await installWriteApi(page, {
    ...options,
    brainstormNodes: nodes,
    brainstormEdges: edges,
  });
  const deleteRequests = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes("/brainstorm/nodes/")) {
      deleteRequests.push(request.url());
    }
  });
  await api.openBrainstorm();

  return { api, nodes, edges, deleteRequests };
}

async function regenerateBranch(page) {
  const promptNode = page.locator('[data-id="root-prompt"]');
  await promptNode.hover();
  await promptNode.getByRole("button", { name: "Regenerate prompt" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function expectBranchPreserved(page, setup) {
  await expect(page.getByRole("button", { name: "Stop brainstorming" })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Brainstorm prompt" })).toHaveValue("Root prompt");
  expect(setup.deleteRequests).toEqual([]);
  expect(setup.api.state.brainstormNodes).toEqual(setup.nodes);
  expect(setup.api.state.brainstormEdges).toEqual(setup.edges);
  await page.reload();
  await expect(page.locator('[data-id="original-idea"]')).toBeVisible();
  await expect(page.locator('[data-id="nested-idea"]')).toBeVisible();
}

for (const failure of ["invalid key", "server error", "network error", "stream error", "empty stream"]) {
  test(`preserves the entire branch after regeneration ${failure}`, async ({ page }) => {
    const setup = await setupBranch(page);
    await page.route("**/brainstorm/generate/stream", async (route) => {
      if (failure === "network error") return route.abort("failed");
      const status = failure === "invalid key" ? 401 : failure === "server error" ? 500 : 200;
      const body = status !== 200
        ? JSON.stringify({ detail: failure })
        : failure === "stream error"
          ? `${JSON.stringify({ type: "error", value: "Invalid API key" })}\n`
          : "";
      await route.fulfill({ status, contentType: "application/x-ndjson", body });
    });

    await regenerateBranch(page);
    await expectBranchPreserved(page, setup);
  });
}

test("preserves the entire branch when regeneration is cancelled", async ({ page }) => {
  const setup = await setupBranch(page, { controlledBrainstormStream: true });
  await regenerateBranch(page);
  await setup.api.waitForBrainstormStream();
  expect(setup.deleteRequests).toEqual([]);
  await page.getByRole("button", { name: "Stop brainstorming" }).click();
  await expectBranchPreserved(page, setup);
});

test("replaces the original branch only after new ideas are ready", async ({ page }) => {
  const setup = await setupBranch(page);
  const generationGate = createDeferred();
  await page.route("**/brainstorm/generate/stream", async (route) => {
    await generationGate.promise;
    await route.fallback();
  });
  await regenerateBranch(page);
  await expect(page.getByRole("button", { name: "Stop brainstorming" })).toBeVisible();
  expect(setup.deleteRequests).toEqual([]);
  expect(setup.api.state.brainstormNodes).toEqual(setup.nodes);

  generationGate.resolve();
  await expect(page.locator('[data-id="root-prompt"]')).toBeHidden();
  await expect(page.getByText("Generated idea", { exact: true })).toBeVisible();
  expect(setup.deleteRequests).toHaveLength(1);
  expect(setup.api.state.brainstormNodes.map((node) => node.id).sort()).toEqual([
    "generated-idea-1", "generated-prompt-1", "unrelated-idea",
  ]);
  expect(setup.api.state.brainstormEdges).toHaveLength(1);
  await page.reload();
  await expect(page.getByText("Generated idea", { exact: true })).toBeVisible();
  await expect(page.locator('[data-id="root-prompt"]')).toBeHidden();
});

test("keeps both branches if deleting the original branch fails", async ({ page }) => {
  const setup = await setupBranch(page);
  await page.route("**/brainstorm/nodes/root-prompt?**", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Could not delete the original branch" }),
    });
  });
  await regenerateBranch(page);
  await expect.poll(() => setup.deleteRequests.length).toBe(1);
  await expect(page.getByText("Generated idea", { exact: true })).toBeVisible();
  expect(setup.api.state.brainstormNodes).toEqual(expect.arrayContaining(setup.nodes));
  expect(setup.api.state.brainstormEdges).toEqual(expect.arrayContaining(setup.edges));
  await page.reload();
  await expect(page.locator('[data-id="original-idea"]')).toBeVisible();
  await expect(page.getByText("Generated idea", { exact: true })).toBeVisible();
});
