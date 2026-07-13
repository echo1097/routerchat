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

  const openingContent = options.longContent ? longChapterContent() : "saved opening";
  const state = {
    story: {
      id: "story-1",
      title: "Reliability story",
      model: "test/model",
      temperature: 0.7,
      max_tokens: 30000,
      system_prompt: "",
      thinking_enabled: false,
      reasoning_effort: "medium",
      updated_at: "2026-01-01T00:00:00Z",
    },
    chapters: options.twoChapters
      ? [chapter("chapter-1", "Opening", openingContent), chapter("chapter-2", "Second", "saved second")]
      : [chapter("chapter-1", "Opening", openingContent)],
    saveRequests: [],
    saveGates: [],
    generationRequests: [],
    generationGates: [],
    conflictNextSave: false,
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
      return response(route, { models: [{ id: "test/model", name: "Test model", pricing: {}, architecture: { output_modalities: ["text"] }, supported_parameters: [] }] });
    }
    if (method === "GET" && path === "/api/chats") return response(route, { chats: [] });
    if (method === "GET" && path === "/api/stories") return response(route, { stories: [state.story] });
    if (method === "GET" && path === "/api/stories/story-1") return response(route, storyBundle());
    if (method === "GET" && path === "/api/stories/story-1/chapters") return response(route, { chapters: clone(state.chapters) });
    if (method === "GET" && path === "/api/stories/story-1/lorebook") return response(route, { entries: [] });

    const chapterId = segments[4];
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
      const nextChapter = {
        ...target,
        content: `${target.content}\n\ngenerated text`,
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
    async waitForReasoningStream() {
      await expect.poll(() => page.evaluate(() => Boolean(window.__writeReasoningStream))).toBe(true);
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
