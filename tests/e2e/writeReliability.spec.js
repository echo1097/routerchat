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

test("stabilizes brainstorm handles, selection, and structural framing", async ({ page }) => {
  const api = await installWriteApi(page, {
    brainstormNodes: [
      {
        id: "root-prompt",
        story_id: "story-1",
        node_type: "prompt",
        title: "Prompt",
        content: "Root prompt",
        position_x: 0,
        position_y: 180,
        status: "complete",
      },
      {
        id: "parent-idea",
        story_id: "story-1",
        node_type: "idea",
        title: "Parent idea",
        content: "The branch starts here.",
        position_x: 390,
        position_y: 80,
        status: "complete",
      },
      {
        id: "branch-prompt",
        story_id: "story-1",
        node_type: "prompt",
        title: "Prompt",
        content: "Branch prompt",
        position_x: 780,
        position_y: 80,
        status: "complete",
      },
      {
        id: "disposable-idea",
        story_id: "story-1",
        node_type: "idea",
        title: "Disposable",
        content: "Delete this selected idea.",
        position_x: 390,
        position_y: 360,
        status: "complete",
      },
    ],
    brainstormEdges: [
      {
        id: "edge-root-parent",
        source_node_id: "root-prompt",
        target_node_id: "parent-idea",
      },
      {
        id: "edge-parent-branch",
        source_node_id: "parent-idea",
        target_node_id: "branch-prompt",
      },
      {
        id: "edge-root-disposable",
        source_node_id: "root-prompt",
        target_node_id: "disposable-idea",
      },
    ],
    brainstormViewport: { x: 120, y: 80, zoom: 0.8 },
  });
  await api.openBrainstorm();

  const workspace = page.locator(".brainstorm-workspace");
  await expect.poll(() => workspace.evaluate((node) => (
    getComputedStyle(node).backgroundImage
  ))).toBe("none");

  const rootPrompt = page.locator(".react-flow__node-prompt").filter({ hasText: "Root prompt" });
  const branchPrompt = page.locator(".react-flow__node-prompt").filter({ hasText: "Branch prompt" });
  await expect(rootPrompt).toHaveClass(/draggable/);
  await expect(rootPrompt).toHaveCSS("cursor", "grab");
  await expect(rootPrompt.locator(".react-flow__handle-left")).toHaveCount(0);
  await expect(rootPrompt.locator(".react-flow__handle-right")).toHaveCount(1);
  await expect(branchPrompt.locator(".react-flow__handle-left")).toHaveCount(1);

  const viewport = page.locator(".react-flow__viewport");
  const initialTransform = await viewport.getAttribute("style");
  const disposableIdea = page.locator(".react-flow__node-idea").filter({ hasText: "Disposable" });
  await disposableIdea.click();
  await disposableIdea.hover();
  await disposableIdea.getByRole("button", { name: "Delete idea" }).click();
  await expect(disposableIdea).toBeHidden();
  await expect.poll(() => api.state.brainstormViewportRequests.length).toBeGreaterThan(0);
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(initialTransform);
  const viewportRequestsAfterDelete = api.state.brainstormViewportRequests.length;

  const promptInput = page.getByRole("textbox", { name: "Brainstorm prompt" });
  await promptInput.fill("Try another root direction");
  await promptInput.press("Enter");
  await expect.poll(() => api.state.brainstormGenerationRequests.length).toBe(1);
  expect(api.state.brainstormGenerationRequests[0].selected_idea_ids).toEqual([]);
  await expect.poll(
    () => api.state.brainstormViewportRequests.length,
  ).toBeGreaterThan(viewportRequestsAfterDelete);
});

test("dismisses brainstorm regeneration confirmation before the stream finishes", async ({ page }) => {
  const api = await installWriteApi(page, {
    controlledBrainstormStream: true,
    brainstormNodes: [
      {
        id: "root-prompt",
        story_id: "story-1",
        node_type: "prompt",
        title: "Prompt",
        content: "Root prompt",
        position_x: 0,
        position_y: 180,
        status: "complete",
      },
      {
        id: "child-idea",
        story_id: "story-1",
        node_type: "idea",
        title: "Original idea",
        content: "An idea to replace.",
        position_x: 390,
        position_y: 180,
        status: "complete",
      },
    ],
    brainstormEdges: [
      {
        id: "root-child",
        source_node_id: "root-prompt",
        target_node_id: "child-idea",
      },
    ],
  });
  await api.openBrainstorm();

  const promptNode = page.locator(".react-flow__node-prompt");
  await promptNode.hover();
  await promptNode.getByRole("button", { name: "Regenerate prompt" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Regenerate this prompt?");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Original idea", { exact: true })).toBeVisible();

  await promptNode.hover();
  await promptNode.getByRole("button", { name: "Regenerate prompt" }).click();
  await dialog.getByRole("button", { name: "Regenerate", exact: true }).click();
  await api.waitForBrainstormStream();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Original idea", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Stop brainstorming" })).toBeVisible();
  await api.closeBrainstormStream();
});

