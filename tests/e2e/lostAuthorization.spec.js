import { test, expect } from "@playwright/test";
import { json } from "./routeResponse.js";

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

const AUTH_REQUIRED = {
  detail: {
    code: "api_auth_required",
    message: "Open RouterChat through its launcher to authorize this browser.",
  },
};

async function installApi(page, streamReply) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (method === "POST" && path === "/api/chats/chat-1/messages/stream") {
      return json(route, streamReply.body, streamReply.status);
    }
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
    if (method === "GET" && path === "/api/chats/chat-1") return json(route, { chat: CHAT, messages: [] });
    if (method === "GET" && path === "/api/stories") return json(route, { stories: [] });
    if (method === "GET" && path === "/api/folders") return json(route, { folders: [] });

    return json(route, {}, 200);
  });
}

async function sendPrompt(page) {
  await page.goto("/chat/chat-1");

  const composer = page.getByPlaceholder(/Ask Test model/);
  await expect(composer).toBeVisible();
  await composer.fill("hello there");
  await page.getByRole("button", { name: "Send" }).click();
}

test("losing authorization mid session goes back to the authorization screen", async ({ page }) => {
  await installApi(page, { status: 401, body: AUTH_REQUIRED });
  await sendPrompt(page);

  await expect(page.getByText("This browser isn't authorized")).toBeVisible();
  await expect(page.getByText("API key missing")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open Settings" })).toHaveCount(0);
});

test("a missing provider key still points at settings", async ({ page }) => {
  await installApi(page, { status: 401, body: { detail: "Add an API key in Settings." } });
  await sendPrompt(page);

  const notice = page.locator('[data-message-role="assistant"]').last().getByRole("alert");
  await expect(notice).toContainText("API key missing");
  await expect(notice.getByRole("button", { name: "Open Settings" })).toBeVisible();
});
