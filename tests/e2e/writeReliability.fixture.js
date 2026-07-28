import { expect } from "@playwright/test";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function chapter(id, title, content, revision = 0) {
  return {
    id,
    story_id: "story-1",
    title,
    content,
    revision,
    word_count: content.trim() ? content.trim().split(/\s+/).length : 0,
    disabled: false,
    history: [],
  };
}

function brainstormNode(id, nodeType, title, content, positionX, positionY) {
  return {
    id,
    story_id: "story-1",
    node_type: nodeType,
    title,
    content,
    position_x: positionX,
    position_y: positionY,
    status: "complete",
  };
}

function longChapterContent() {
  return Array.from(
    { length: 48 },
    (_, index) => `paragraph ${index + 1} gives the chapter enough room to scroll while generation is pending.`,
  ).join("\n\n");
}

function response(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export function createDeferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

export async function installWriteApi(page, options = {}) {
  if (options.controlledReasoningStream) {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);

      window.__writeReasoningStream = null;
      window.fetch = async (input, init = {}) => {
        const requestUrl = typeof input === "string" ? input : input?.url || "";
        const isChapterGeneration = /\/api\/stories\/[^/]+\/chapters\/[^/]+\/generate\/stream(?:\?|$)/.test(requestUrl);
        if (!isChapterGeneration) return nativeFetch(input, init);

        const requestBody = JSON.parse(String(init.body || "{}"));
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            window.__writeReasoningStream = {
              controller,
              requestBody,
            };
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        });
      };
    });
  }

  if (options.controlledBrainstormStream) {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);

      window.__brainstormStream = null;
      window.fetch = async (input, init = {}) => {
        const requestUrl = typeof input === "string" ? input : input?.url || "";
        const isBrainstormGeneration = /\/api\/stories\/[^/]+\/brainstorm\/generate\/stream(?:\?|$)/.test(requestUrl);
        if (!isBrainstormGeneration) return nativeFetch(input, init);

        const requestBody = JSON.parse(String(init.body || "{}"));
        const stream = new ReadableStream({
          start(controller) {
            window.__brainstormStream = {
              controller,
              requestBody,
            };
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        });
      };
    });
  }

  const openingContent = options.legacyContent ?? (options.longContent ? longChapterContent() : "saved opening");
  const model = options.model || {
    id: "test/model",
    name: "Test model",
    pricing: {},
    architecture: { output_modalities: ["text"] },
    supported_parameters: [],
  };
  const state = {
    story: {
      id: "story-1",
      title: "Reliability story",
      model: "test/model",
      temperature: 0.7,
      max_tokens: 30000,
      system_prompt: "",
      thinking_enabled: options.thinkingEnabled ?? false,
      reasoning_effort: "medium",
      lorebook_auto: options.lorebookAuto ?? false,
      updated_at: "2026-01-01T00:00:00Z",
    },
    chapters: options.twoChapters
      ? [
          chapter("chapter-1", "Opening", openingContent),
          chapter("chapter-2", "Second", options.secondContent ?? "saved second"),
        ]
      : [chapter("chapter-1", "Opening", openingContent)],
    brainstormNodes: clone(options.brainstormNodes || []),
    brainstormEdges: clone(options.brainstormEdges || []),
    brainstormViewport: clone(options.brainstormViewport || { x: 0, y: 0, zoom: 1 }),
    brainstormGenerationRequests: [],
    brainstormNodeUpdateRequests: [],
    brainstormViewportRequests: [],
    brainstormGenerationCount: 0,
    saveRequests: [],
    saveGates: [],
    renameRequests: [],
    generationRequests: [],
    generationGates: [],
    conflictNextSave: false,
    failNextRename: null,
    suppressNextGenerationCommit: false,
  };

  function storyBundle() {
    return {
      story: clone(state.story),
      chapters: clone(state.chapters),
      lorebook: [],
      latest_generation: null,
    };
  }

  function findChapter(id) {
    return state.chapters.find((item) => item.id === id);
  }

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const segments = path.split("/").filter(Boolean);
    const body = request.postData() ? request.postDataJSON() : {};

    if (method === "GET" && path === "/api/settings/key-status") return response(route, { has_key: true });
    if (method === "GET" && path === "/api/settings") return response(route, { default_model: "test/model" });
    if (method === "GET" && path === "/api/models") {
      return response(route, { models: [model] });
    }
    if (method === "GET" && path === "/api/chats") return response(route, { chats: [] });
    if (method === "GET" && path === "/api/stories") return response(route, { stories: [state.story] });
    if (method === "GET" && path === "/api/stories/story-1") return response(route, storyBundle());
    if (method === "GET" && path === "/api/stories/story-1/chapters") return response(route, { chapters: clone(state.chapters) });
    if (method === "GET" && path === "/api/stories/story-1/lorebook") return response(route, { entries: [] });
    if (method === "GET" && path === "/api/stories/story-1/brainstorm") {
      return response(route, {
        nodes: clone(state.brainstormNodes),
        edges: clone(state.brainstormEdges),
        viewport: clone(state.brainstormViewport),
        latest_generation: null,
      });
    }

    if (method === "PATCH" && path === "/api/stories/story-1/brainstorm/viewport") {
      state.brainstormViewportRequests.push(clone(body));
      state.brainstormViewport = {
        x: body.position_x,
        y: body.position_y,
        zoom: body.zoom,
      };
      return response(route, { viewport: clone(state.brainstormViewport) });
    }

    if (method === "PATCH" && segments[3] === "brainstorm" && segments[4] === "nodes") {
      const nodeId = segments[5];
      const nodeIndex = state.brainstormNodes.findIndex((node) => node.id === nodeId);
      if (nodeIndex === -1) return response(route, { detail: "Brainstorm node not found" }, 404);

      state.brainstormNodeUpdateRequests.push({ nodeId, changes: clone(body) });
      state.brainstormNodes[nodeIndex] = {
        ...state.brainstormNodes[nodeIndex],
        ...clone(body),
      };
      return response(route, { node: clone(state.brainstormNodes[nodeIndex]) });
    }

    if (method === "DELETE" && segments[3] === "brainstorm" && segments[4] === "nodes") {
      const nodeId = segments[5];
      const deleteIds = new Set([nodeId]);
      const pendingIds = [nodeId];
      if (url.searchParams.get("cascade") === "true") {
        while (pendingIds.length > 0) {
          const currentId = pendingIds.pop();
          state.brainstormEdges
            .filter((edge) => edge.source_node_id === currentId)
            .forEach((edge) => {
              if (deleteIds.has(edge.target_node_id)) return;
              deleteIds.add(edge.target_node_id);
              pendingIds.push(edge.target_node_id);
            });
        }
      }
      state.brainstormNodes = state.brainstormNodes.filter((node) => !deleteIds.has(node.id));
      state.brainstormEdges = state.brainstormEdges.filter((edge) => (
        !deleteIds.has(edge.source_node_id) && !deleteIds.has(edge.target_node_id)
      ));
      return response(route, { deleted_node_ids: [...deleteIds] });
    }

    if (method === "POST" && path === "/api/stories/story-1/brainstorm/generate/stream") {
      state.brainstormGenerationRequests.push(clone(body));
      state.brainstormGenerationCount += 1;
      const count = state.brainstormGenerationCount;
      const promptNode = brainstormNode(
        `generated-prompt-${count}`,
        "prompt",
        "Prompt",
        body.message,
        0,
        180,
      );
      const brainstormReasoning = options.brainstormReasoning || "";
      const brainstormDurationMs = options.brainstormDurationMs || 4200;
      if (brainstormReasoning) promptNode.reasoning = brainstormReasoning;
      promptNode.duration_ms = brainstormDurationMs;
      const ideaNode = brainstormNode(
        `generated-idea-${count}`,
        "idea",
        "Generated idea",
        "A generated direction.",
        390,
        180,
      );
      const promptEdges = (body.selected_idea_ids || []).map((sourceId, index) => ({
        id: `generated-parent-edge-${count}-${index}`,
        story_id: "story-1",
        source_node_id: sourceId,
        target_node_id: promptNode.id,
      }));
      const ideaEdge = {
        id: `generated-idea-edge-${count}`,
        story_id: "story-1",
        source_node_id: promptNode.id,
        target_node_id: ideaNode.id,
      };
      state.brainstormNodes.push(promptNode, ideaNode);
      state.brainstormEdges.push(...promptEdges, ideaEdge);
      const streamPromptNode = {
        ...promptNode,
        status: "generating",
        generation_phase: "thinking",
        reasoning: "",
        duration_ms: null,
      };
      const events = [
        { type: "prompt", value: { node: streamPromptNode, edges: promptEdges } },
        ...(brainstormReasoning
          ? [{ type: "reasoning", value: brainstormReasoning }]
          : []),
        { type: "working", value: null },
        {
          type: "ideas",
          value: {
            nodes: [ideaNode],
            edges: [ideaEdge],
            duration_ms: brainstormDurationMs,
          },
        },
      ];
      return route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: events.map((event) => JSON.stringify(event)).join("\n"),
      });
    }

    const chapterId = segments[4];
    if (method === "PATCH" && path === "/api/stories/story-1") {
      if (state.failNextRename === "story") {
        state.failNextRename = null;
        return response(route, { detail: "Rename failed" }, 500);
      }
      state.renameRequests.push({ entityType: "story", ...body });
      state.story = { ...state.story, ...body };
      return response(route, { story: clone(state.story) });
    }

    if (method === "PATCH" && segments[1] === "stories" && segments[3] === "chapters" && segments.length === 5) {
      const target = findChapter(chapterId);
      if (state.failNextRename === "chapter") {
        state.failNextRename = null;
        return response(route, { detail: "Rename failed" }, 500);
      }
      state.renameRequests.push({ entityType: "chapter", chapterId, ...body });
      target.title = body.title;
      target.revision += 1;
      return response(route, { chapter: clone(target) });
    }

    if (method === "PATCH" && segments[1] === "stories" && segments[3] === "chapters" && segments[5] === "content") {
      const target = findChapter(chapterId);
      state.saveRequests.push({ chapterId, ...body });
      const gate = state.saveGates.shift();
      if (gate) await gate.promise;
      if (state.conflictNextSave) {
        state.conflictNextSave = false;
        return response(route, { detail: { code: "chapter_revision_conflict", message: "Chapter changed on the server.", chapter: clone(target) } }, 409);
      }
      if (target.revision !== body.revision) {
        return response(route, { detail: { code: "chapter_revision_conflict", message: "Chapter changed on the server.", chapter: clone(target) } }, 409);
      }
      target.content = body.content;
      target.revision += 1;
      target.word_count = body.content.trim() ? body.content.trim().split(/\s+/).length : 0;
      return response(route, { chapter: clone(target) });
    }

    if (method === "POST" && segments[1] === "stories" && segments[3] === "chapters" && segments[5] === "generate" && segments[6] === "stream") {
      const target = findChapter(chapterId);
      state.generationRequests.push({ chapterId, ...body });
      const gate = state.generationGates.shift();
      if (gate) await gate.promise;
      if (state.suppressNextGenerationCommit) {
        state.suppressNextGenerationCommit = false;
        return route.fulfill({ status: 200, contentType: "application/json", body: "" });
      }
      const nextContent = target.content.trim()
        ? `${target.content}\n\ngenerated text`
        : "generated text";
      const nextChapter = {
        ...target,
        content: nextContent,
        revision: target.revision + 1,
      };
      target.content = nextChapter.content;
      target.revision = nextChapter.revision;
      target.word_count = nextChapter.content.trim().split(/\s+/).length;
      const events = [
        { type: "content", runId: body.generation_run_id, storyId: "story-1", chapterId, revision: body.chapter_revision, value: "generated text" },
        { type: "chapter_updated", runId: body.generation_run_id, storyId: "story-1", chapterId, revision: nextChapter.revision, value: { chapter: nextChapter } },
      ];
      return route.fulfill({ status: 200, contentType: "application/json", body: events.map((event) => JSON.stringify(event)).join("\n") });
    }

    return response(route, { detail: `Unhandled e2e request: ${method} ${path}` }, 500);
  });

  return {
    state,
    deferSave() {
      const gate = createDeferred();
      state.saveGates.push(gate);
      return gate;
    },
    deferGeneration() {
      const gate = createDeferred();
      state.generationGates.push(gate);
      return gate;
    },
    async open(chapterId = "chapter-1") {
      await page.goto(`/write/story/story-1/chapter/${chapterId}`);
      await expect(page.getByRole("heading", { name: chapterId === "chapter-1" ? "Opening" : "Second" })).toBeVisible();
    },
    async openBrainstorm() {
      await page.goto("/write/story/story-1/brainstorm");
      await expect(page.getByRole("heading", { name: "Brainstorm" })).toBeVisible();
    },
    async waitForReasoningStream() {
      await expect.poll(() => page.evaluate(() => Boolean(window.__writeReasoningStream))).toBe(true);
    },
    async waitForBrainstormStream() {
      await expect.poll(() => page.evaluate(() => Boolean(window.__brainstormStream))).toBe(true);
    },
    async pushBrainstormEvent(event) {
      await page.evaluate((nextEvent) => {
        const brainstormStream = window.__brainstormStream;
        if (!brainstormStream) throw new Error("brainstorm stream is not ready");

        brainstormStream.controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify(nextEvent)}\n`),
        );
      }, event);
    },
    async closeBrainstormStream() {
      await page.evaluate(() => {
        window.__brainstormStream?.controller.close();
        window.__brainstormStream = null;
      });
    },
    async pushReasoning(value) {
      await page.evaluate((nextValue) => {
        const reasoningStream = window.__writeReasoningStream;
        if (!reasoningStream) throw new Error("reasoning stream is not ready");

        const event = {
          type: "reasoning",
          runId: reasoningStream.requestBody.generation_run_id,
          storyId: "story-1",
          chapterId: "chapter-1",
          revision: reasoningStream.requestBody.chapter_revision,
          value: nextValue,
        };
        reasoningStream.controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify(event)}\n`),
        );
      }, value);
    },
    async closeReasoningStream() {
      await page.evaluate(() => {
        window.__writeReasoningStream?.controller.close();
        window.__writeReasoningStream = null;
      });
    },
  };
}