test("resets the brainstorm camera after deleting the final node", async ({ page }) => {
  const api = await installWriteApi(page, {
    brainstormNodes: [
      {
        id: "only-prompt",
        story_id: "story-1",
        node_type: "prompt",
        title: "Prompt",
        content: "Only prompt",
        position_x: 0,
        position_y: 180,
        status: "complete",
      },
    ],
    brainstormViewport: { x: 180, y: 120, zoom: 0.7 },
  });
  await api.openBrainstorm();

  const onlyPrompt = page.locator(".react-flow__node-prompt").filter({ hasText: "Only prompt" });
  await onlyPrompt.hover();
  await onlyPrompt.getByRole("button", { name: "Delete prompt" }).click();
  await expect(page.getByText("Start anywhere")).toBeVisible();
  await expect.poll(() => api.state.brainstormViewportRequests.at(-1)).toEqual({
    position_x: 0,
    position_y: 0,
    zoom: 1,
  });
});

test("keeps completed brainstorm thinking on its prompt node", async ({ page }) => {
  const reasoning = "The signal should force a choice before it explains itself.";
  const api = await installWriteApi(page, {
    brainstormReasoning: reasoning,
    brainstormNodes: [
      {
        id: "failed-prompt",
        story_id: "story-1",
        node_type: "prompt",
        title: "Prompt",
        content: "Retry this failed direction.",
        position_x: -390,
        position_y: 180,
        status: "failed",
      },
    ],
  });
  await api.openBrainstorm();

  const promptInput = page.getByRole("textbox", { name: "Brainstorm prompt" });
  await promptInput.fill("How should the signal change the story?");
  await promptInput.press("Enter");

  const promptNode = page.locator(".react-flow__node-prompt").filter({
    hasText: "How should the signal change the story?",
  });
  const thinkingButton = promptNode.getByRole("button", { name: "Expand thinking" });
  await expect(thinkingButton).toBeVisible();
  await expect(thinkingButton).toHaveAttribute("aria-expanded", "false");
  await expect(thinkingButton).toContainText("Finished in 4 seconds");

  await thinkingButton.click();
  await expect(promptNode.getByText(reasoning)).toBeVisible();
  await expect(
    promptNode.getByRole("button", { name: "Collapse thinking" }),
  ).toHaveAttribute("aria-expanded", "true");

  await page.reload();
  const restoredPromptNode = page.locator(".react-flow__node-prompt").filter({
    hasText: "How should the signal change the story?",
  });
  await expect(
    restoredPromptNode.getByRole("button", { name: "Expand thinking" }),
  ).toBeVisible();
  const failedPrompt = page.locator(".react-flow__node-prompt").filter({
    hasText: "Retry this failed direction.",
  });
  await expect(failedPrompt.getByRole("button", { name: "Retry prompt" })).toBeEnabled();
  await expect(failedPrompt.getByRole("button", { name: "Delete prompt" })).toBeEnabled();
});

test("transitions brainstorm reasoning from locked thinking to writing to completed", async ({ page }) => {
  const api = await installWriteApi(page, {
    controlledBrainstormStream: true,
    thinkingEnabled: true,
    model: {
      id: "test/model",
      name: "Test model",
      pricing: {},
      architecture: { output_modalities: ["text"] },
      supported_parameters: ["reasoning"],
      reasoning: { mandatory: false },
    },
  });
  await api.openBrainstorm();

  const promptInput = page.getByRole("textbox", { name: "Brainstorm prompt" });
  await promptInput.fill("Follow the full reasoning lifecycle.");
  await promptInput.press("Enter");
  await api.waitForBrainstormStream();

  const promptNodeValue = {
    id: "controlled-prompt",
    story_id: "story-1",
    node_type: "prompt",
    title: "Prompt",
    content: "Follow the full reasoning lifecycle.",
    position_x: 0,
    position_y: 180,
    status: "generating",
  };
  await api.pushBrainstormEvent({
    type: "prompt",
    value: { node: promptNodeValue, edges: [] },
  });

  const promptNode = page.locator(".react-flow__node-prompt").filter({
    hasText: "Follow the full reasoning lifecycle.",
  });
  const thinkingTrigger = promptNode.getByRole("button", {
    name: "Thinking in progress",
  });
  await expect(thinkingTrigger).toBeDisabled();
  await expect(thinkingTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(thinkingTrigger).toHaveText("Thinking");

  await api.pushBrainstormEvent({
    type: "reasoning",
    value: "The signal needs one final consequence.",
  });
  await expect(
    promptNode.getByText("The signal needs one final consequence."),
  ).toBeVisible();

  await api.pushBrainstormEvent({ type: "working", value: null });
  const writingTrigger = promptNode.getByRole("button", {
    name: "Writing in progress",
  });
  await expect(writingTrigger).toBeDisabled();
  await expect(writingTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(writingTrigger).toHaveText("Writing");
  const writingPanel = promptNode.locator(".brainstorm-thinking-panel");
  await expect(writingPanel).toHaveAttribute("aria-hidden", "true");
  await expect.poll(
    () => writingPanel.evaluate((panel) => Math.round(panel.getBoundingClientRect().height)),
  ).toBe(0);

  await api.pushBrainstormEvent({
    type: "ideas",
    value: {
      nodes: [],
      edges: [],
      duration_ms: 4200,
    },
  });
  const completedTrigger = promptNode.getByRole("button", {
    name: "Expand thinking",
  });
  await expect(completedTrigger).toBeEnabled();
  await expect(completedTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(completedTrigger).toHaveText("Finished in 4 seconds");

  await api.closeBrainstormStream();
});

test("keeps brainstorm nodes measured while reasoning streams", async ({ page }) => {
  const api = await installWriteApi(page, {
    controlledBrainstormStream: true,
    thinkingEnabled: true,
    model: {
      id: "test/model",
      name: "Test model",
      pricing: {},
      architecture: { output_modalities: ["text"] },
      supported_parameters: ["reasoning"],
      reasoning: { mandatory: false },
    },
  });
  await api.openBrainstorm();

  const promptInput = page.getByRole("textbox", { name: "Brainstorm prompt" });
  await promptInput.fill("Hold the cursor over this node.");
  await promptInput.press("Enter");
  await api.waitForBrainstormStream();

  await api.pushBrainstormEvent({
    type: "prompt",
    value: {
      node: {
        id: "measured-prompt",
        story_id: "story-1",
        node_type: "prompt",
        title: "Prompt",
        content: "Hold the cursor over this node.",
        position_x: 0,
        position_y: 180,
        status: "generating",
      },
      edges: [],
    },
  });

  const promptNode = page.locator(".react-flow__node-prompt").filter({
    hasText: "Hold the cursor over this node.",
  });
  await expect(promptNode).toBeVisible();

  // A node that loses its measured dimensions renders as `visibility: hidden`, which drops it out
  // of hit testing and makes the cursor flicker to the canvas pan cursor mid-generation.
  await page.evaluate(() => {
    window.__hiddenNodeCount = 0;
    window.__nodeVisibilityObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target.style?.visibility === "hidden") window.__hiddenNodeCount += 1;
      }
    });
    for (const node of document.querySelectorAll(".react-flow__node")) {
      window.__nodeVisibilityObserver.observe(node, {
        attributes: true,
        attributeFilter: ["style"],
      });
    }
  });

  for (let index = 0; index < 10; index += 1) {
    await api.pushBrainstormEvent({
      type: "reasoning",
      value: `Reasoning chunk ${index} keeps the node growing. `,
    });
  }
  await expect(promptNode.getByText(/Reasoning chunk 9/)).toBeVisible();

  expect(await page.evaluate(() => window.__hiddenNodeCount)).toBe(0);

  await api.closeBrainstormStream();
});

