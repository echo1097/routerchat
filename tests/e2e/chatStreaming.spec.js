import { test, expect } from "@playwright/test";

//the streamed reply is split into word spans and resolved in order, scrollback stays plain text

const MODEL = {
  id: "test/model",
  name: "Test model",
  context_length: 128000,
  pricing: { prompt: "0", completion: "0" },
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installChatApi(page, serverMessages) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "routerchat.appSettings",
      JSON.stringify({ smooth_streaming: true }),
    );

    const nativeFetch = window.fetch.bind(window);
    window.__chatStream = null;
    window.fetch = async (input, init = {}) => {
      const requestUrl = typeof input === "string" ? input : input?.url || "";
      if (!/\/api\/chats\/[^/]+\/messages\/stream$/.test(requestUrl)) {
        return nativeFetch(input, init);
      }

      const stream = new ReadableStream({
        start(controller) {
          window.__chatStream = { controller };
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    };
  });

  const chat = {
    id: "chat-1",
    title: "Test chat",
    model: "test/model",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (method === "GET" && path === "/api/tos") {
      return json(route, {
        hash: "e2e-tos-hash",
        date: "2026-01-01",
        markdown: "# Terms",
        accepted: true,
        accepted_at: "2026-01-01T00:00:00Z",
        previous: null,
      });
    }
    if (method === "GET" && path === "/api/settings/key-status") return json(route, { has_key: true });
    if (method === "GET" && path === "/api/settings") return json(route, { default_model: "test/model" });
    if (method === "GET" && path === "/api/models") return json(route, { models: [MODEL] });
    if (method === "GET" && path === "/api/chats") return json(route, { chats: [chat] });
    if (method === "POST" && path === "/api/chats") return json(route, { chat });
    if (method === "GET" && path === "/api/chats/chat-1") {
      return json(route, { chat, messages: serverMessages.slice() });
    }
    if (method === "GET" && path === "/api/stories") return json(route, { stories: [] });
    if (method === "GET" && path === "/api/folders") return json(route, { folders: [] });

    return json(route, {}, 200);
  });
}

async function pushChat(page, value) {
  await page.evaluate((nextValue) => {
    const stream = window.__chatStream;
    if (!stream) throw new Error("chat stream is not ready");
    stream.controller.enqueue(
      new TextEncoder().encode(`${JSON.stringify({ type: "content", value: nextValue })}\n`),
    );
  }, value);
}

test("resolves a streamed reply one word at a time", async ({ page }) => {
  const serverMessages = [];
  await installChatApi(page, serverMessages);
  await page.goto("/chat/chat-1");

  const composer = page.getByPlaceholder(/Ask Test model/);
  await expect(composer).toBeVisible();
  await composer.fill("say something");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => page.evaluate(() => Boolean(window.__chatStream))).toBe(true);

  await pushChat(page, "the quiet part arrived first and everyone noticed");

  const assistant = page.locator('[data-message-role="assistant"]').last();
  const words = assistant.locator(".t-stream-w");
  await expect.poll(() => words.count()).toBe(8);

  //they resolve in order rather than landing as one block
  await expect.poll(() => assistant.locator(".t-stream-w.is-in").count()).toBeGreaterThan(0);
  await expect
    .poll(() => assistant.locator(".t-stream-w.is-in").count(), { timeout: 5000 })
    .toBe(8);

  //the app reloads the chat once the stream ends, so the mock has to know the reply landed
  serverMessages.push(
    {
      id: "message-1",
      chat_id: "chat-1",
      role: "user",
      content: "say something",
      created_at: "2026-01-01T00:00:01Z",
    },
    {
      id: "message-2",
      chat_id: "chat-1",
      role: "assistant",
      content: "the quiet part arrived first and everyone noticed",
      reasoning: "",
      created_at: "2026-01-01T00:00:02Z",
    },
  );

  await page.evaluate(() => {
    window.__chatStream.controller.close();
    window.__chatStream = null;
  });

  //once the stream ends the message goes back to plain markdown with no spans
  await expect.poll(() => assistant.locator(".t-stream-w").count()).toBe(0);
  await expect(assistant).toContainText("the quiet part arrived first");
});

test("does not reserve layout space for words the reveal has not reached", async ({ page }) => {
  const serverMessages = [];
  await installChatApi(page, serverMessages);
  await page.goto("/chat/chat-1");

  const composer = page.getByPlaceholder(/Ask Test model/);
  await expect(composer).toBeVisible();
  await composer.fill("say something");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => page.evaluate(() => Boolean(window.__chatStream))).toBe(true);

  //a fast model can hand over a whole page at once, none of it should occupy the layout before the
  //cursor gets there
  const burst = Array.from({ length: 200 }, (unused, index) => `word${index}`).join(" ");
  const assistant = page.locator('[data-message-role="assistant"]').last();
  const body = assistant.locator(".t-stream-w").first();

  await pushChat(page, burst);

  const midFlightWords = await assistant.locator(".t-stream-w").count();
  expect(midFlightWords).toBeLessThan(120);
  await expect(body).toBeVisible();

  //and it all arrives once the cursor drains the backlog
  await expect.poll(() => assistant.locator(".t-stream-w").count(), { timeout: 5000 }).toBe(200);
});
