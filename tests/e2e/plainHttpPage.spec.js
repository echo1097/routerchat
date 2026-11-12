import { test, expect } from "@playwright/test";

const MODEL = {
  id: "test/model",
  name: "Test model",
  context_length: 128000,
  pricing: { prompt: "0", completion: "0" },
};

const chat = {
  id: "chat-1",
  title: "Test chat",
  model: "test/model",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function removeSecurePageFeatures(page) {
  await page.addInitScript(() => {
    delete Crypto.prototype.randomUUID;
    Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
    Object.defineProperty(Navigator.prototype, "mediaDevices", { get: () => undefined });
  });
}

async function installChatApi(page) {
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
    if (method === "GET" && path === "/api/chats") return json(route, { chats: [chat] });
    if (method === "POST" && path === "/api/chats") return json(route, { chat });
    if (method === "GET" && path === "/api/chats/chat-1") return json(route, { chat, messages: [] });
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

test("a message can be sent from a page without secure only browser features", async ({ page }) => {
  await removeSecurePageFeatures(page);
  await installChatApi(page);
  await page.goto("/chat/chat-1");

  const missing = await page.evaluate(() => ({
    randomUUID: typeof crypto.randomUUID,
    clipboard: typeof navigator.clipboard,
  }));
  expect(missing).toEqual({ randomUUID: "undefined", clipboard: "undefined" });

  const composer = page.getByPlaceholder(/Ask Test model/);
  await expect(composer).toBeVisible();
  await composer.fill("say something");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => page.evaluate(() => Boolean(window.__chatStream))).toBe(true);
  await pushChat(page, "the reply still arrives");

  await expect(page.locator('[data-message-role="user"]').last()).toContainText("say something");
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText("the reply still arrives");
  await expect(page.getByText("is not a function")).toHaveCount(0);
});

test("the microphone is hidden where recording cannot work", async ({ page }) => {
  await removeSecurePageFeatures(page);
  await installChatApi(page);
  await page.goto("/chat/chat-1");

  await expect(page.getByPlaceholder(/Ask Test model/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Record prompt" })).toHaveCount(0);
});