test("locks active brainstorm thinking and skips thoughts for instant writing", async ({ page }) => {
  const api = await installWriteApi(page, {
    brainstormNodes: [
      {
        id: "thinking-prompt",
        story_id: "story-1",
        node_type: "prompt",
        title: "Prompt",
        content: "Think through the signal.",
        reasoning: "Checking the signal against every known consequence.",
        generation_phase: "thinking",
        position_x: 0,
        position_y: 120,
        status: "generating",
      },
      {
        id: "working-prompt",
        story_id: "story-1",
        node_type: "prompt",
        title: "Prompt",
        content: "Answer without thinking.",
        reasoning: "",
        generation_phase: "working",
        position_x: 390,
        position_y: 120,
        status: "generating",
      },
      {
        id: "failed-prompt",
        story_id: "story-1",
        node_type: "prompt",
        title: "Prompt",
        content: "A failed direction waiting for retry.",
        position_x: 780,
        position_y: 120,
        status: "failed",
      },
    ],
  });
  await api.openBrainstorm();

  const thinkingNode = page.locator(".react-flow__node-prompt").filter({
    hasText: "Think through the signal.",
  });
  const thinkingTrigger = thinkingNode.getByRole("button", {
    name: "Thinking in progress",
  });
  await expect(thinkingTrigger).toBeDisabled();
  await expect(thinkingTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(thinkingTrigger).toContainText("Thinking");
  await expect(thinkingTrigger.locator("svg")).toHaveCount(0);
  await expect(
    thinkingNode.getByText("Checking the signal against every known consequence."),
  ).toBeVisible();

  await thinkingTrigger.evaluate((button) => button.click());
  await expect(thinkingTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(thinkingNode.getByRole("button", { name: "Delete prompt" })).toBeDisabled();

  const workingNode = page.locator(".react-flow__node-prompt").filter({
    hasText: "Answer without thinking.",
  });
  await expect(workingNode.getByRole("button", { name: "Delete prompt" })).toBeDisabled();
  await expect(workingNode.locator(".brainstorm-writing-status")).toHaveText("Writing");
  await expect(workingNode.locator(".brainstorm-thinking")).toHaveCount(0);
  await expect(workingNode.locator(".brainstorm-thinking-trigger")).toHaveCount(0);

  const failedNode = page.locator(".react-flow__node-prompt").filter({
    hasText: "A failed direction waiting for retry.",
  });
  await expect(failedNode.getByRole("button", { name: "Retry prompt" })).toHaveCount(0);
  await expect(failedNode.getByRole("button", { name: "Delete prompt" })).toBeDisabled();
});

test("collapses and locks completed thoughts while a brainstorm response is writing", async ({ page }) => {
  const reasoning = Array.from(
    { length: 18 },
    (_, index) => `Reasoning step ${index + 1} checks a different consequence.`,
  ).join("\n\n");
  const api = await installWriteApi(page, {
    brainstormNodes: [
      {
        id: "live-prompt",
        story_id: "story-1",
        node_type: "prompt",
        title: "Prompt",
        content: "Explore the consequences of the signal.",
        reasoning,
        generation_phase: "working",
        position_x: 0,
        position_y: 180,
        status: "generating",
      },
    ],
  });
  await api.openBrainstorm();

  const promptNode = page.locator(".react-flow__node-prompt").filter({
    hasText: "Explore the consequences of the signal.",
  });
  await expect(promptNode.getByRole("button", { name: "Delete prompt" })).toBeDisabled();
  const thinkingTrigger = promptNode.getByRole("button", { name: "Writing in progress" });
  await expect(thinkingTrigger).toBeDisabled();
  await expect(thinkingTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(promptNode.locator(".brainstorm-thinking-panel")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect.poll(
    () => promptNode.locator(".brainstorm-thinking-panel").evaluate(
      (panel) => Math.round(panel.getBoundingClientRect().height),
    ),
  ).toBe(0);
  const thinkingLabel = promptNode.locator(".brainstorm-thinking-label");
  await expect(thinkingLabel).toHaveClass(/t-shimmer/);
  await expect(thinkingLabel).toHaveAttribute("data-text", "Writing");
  await expect(thinkingLabel).toHaveText("Writing");

  const thinkingChevron = promptNode.locator(".brainstorm-thinking-trigger svg");
  await expect(thinkingChevron).toHaveCount(0);
  await expect(thinkingTrigger).toHaveCSS("cursor", "default");
  await expect(thinkingTrigger).toHaveClass(/nodrag/);
  await expect(thinkingTrigger).toHaveClass(/nopan/);
  const thinkingWrapper = promptNode.locator(".brainstorm-thinking");
  await expect(thinkingWrapper).toHaveClass(/nodrag/);
  await expect(thinkingWrapper).toHaveClass(/nopan/);
  await expect(thinkingWrapper).toHaveCSS("cursor", "default");
  await expect(thinkingTrigger).toHaveCSS("padding-right", "4px");

  async function readTriggerHitTargets() {
    return thinkingTrigger.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return [0.08, 0.5, 0.9, 0.97].map((horizontalPosition) => {
        const target = document.elementFromPoint(
          rect.left + rect.width * horizontalPosition,
          rect.top + rect.height / 2,
        );
        return {
          ownsHit: target === button,
          cursor: target ? getComputedStyle(target).cursor : null,
        };
      });
    });
  }

  await expect.poll(readTriggerHitTargets).toEqual(
    Array.from({ length: 4 }, () => ({ ownsHit: true, cursor: "default" })),
  );

  const nodeTransform = await promptNode.evaluate((node) => getComputedStyle(node).transform);
  await thinkingTrigger.evaluate((button) => button.click());
  await expect(thinkingTrigger).toHaveAttribute("aria-expanded", "false");
  await expect.poll(readTriggerHitTargets).toEqual(
    Array.from({ length: 4 }, () => ({ ownsHit: true, cursor: "default" })),
  );
  await expect.poll(
    () => promptNode.evaluate((node) => getComputedStyle(node).transform),
  ).toBe(nodeTransform);

  // a node that is still generating stays pinned to the canvas — dragging it pans the viewport
  // instead, so the node keeps its own transform and never gets a position PATCH
  const promptBox = await promptNode.boundingBox();
  expect(promptBox).not.toBeNull();
  await expect(promptNode).not.toHaveClass(/draggable/);
  await expect(promptNode).toHaveCSS("cursor", "grab");
  const dragStart = {
    x: promptBox.x + 18,
    y: promptBox.y + 10,
  };
  const dragTargetCursor = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return target ? getComputedStyle(target).cursor : null;
  }, dragStart);
  expect(dragTargetCursor).toBe("grab");

  const transformBeforeDrag = await promptNode.evaluate((node) => getComputedStyle(node).transform);
  const viewportRequestsBeforeDrag = api.state.brainstormViewportRequests.length;
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 36, dragStart.y + 24, { steps: 4 });
  await page.mouse.up();

  await expect.poll(
    () => api.state.brainstormViewportRequests.length,
  ).toBeGreaterThan(viewportRequestsBeforeDrag);
  expect(api.state.brainstormNodeUpdateRequests).toHaveLength(0);
  expect(await promptNode.evaluate((node) => getComputedStyle(node).transform))
    .toBe(transformBeforeDrag);
});

