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
  message_revision: 2,
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
          window.__chatStream = { controller, payload: JSON.parse(init.body) };
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

test("keeps a conflicting regeneration as a copyable unsaved reply until reload", async ({ page }) => {
  const serverMessages = [
    message("user-1", "user", "original prompt"),
    message("assistant-1", "assistant", "original answer"),
  ];
  await installChatApi(page, serverMessages);
  await page.addInitScript(() => {
    window.auditCopiedText = "";
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText: async (text) => { window.auditCopiedText = text; },
    } });
  });
  await page.goto("/chat/chat-1");
  const originalReply = page.locator('[data-message-role="assistant"]').last();
  await originalReply.hover();
  await originalReply.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__chatStream))).toBe(true);

  serverMessages.push(
    message("user-2", "user", "new phone message"),
    message("assistant-2", "assistant", "new phone answer"),
  );
  await pushEvent(page, { type: "content", value: "unsaved replacement answer" });
  await pushEvent(page, { type: "error", value: {
    code: "chat_revision_conflict",
    kind: "chatConflict",
    title: "Chat changed on another device",
    message: "This reply wasn't saved because the chat changed. Copy any text you want to keep, then reload the chat before trying again.",
  } });
  await closeStream(page);

  const preview = page.locator('[data-message-role="assistant"]').last();
  await expect(preview).toContainText("unsaved replacement answer");
  await expect(preview).toContainText("Unsaved reply");
  await expect(preview.getByRole("alert")).toContainText("Chat changed on another device");
  await expect(preview.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await preview.getByRole("button", { name: "Copy reply", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.auditCopiedText)).toBe("unsaved replacement answer");
  const composer = page.getByPlaceholder(/Ask Test model/);
  await composer.fill("a draft to send after reloading");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await composer.press("Enter");
  await expect(composer).toHaveValue("a draft to send after reloading");
  await expect(preview).toContainText("unsaved replacement answer");

  await preview.getByRole("button", { name: "Reload chat", exact: true }).click();
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText("new phone answer");
  await expect(page.getByText("original answer", { exact: true })).toBeVisible();
  await expect(page.getByText("Unsaved reply", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("rejects a stale regeneration before streaming and offers to reload", async ({ page }) => {
  const serverMessages = [
    message("user-1", "user", "original prompt"),
    message("assistant-1", "assistant", "original answer"),
  ];
  await installChatApi(page, serverMessages);
  await page.goto("/chat/chat-1");
  const originalReply = page.locator('[data-message-role="assistant"]').last();
  await expect(originalReply).toContainText("original answer");
  await page.evaluate(() => {
    const previousFetch = window.fetch;
    window.fetch = async (input, init = {}) => {
      if (String(input).endsWith("/messages/stream")) {
        window.auditRegenerationPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ detail: {
          code: "chat_revision_conflict",
          kind: "chatConflict",
          title: "Chat changed on another device",
          message: "Reload this chat before trying again.",
        } }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
      return previousFetch(input, init);
    };
  });
  await originalReply.hover();
  await originalReply.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Chat changed on another device");
  expect(await page.evaluate(() => window.auditRegenerationPayload.chat_revision)).toBe(2);
  await expect(page.getByRole("button", { name: "Copy reply", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reload chat", exact: true }).click();
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText("original answer");
  await expect(page.getByPlaceholder(/Ask Test model/)).toBeEnabled();
});
