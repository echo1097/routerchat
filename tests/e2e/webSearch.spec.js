import { test, expect } from "@playwright/test";

import { installWriteApi } from "./writeReliability.fixture.js";

const MODEL = {
  id: "test/model",
  name: "Test model",
  context_length: 128000,
  pricing: { prompt: "0", completion: "0" },
};

function newChat() {
  return {
    id: "chat-1",
    title: "Test chat",
    model: "test/model",
    web_search_enabled: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function installChatApi(page, sent, serverMessages = []) {
  const chat = newChat();

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
    if (method === "GET" && path === "/api/chats/chat-1") {
      return json(route, { chat, messages: serverMessages.slice() });
    }

    if (method === "GET" && path === "/api/favicon") {
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG_PIXEL });
    }
    if (method === "GET" && path === "/api/stories") return json(route, { stories: [] });
    if (method === "GET" && path === "/api/folders") return json(route, { folders: [] });

    if (method === "PATCH" && path === "/api/chats/chat-1") {
      const patch = JSON.parse(request.postData() || "{}");
      chat.web_search_enabled = Boolean(patch.web_search_enabled);
      return json(route, { chat });
    }

    if (method === "POST" && path === "/api/chats/chat-1/messages/stream") {
      sent.push(JSON.parse(request.postData() || "{}"));
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Assistant-Message-Id": "assistant-1",
        },
        body: `${JSON.stringify({ type: "content", value: "done" })}\n`,
      });
    }

    return json(route, {}, 200);
  });
}

async function askSomething(page) {
  const composer = page.getByPlaceholder(/Ask Test model/);
  await composer.fill("what happened today");
  await page.getByRole("button", { name: "Send" }).click();
}

test("the toggle starts off and sends no web search", async ({ page }) => {
  const sent = [];
  await installChatApi(page, sent);
  await page.goto("/chat/chat-1");

  const toggle = page.getByRole("button", { name: "Web search" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await askSomething(page);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].web_search_enabled).toBe(false);
});

test("clicking it brightens the button and turns web search on for the request", async ({ page }) => {
  const sent = [];
  await installChatApi(page, sent);
  await page.goto("/chat/chat-1");

  const toggle = page.getByRole("button", { name: "Web search" });
  const dimColor = await toggle.evaluate((node) => getComputedStyle(node).color);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await expect
    .poll(() => toggle.evaluate((node) => getComputedStyle(node).color))
    .toBe("rgb(255, 255, 255)");
  expect(dimColor).not.toBe("rgb(255, 255, 255)");

  await askSomething(page);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].web_search_enabled).toBe(true);
});

test("the toggle is not offered in write mode", async ({ page }) => {
  const api = await installWriteApi(page);
  await api.open();

  await expect(page.locator('[data-tour="attach-button"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Web search" })).toBeHidden();
});

async function installControlledStream(page) {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__chatStream = null;

    window.fetch = async (input, init = {}) => {
      const requestUrl = typeof input === "string" ? input : input?.url || "";
      if (!/\/api\/chats\/[^/]+\/messages\/stream$/.test(requestUrl)) {
        return nativeFetch(input, init);
      }

      window.__chatRequest = JSON.parse(String(init.body || "{}"));
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
}

async function pushEvent(page, event) {
  await page.evaluate((payload) => {
    window.__chatStream.controller.enqueue(
      new TextEncoder().encode(`${JSON.stringify(payload)}\n`),
    );
  }, event);
}

const CITED = [
  { url: "https://support.google.com/chrome/a", title: "Chrome help", domain: "support.google.com" },
  { url: "https://support.google.com/chrome/b", title: "More help", domain: "support.google.com" },
  { url: "https://en.wikipedia.org/wiki/Chrome", title: "Chrome", domain: "en.wikipedia.org" },
];

test("shows Searching, then the sites it found, then the answer", async ({ page }) => {
  await installControlledStream(page);
  await installChatApi(page, []);
  await page.goto("/chat/chat-1");

  await page.getByRole("button", { name: "Web search" }).click();
  await askSomething(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.__chatStream))).toBe(true);

  await expect(page.getByText("Searching")).toBeVisible();

  await pushEvent(page, { type: "sources", value: CITED });

  const pills = page.locator(".source-pill");
  await expect(pills).toHaveCount(2);
  await expect(pills.first()).toContainText("support.google.com");
  await expect(pills.first()).toContainText("+1");
  await expect(pills.first().locator("img")).toHaveAttribute(
    "src",
    "/api/favicon?domain=support.google.com",
  );

  await pushEvent(page, { type: "content", value: "here is what I found" });
  await expect(page.getByText("Searching")).toBeHidden();
  await expect(page.locator('[data-message-role="assistant"]').last())
    .toContainText("here is what I found");
});

test("keeps the sources under the answer after a reload", async ({ page }) => {
  const serverMessages = [
    {
      id: "message-1",
      chat_id: "chat-1",
      role: "user",
      content: "what happened today",
      created_at: "2026-01-01T00:00:01Z",
    },
    {
      id: "message-2",
      chat_id: "chat-1",
      role: "assistant",
      content: "here is what I found",
      reasoning: "",
      sources: CITED,
      created_at: "2026-01-01T00:00:02Z",
    },
  ];

  await installChatApi(page, [], serverMessages);
  await page.goto("/chat/chat-1");

  const assistant = page.locator('[data-message-role="assistant"]').last();
  await expect(assistant).toContainText("here is what I found");

  const pills = assistant.locator(".source-pill");
  await expect(pills).toHaveCount(2);
  await expect(pills.nth(1)).toContainText("en.wikipedia.org");
  await expect(pills.first()).toHaveAttribute("href", "https://support.google.com/chrome/a");
});

test("no pills and no Searching step when web search is off", async ({ page }) => {
  await installControlledStream(page);
  await installChatApi(page, []);
  await page.goto("/chat/chat-1");

  await askSomething(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.__chatStream))).toBe(true);

  await expect(page.getByText("Working")).toBeVisible();
  await expect(page.getByText("Searching")).toBeHidden();
  await expect(page.locator(".source-pill")).toHaveCount(0);
});