test("renames a story inline like chat mode", async ({ page }) => {
  const nativeDialogs = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.type());
    await dialog.dismiss();
  });

  const api = await installWriteApi(page);
  await api.open();

  const storyActions = page.getByRole("button", {
    name: "Story actions for Reliability story",
  });
  await storyActions.click();
  await page.getByRole("menuitem", { name: "Edit name" }).click();

  const nameInput = page.getByRole("textbox", { name: "Rename story" });
  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveAttribute("data-1p-ignore", "true");
  await expect(nameInput).toHaveValue("Reliability story");

  await nameInput.fill("Cancelled title");
  await nameInput.press("Escape");
  await expect(nameInput).toBeHidden();
  expect(api.state.story.title).toBe("Reliability story");

  await storyActions.click();
  await page.getByRole("menuitem", { name: "Edit name" }).click();
  await nameInput.fill("Retitled story");
  await nameInput.press("Enter");

  await expect(nameInput).toBeHidden();
  expect(api.state.story.title).toBe("Retitled story");
  expect(api.state.renameRequests).toContainEqual({
    entityType: "story",
    title: "Retitled story",
  });
  expect(nativeDialogs).toEqual([]);
});

test("exports and imports a complete story from the story rail", async ({ page }) => {
  const api = await installWriteApi(page);
  await api.open();

  const storyActions = page.getByRole("button", {
    name: "Story actions for Reliability story",
  });
  await storyActions.click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^routerchat-story-reliability-story-\d{4}-\d{2}-\d{2}\.json$/,
  );

  const importButton = page.getByRole("button", { name: "Import story" });
  await expect(importButton).toBeVisible();
  //the icon sits inside a sizing wrapper, so match the masked span itself rather than nesting depth
  const importIcon = importButton.locator('span[aria-hidden="true"]');
  await expect(importIcon).toHaveCSS(
    "mask-image",
    /file-import\.png/,
  );

  const archive = {
    schema: "routerchat.story.v1",
    story: {
      id: "portable-story",
      title: "Imported adventure",
      model: "test/model",
      temperature: 0.7,
      max_tokens: 30000,
      system_prompt: "",
      thinking_enabled: false,
      reasoning_effort: "medium",
      lorebook_auto: false,
    },
    chapters: [{
      id: "portable-chapter",
      story_id: "portable-story",
      title: "Imported opening",
      content: "A portable beginning.",
      revision: 0,
      order_index: 0,
      disabled: false,
    }],
    chapter_history: [],
    lorebook: [],
    brainstorm: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  };

  await page.getByLabel("Import story file").setInputFiles({
    name: "portable-story.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(archive)),
  });

  await expect(page).toHaveURL(/\/write\/story\/story-imported\/chapter\/chapter-imported-1$/);
  await expect(page.getByRole("heading", { name: "Imported opening" })).toBeVisible();
  await expect(page.getByText("Imported Imported adventure")).toBeVisible();
  expect(api.state.storyImportRequests).toEqual([archive]);
  await expect(page.getByLabel("Import story file")).toHaveValue("");
});

