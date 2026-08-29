import { test, expect } from "@playwright/test";

//files dropped anywhere in the app land on the prompt bar, internal drags never light it up

const MODEL = {
  id: "test/model",
  name: "Test model",
  context_length: 128000,
  pricing: { prompt: "0", completion: "0" },
  architecture: { input_modalities: ["text", "image"], modality: "text+image->text" },
};

const CHAT = {
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

async function installChatApi(page, uploads) {
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
    if (method === "GET" && path === "/api/chats/chat-1") return json(route, { chat: CHAT, messages: [] });
    if (method === "GET" && path === "/api/stories") return json(route, { stories: [] });
    if (method === "GET" && path === "/api/folders") return json(route, { folders: [] });

    if (method === "POST" && path === "/api/attachments") {
      uploads.push(request.postData() || "");
      return json(route, {
        attachments: [
          {
            id: `attachment-${uploads.length}`,
            filename: "notes.md",
            mime: "text/markdown",
            kind: "text",
            size_bytes: 24,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
    }

    return json(route, {}, 200);
  });
}

async function dispatchDrag(page, eventNames, { withFile }) {
  await page.evaluate(
    ({ names, attachFile }) => {
      const transfer = new DataTransfer();

      if (attachFile) {
        transfer.items.add(new File(["# notes"], "notes.md", { type: "text/markdown" }));
      } else {
        transfer.setData("text/plain", "chat-1");
      }

      for (const name of names) {
        document.body.dispatchEvent(
          new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }
    },
    { names: eventNames, attachFile: withFile },
  );
}

test("dragging a file over the app invites a drop on the prompt bar", async ({ page }) => {
  await installChatApi(page, []);
  await page.goto("/chat/chat-1");
  await expect(page.getByPlaceholder(/Ask Test model/)).toBeVisible();

  const overlay = page.locator(".attachment-drop-overlay");
  await expect(overlay).toBeHidden();

  await dispatchDrag(page, ["dragenter", "dragover"], { withFile: true });
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Drop files to attach");

  //leaving the window puts it away again
  await dispatchDrag(page, ["dragleave"], { withFile: true });
  await expect(overlay).toBeHidden();
});

test("dropping a file attaches it to the prompt bar", async ({ page }) => {
  const uploads = [];
  await installChatApi(page, uploads);
  await page.goto("/chat/chat-1");
  await expect(page.getByPlaceholder(/Ask Test model/)).toBeVisible();

  await dispatchDrag(page, ["dragenter", "dragover", "drop"], { withFile: true });

  await expect(page.locator(".attachment-chip")).toContainText("notes.md");
  await expect(page.locator(".attachment-drop-overlay")).toBeHidden();
  expect(uploads.length).toBe(1);
  expect(uploads[0]).toContain("notes.md");
});

test("dragging a chat between folders does not open the drop target", async ({ page }) => {
  await installChatApi(page, []);
  await page.goto("/chat/chat-1");
  await expect(page.getByPlaceholder(/Ask Test model/)).toBeVisible();

  await dispatchDrag(page, ["dragenter", "dragover"], { withFile: false });

  await expect(page.locator(".attachment-drop-overlay")).toBeHidden();
});
