import { test, expect } from "@playwright/test";

const MODEL = {
  id: "test/model",
  name: "Test model",
  context_length: 128000,
  pricing: { prompt: "0", completion: "0" },
};

const CHAT = {
  id: "chat-1",
  title: "Test chat",
  model: "test/model",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const NO_CREDIT = {
  kind: "noCredit",
  title: "Out of OpenRouter credit",
  message: "Your OpenRouter account doesn't have enough credit for this model. Add credit, then try again.",
  provider: "OpenRouter",
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
    if (method === "GET" && path === "/api/chats") return json(route, { chats: [CHAT] });
    if (method === "POST" && path === "/api/chats") return json(route, { chat: CHAT });
    if (method === "GET" && path === "/api/chats/chat-1") {
      return json(route, { chat: CHAT, messages: serverMessages.slice() });
    }
    if (method === "GET" && path === "/api/stories") return json(route, { stories: [] });
    if (method === "GET" && path === "/api/folders") return json(route, { folders: [] });

    return json(route, {}, 200);
  });
}

async function pushEvent(page, event) {
  await page.evaluate((nextEvent) => {
    const stream = window.__chatStream;
    if (!stream) throw new Error("chat stream is not ready");
    stream.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(nextEvent)}\n`));
  }, event);
}

async function closeStream(page) {
  await page.evaluate(() => window.__chatStream.controller.close());
}

function message(id, role, content, extra = {}) {
  return { id, chat_id: "chat-1", role, content, created_at: "2026-01-01T00:00:01Z", ...extra };
}

test("shows a failed reply as an error notice with its fix", async ({ page }) => {
  const serverMessages = [];
  await installChatApi(page, serverMessages);
  await page.goto("/chat/chat-1");

  const composer = page.getByPlaceholder(/Ask Test model/);
  await expect(composer).toBeVisible();
  await composer.fill("tell me about rome");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__chatStream))).toBe(true);

  await pushEvent(page, { type: "content", value: "Rome was founded" });
  await pushEvent(page, { type: "error", value: NO_CREDIT });
  serverMessages.push(
    message("user-1", "user", "tell me about rome"),
    message("assistant-1", "assistant", "Rome was founded", { error: JSON.stringify(NO_CREDIT) }),
  );
  await closeStream(page);

  const assistant = page.locator('[data-message-role="assistant"]').last();
  const notice = assistant.getByRole("alert");
  await expect(notice).toContainText("Out of OpenRouter credit");
  await expect(notice.getByRole("link", { name: "Add credit" })).toHaveAttribute(
    "href",
    "https://openrouter.ai/settings/credits",
  );
  await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(assistant).toContainText("Rome was founded");
  await expect(assistant.getByRole("button", { name: "Regenerate" })).toHaveCount(0);

  await page.screenshot({ path: test.info().outputPath("chat-error-notice.png") });
});

test("leaves old replies with error text inside them alone", async ({ page }) => {
  const serverMessages = [
    message("user-1", "user", "hi"),
    message("assistant-1", "assistant", "OpenRouter error 402: Insufficient credits", {
      error: "OpenRouter error 402: Insufficient credits",
    }),
  ];
  await installChatApi(page, serverMessages);
  await page.goto("/chat/chat-1");

  const assistant = page.locator('[data-message-role="assistant"]').last();
  await expect(assistant).toContainText("OpenRouter error 402");
  await expect(assistant.getByRole("alert")).toHaveCount(0);
});