test("renames a chapter inline after flushing its draft and keeps failures editable", async ({ page }) => {
  const nativeDialogs = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.type());
    await dialog.dismiss();
  });

  const api = await installWriteApi(page);
  await api.open();
  await editCanvas(page, "draft saved before rename");

  const chapterActions = page.getByRole("button", {
    name: "Chapter actions for Opening",
  });
  await chapterActions.click();
  await page.getByRole("menuitem", { name: "Edit name" }).click();

  const nameInput = page.getByRole("textbox", { name: "Rename chapter" });
  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveAttribute("data-1p-ignore", "true");
  await expect(nameInput).toHaveValue("Opening");
  await nameInput.fill("Renamed opening");
  await nameInput.press("Tab");

  await expect(nameInput).toBeHidden();
  await expect.poll(() => api.state.saveRequests.length).toBe(1);
  expect(api.state.saveRequests[0].content).toBe("draft saved before rename");
  expect(api.state.renameRequests).toContainEqual({
    entityType: "chapter",
    chapterId: "chapter-1",
    title: "Renamed opening",
    revision: 1,
  });
  expect(api.state.chapters[0].title).toBe("Renamed opening");

  api.state.failNextRename = "chapter";
  await page.getByRole("button", {
    name: "Chapter actions for Renamed opening",
  }).click();
  await page.getByRole("menuitem", { name: "Edit name" }).click();
  await nameInput.fill("Failed rename");
  await nameInput.press("Enter");

  await expect(nameInput).toBeVisible();
  await expect(nameInput).toBeFocused();
  await expect(page.getByText("Rename failed")).toBeVisible();
  expect(api.state.chapters[0].title).toBe("Renamed opening");

  await nameInput.press("Escape");
  await expect(nameInput).toBeHidden();
  expect(nativeDialogs).toEqual([]);
});

test("shows mandatory model reasoning as required even when the saved preference is off", async ({ page }) => {
  const api = await installWriteApi(page, {
    model: {
      id: "test/model",
      name: "Test model",
      pricing: {},
      architecture: { output_modalities: ["text"] },
      supported_parameters: ["reasoning"],
      reasoning: { mandatory: true, default_enabled: true },
    },
  });
  await api.open();

  const modelButton = page.locator('[data-tour="model-button"]');
  await expect(modelButton).toBeVisible();
  await expect(modelButton).toContainText("Test model");
  //mandatory reasoning overrides the saved preference, so the button carries an effort level instead
  //of Instant, and the Required badge itself now lives in the menu below
  await expect(modelButton).toContainText("Medium");
  await expect(modelButton).not.toContainText("Instant");
  await modelButton.click();

  const thinkingRow = page.locator('[data-tour="thinking-button"]');
  await expect(thinkingRow).toBeVisible();
  await expect(thinkingRow).toContainText("Thinking");
  //Required stands in for the On state on a mandatory model, the row cannot be turned off
  await expect(thinkingRow).toContainText("Required");
  await expect(thinkingRow).not.toContainText("Off");
  await expect(thinkingRow).toBeDisabled();
  expect(api.state.story.thinking_enabled).toBe(false);
});

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

test("remembers each chapter canvas position during the current app session", async ({ page }) => {
  const openingContent = Array.from({ length: 56 }, (_, index) => (
    index % 9 === 8
      ? "---"
      : `opening paragraph ${index + 1} keeps the first chapter tall enough to scroll.`
  )).join("\n\n");
  const secondContent = Array.from(
    { length: 64 },
    (_, index) => `second paragraph ${index + 1} keeps the other chapter independently scrollable.`,
  ).join("\n\n");
  const api = await installWriteApi(page, {
    legacyContent: openingContent,
    secondContent,
    twoChapters: true,
  });
  await api.open();
  await expect(page.getByText("opening paragraph 1 keeps")).toBeVisible();

  const canvas = page.locator('[data-tour="write-chapter-canvas"]');
  await canvas.evaluate((node) => {
    node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.42);
  });
  const openingScrollTop = (await canvasMetrics(page)).scrollTop;
  expect(openingScrollTop).toBeGreaterThan(0);

  await page.getByRole("button", { name: /Writing tools/ }).click();
  await page.getByRole("menu").getByText("Lorebook", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lorebook" })).toBeVisible();
  await page.getByRole("button", { name: "Back to chapter" }).click();
  await expect(page.getByRole("heading", { name: "Opening" })).toBeVisible();
  await expect.poll(async () => (await canvasMetrics(page)).scrollTop).toBeCloseTo(openingScrollTop, 0);

  await page.getByRole("button", { name: "Second", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Second" })).toBeVisible();
  await expect(page.getByText("second paragraph 1 keeps")).toBeVisible();
  await canvas.evaluate((node) => {
    node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.68);
  });
  const secondScrollTop = (await canvasMetrics(page)).scrollTop;
  expect(secondScrollTop).toBeGreaterThan(openingScrollTop);

  await page.getByRole("button", { name: "Opening", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Opening" })).toBeVisible();
  await expect.poll(async () => (await canvasMetrics(page)).scrollTop).toBeCloseTo(openingScrollTop, 0);

  await page.getByRole("button", { name: "Second", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Second" })).toBeVisible();
  await expect.poll(async () => (await canvasMetrics(page)).scrollTop).toBeCloseTo(secondScrollTop, 0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Second" })).toBeVisible();
  await expect.poll(async () => (await canvasMetrics(page)).scrollTop).toBe(0);
});

test("confirms timeline repair, streams thinking, and keeps the dialog open until completion", async ({ page }) => {
  const api = await installWriteApi(page, { controlledTimelineRepairStream: true });
  await api.open();

  await page.getByRole("button", { name: /Writing tools/ }).click();
  await page.getByRole("menu").getByText("Lorebook", { exact: true }).click();
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();

  const timeline = page.locator(".lorebook-timeline-canvas textarea");
  await timeline.fill("- an unsaved timeline detail");
  const saveButton = page.getByRole("button", { name: "Save timeline" });
  const repairButton = page.getByRole("button", { name: "Repair timeline" });
  const saveBox = await saveButton.boundingBox();
  const repairBox = await repairButton.boundingBox();
  expect(repairBox?.x).toBeGreaterThan(saveBox?.x || 0);
  expect(Math.abs((repairBox?.width || 0) - (saveBox?.width || 0))).toBeLessThan(1);

  await repairButton.click();
  let dialog = page.getByRole("dialog", { name: "Repair timeline?" });
  await expect(dialog).toContainText("every chapter not hidden from context");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await repairButton.click();
  dialog = page.getByRole("dialog", { name: "Repair timeline?" });
  await dialog.getByRole("button", { name: "Repair timeline" }).click();
  await api.waitForTimelineRepairStream();
  expect(await api.timelineRepairRequest()).toEqual({
    current_timeline: "- an unsaved timeline detail",
  });

  const runningDialog = page.getByRole("dialog", { name: "Thinking" });
  const repairTitle = runningDialog.locator(".lorebook-repair-title-text");
  await expect(repairTitle).toHaveText("Thinking");
  await expect(repairTitle).toHaveClass(/t-shimmer/);
  await expect(repairTitle).toHaveAttribute("data-text", "Thinking");
  await expect(runningDialog.locator(".lorebook-repair-label")).toHaveCount(0);
  await expect(runningDialog.locator(".lorebook-repair-spinner")).toHaveCount(0);
  await expect(runningDialog.getByRole("button")).toHaveCount(0);
  await expect(runningDialog).not.toContainText("Repairing...");
  await expect(runningDialog).not.toContainText("Keep this window open");
  await page.keyboard.press("Escape");
  await expect(runningDialog).toBeVisible();
  await page.waitForTimeout(400); //let the confirm to running size tween finish before measuring
  const runningBoxBeforeThinking = await runningDialog.boundingBox();

  await api.pushTimelineRepairEvent({
    type: "reasoning",
    value: "## Ordering\n\n**First**, put the gate before the crossing.\n\n- Open the gate\n",
  });
  await api.pushTimelineRepairEvent({
    type: "reasoning",
    value: "- Cross the threshold",
  });
  const reasoningPanel = page.getByTestId("timeline-repair-reasoning");
  await expect(reasoningPanel.getByRole("heading", { name: "Ordering" })).toBeVisible();
  await expect(reasoningPanel.locator("strong")).toHaveText("First");
  await expect(reasoningPanel.getByRole("listitem")).toHaveCount(2);
  const runningBoxAfterThinking = await runningDialog.boundingBox();
  expect(
    Math.abs((runningBoxAfterThinking?.height || 0) - (runningBoxBeforeThinking?.height || 0)),
  ).toBeLessThan(1);

  const repairScrollMetrics = () => reasoningPanel.evaluate((node) => ({
    scrollTop: Math.round(node.scrollTop),
    maxScroll: Math.round(node.scrollHeight - node.clientHeight),
  }));

  await api.pushTimelineRepairEvent({
    type: "reasoning",
    value: `\n${Array.from({ length: 30 }, (_, index) => `- thought ${index + 1} about the crossing`).join("\n")}\n`,
  });
  await expect.poll(async () => {
    const metrics = await repairScrollMetrics();
    return metrics.maxScroll - metrics.scrollTop;
  }).toBeLessThan(2);

  await reasoningPanel.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    node.scrollTop = Math.max(node.scrollTop - 140, 0);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const pausedRepairScroll = await repairScrollMetrics();
  await api.pushTimelineRepairEvent({
    type: "reasoning",
    value: "- a late thought that should not steal the readers place\n",
  });
  await page.waitForTimeout(100);
  const afterPausedRepairScroll = await repairScrollMetrics();
  expect(afterPausedRepairScroll.scrollTop).toBe(pausedRepairScroll.scrollTop);
  expect(afterPausedRepairScroll.maxScroll - afterPausedRepairScroll.scrollTop).toBeGreaterThan(32);

  await reasoningPanel.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await api.pushTimelineRepairEvent({
    type: "reasoning",
    value: "- following resumes once the reader returns to the bottom\n",
  });
  await expect.poll(async () => {
    const metrics = await repairScrollMetrics();
    return metrics.maxScroll - metrics.scrollTop;
  }).toBeLessThan(2);

  //once the thinking is done the header flips to Writing and keeps shimmering
  await api.pushTimelineRepairEvent({ type: "status", value: "writing" });
  const writingDialog = page.getByRole("dialog", { name: "Writing" });
  const writingTitle = writingDialog.locator(".lorebook-repair-title-text");
  await expect(writingTitle).toHaveText("Writing");
  await expect(writingTitle).toHaveClass(/t-shimmer/);
  await expect(writingTitle).toHaveAttribute("data-text", "Writing");
  await expect(writingDialog.getByTestId("timeline-repair-reasoning")).toBeVisible();
  await expect(writingDialog.getByRole("button")).toHaveCount(0);

  await api.pushTimelineRepairEvent({
    type: "complete",
    value: {
      duration_ms: 2400,
      entry: {
        id: "timeline-1",
        story_id: "story-1",
        name: "Timeline",
        category: "timeline",
        description: "- Mara opens the gate\n- Mara crosses the threshold",
        aliases: ["Timeline"],
        tags: [],
        metadata: {},
        disabled: false,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:03Z",
      },
    },
  });
  await api.closeTimelineRepairStream();

  const completedDialog = page.getByRole("dialog", { name: "Timeline rebuilt" });
  await expect(completedDialog).toContainText("Finished rebuilding timeline in 2 seconds.");
  //only the count is bold, the unit and the period stay in the body weight
  await expect(completedDialog.locator(".lorebook-repair-duration")).toHaveText("2");
  //the Done button is the only way out of the finished stage, the corner x is gone
  await expect(completedDialog.getByRole("button", { name: "Close timeline repair" })).toHaveCount(0);
  await completedDialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(completedDialog).toBeHidden();
  await expect(timeline).toHaveValue("- Mara opens the gate\n- Mara crosses the threshold");
});

test("creates an entry immediately after the generated draft closes", async ({ page }) => {
  const api = await installWriteApi(page);

  await page.route("**/api/stories/story-1/lorebook/generate/stream", (route) => route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body: `${JSON.stringify({
      type: "complete",
      value: {
        entry: {
          name: "Mara",
          category: "character",
          description: "A keeper of the north gate.",
          aliases: [],
          notes: "",
        },
      },
    })}\n`,
  }));

  await page.route("**/api/stories/story-1/lorebook", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entry: {
          id: "created-entry",
          name: "Mara",
          category: "character",
          description: "A keeper of the north gate.",
          aliases: [],
          tags: [],
          metadata: {},
          disabled: false,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      }),
    });
  });

  await api.open();
  await page.getByRole("button", { name: /Writing tools/ }).click();
  await page.getByRole("menu").getByText("Lorebook", { exact: true }).click();
  await page.getByRole("button", { name: "New entry" }).click();
  await page.getByRole("button", { name: "Generate entry", exact: true }).click();
  await page.getByRole("textbox", { name: /What should this character be/ }).fill("A keeper of the north gate");
  await page.getByRole("button", { name: "Generate", exact: true }).click();

  const createRequest = page.waitForRequest((request) => (
    request.method() === "POST" && request.url().endsWith("/api/stories/story-1/lorebook")
  ));
  await page.getByRole("button", { name: "Create entry", exact: true }).click();
  expect((await createRequest).postDataJSON()).toMatchObject({
    name: "Mara",
    description: "A keeper of the north gate.",
  });
  await expect(page.getByRole("dialog", { name: "Create lorebook entry" })).toBeHidden();
});

test("generates a linked summary from the selected visible chapter and edits the existing entry", async ({ page }) => {
  const linkedSummary = {
    id: "summary-second",
    story_id: "story-1",
    name: "Second",
    category: "synopsis",
    description: "The old second chapter summary.",
    aliases: [],
    tags: [],
    metadata: { chapter_id: "chapter-2" },
    disabled: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const api = await installWriteApi(page, {
    twoChapters: true,
    lorebook: [linkedSummary],
  });
  api.state.chapters.push(
    {
      id: "chapter-blank",
      story_id: "story-1",
      title: "Blank",
      content: "",
      revision: 0,
      word_count: 0,
      disabled: false,
      history: [],
    },
    {
      id: "chapter-hidden",
      story_id: "story-1",
      title: "Hidden",
      content: "secret prose",
      revision: 0,
      word_count: 2,
      disabled: true,
      history: [],
    },
  );

  await page.route("**/api/stories/story-1/lorebook/generate/stream", (route) => route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body: `${JSON.stringify({
      type: "complete",
      value: {
        entry: {
          name: "Second",
          category: "synopsis",
          description: "The second chapter reaches its outcome.",
          aliases: [],
          notes: "",
          metadata: { chapter_id: "chapter-2" },
        },
      },
    })}\n`,
  }));
  await page.route("**/api/stories/story-1/lorebook/summary-second", async (route) => {
    const entry = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entry: { ...linkedSummary, ...entry } }),
    });
  });

  await api.open();
  await page.getByRole("button", { name: /Writing tools/ }).click();
  await page.getByRole("menu").getByText("Lorebook", { exact: true }).click();
  await page.getByRole("tab", { name: /Chapter Summaries/ }).click();
  await page.getByRole("button", { name: "New entry" }).click();
  await page.getByRole("button", { name: "Generate entry", exact: true }).click();

  const picker = page.getByRole("button", { name: "Select chapter" });
  await expect(picker).toContainText("Opening");
  await picker.click();
  await expect(page.getByRole("option")).toHaveText(["Opening", "Second"]);
  await page.getByRole("option", { name: "Second" }).click();
  await expect(picker).toContainText("Second");
  await expect(page.getByRole("textbox", { name: /What should this chapter summary be/ })).toHaveCount(0);

  const generateRequest = page.waitForRequest((request) => (
    request.method() === "POST" && request.url().endsWith("/api/stories/story-1/lorebook/generate/stream")
  ));
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  expect((await generateRequest).postDataJSON()).toEqual({
    category: "synopsis",
    brief: "",
    chapter_id: "chapter-2",
  });

  const updateRequest = page.waitForRequest((request) => (
    request.method() === "PATCH" && request.url().endsWith("/api/stories/story-1/lorebook/summary-second")
  ));
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  expect((await updateRequest).postDataJSON()).toMatchObject({
    name: "Second",
    category: "synopsis",
    description: "The second chapter reaches its outcome.",
    metadata: { chapter_id: "chapter-2" },
  });
});

test("switches from generating to creating when the author writes an entry", async ({ page }) => {
  const api = await installWriteApi(page);

  await page.route("**/api/stories/story-1/lorebook", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }

    const entry = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entry: {
          ...entry,
          id: "manual-entry",
          tags: [],
          metadata: {},
          disabled: false,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      }),
    });
  });

  await api.open();
  await page.getByRole("button", { name: /Writing tools/ }).click();
  await page.getByRole("menu").getByText("Lorebook", { exact: true }).click();
  await page.getByRole("button", { name: "New entry" }).click();

  const createButton = page.getByRole("button", { name: "Create entry", exact: true });
  const generateButton = page.getByRole("button", { name: "Generate entry", exact: true });
  await expect(createButton).toBeDisabled();
  await expect(generateButton).toBeEnabled();

  await page.getByRole("textbox", { name: "Description" }).fill("A keeper of the north gate.");
  await expect(createButton).toBeEnabled();
  await expect(generateButton).toBeDisabled();

  const createRequest = page.waitForRequest((request) => (
    request.method() === "POST" && request.url().endsWith("/api/stories/story-1/lorebook")
  ));
  await createButton.click();
  expect((await createRequest).postDataJSON()).toMatchObject({
    name: "Untitled entry",
    description: "A keeper of the north gate.",
  });
  await expect(page.getByRole("dialog", { name: "Create lorebook entry" })).toBeHidden();
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

test("generates prose into a blank chapter while keeping Edit Chapter selected", async ({ page }) => {
  const api = await installWriteApi(page, { legacyContent: "" });
  await api.open();

  const writingTools = page.getByRole("button", { name: /Writing tools/ });
  await expect(writingTools).toContainText("Edit Chapter");

  await page.getByPlaceholder(/Ask Test model to write anything/).fill("open with a storm");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => api.state.generationRequests.length).toBe(1);
  expect(api.state.generationRequests[0].write_generation_mode).toBe("new");
  expect(api.state.generationRequests[0].chapterId).toBe("chapter-1");
  expect(api.state.chapters).toHaveLength(1);

  const editor = page.getByRole("textbox", { name: "Chapter canvas" });
  await expect(editor).toContainText("generated text");
  await expect(editor).not.toContainText("chapterRevision");
  await expect(writingTools).toContainText("Edit Chapter");

  expect(api.state.chapters[0].content).toBe("generated text");
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

  const toggle = page.getByRole("button", { name: "Expand writing details" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect((await toggle.boundingBox())?.height).toBeGreaterThanOrEqual(40);

  await toggle.focus();
  await toggle.press("Enter");
  await expect(page.getByRole("region", { name: "Writing details" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse writing details" })).toHaveAttribute("aria-expanded", "true");
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

  const editPreview = Array.from(
    { length: 48 },
    (_, index) => `edit sentence ${index + 1} adds enough text to make the second panel scroll too.`,
  ).join(" ");
  const editFragment = (
    '{"chapterRevision":0,"edits":[{"operation":"replaceBlock","blockId":"p_001",'
    + `"anchorText":"saved opening","newText":${JSON.stringify(editPreview).slice(0, -1)}`
  );
  await api.pushGenerationContent(editFragment);
  await expect(page.getByTestId("write-edit-preview-scroll")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 700 });
  const details = page.getByRole("region", { name: "Writing details" });
  const popoverBox = await details.boundingBox();
  expect(popoverBox?.x).toBeGreaterThanOrEqual(15);
  expect((popoverBox?.x || 0) + (popoverBox?.width || 0)).toBeLessThanOrEqual(375);
  expect(popoverBox?.y).toBeGreaterThanOrEqual(15);
  expect((popoverBox?.y || 0) + (popoverBox?.height || 0)).toBeLessThanOrEqual(685);
  await expect.poll(() => details.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);

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
