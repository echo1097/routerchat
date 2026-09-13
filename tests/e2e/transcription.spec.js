import { test, expect } from "@playwright/test";
import { installWriteApi } from "./writeReliability.fixture.js";

async function mockMicrophone(page, denied = false) {
  await page.addInitScript(({ denied }) => {
    window.stoppedTracks = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      if (denied) throw new DOMException("Denied", "NotAllowedError");
      return { getTracks: () => [{ stop: () => { window.stoppedTracks += 1; } }] };
    };
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.state = "inactive"; }
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob(["mock audio"]) });
          this.onstop?.();
        });
      }
    };
    window.AudioContext = class {
      createAnalyser() { return { fftSize: 32, getByteTimeDomainData: (samples) => samples.fill(144) }; }
      createMediaStreamSource() { return { connect() {} }; }
      close() { return Promise.resolve(); }
    };
  }, { denied });
}

async function installChat(page) {
  const sent = [];
  const transcriptions = [];
  const settings = { default_model: "test/model", transcription_model: "openai/whisper-1" };
  const chat = { id: "chat-1", title: "Test chat", model: "test/model" };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body = {};
    if (path === "/api/tos") body = { hash: "test", accepted: true, markdown: "Terms" };
    if (path === "/api/settings/key-status") body = { has_key: true };
    if (path === "/api/settings") {
      if (method === "PATCH") Object.assign(settings, route.request().postDataJSON());
      body = settings;
    }
    if (path === "/api/models") body = { models: [{ id: "test/model", name: "Test model", pricing: {} }] };
    if (path === "/api/chats") body = { chats: [chat] };
    if (path === "/api/chats/chat-1") body = { chat, messages: [] };
    if (path === "/api/transcription/models") body = { models: [{ id: "openai/whisper-1", name: "Whisper" }, { id: "test/stt", name: "Other transcription model" }] };
    if (path === "/api/transcription") {
      transcriptions.push(route.request().postDataJSON());
      body = { text: "spoken prompt" };
    }
    if (path.endsWith("/messages/stream")) {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "content", value: "done" })}\n` });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  return { sent, transcriptions, settings };
}

test("cancel preserves the draft and stops the microphone without transcription", async ({ page }) => {
  const state = await installChat(page);
  await mockMicrophone(page);
  await page.goto("/chat/chat-1");
  await page.getByRole("textbox").fill("existing draft");
  await page.getByRole("button", { name: "Record prompt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Transcribe to prompt", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Cancel recording" }).click();
  await expect(page.getByRole("textbox")).toHaveValue("existing draft");
  expect(state.transcriptions).toHaveLength(0);
  expect(await page.evaluate(() => window.stoppedTracks)).toBeGreaterThan(0);
});

test("square appends the transcript and arrow sends the full new prompt", async ({ page }) => {
  const state = await installChat(page);
  await mockMicrophone(page);
  await page.goto("/chat/chat-1");
  await page.getByRole("textbox").fill("existing draft");
  await page.getByRole("button", { name: "Record prompt", exact: true }).click();
  await page.getByRole("button", { name: "Transcribe to prompt", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("existing draft\nspoken prompt");
  expect(state.sent).toHaveLength(0);
  await page.getByRole("button", { name: "Record prompt", exact: true }).click();
  await page.getByRole("button", { name: "Transcribe and send", exact: true }).click();
  await expect.poll(() => state.sent.length).toBe(1);
  expect(JSON.stringify(state.sent[0])).toContain("existing draft\\nspoken prompt\\nspoken prompt");
});

test("denied microphone access leaves the draft usable", async ({ page }) => {
  const state = await installChat(page);
  await mockMicrophone(page, true);
  await page.goto("/chat/chat-1");
  await page.getByRole("button", { name: "Record prompt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Microphone access was denied");
  await expect(page.getByRole("textbox")).toBeEditable();
  expect(state.transcriptions).toHaveLength(0);
});

test("transcription model selection is saved independently", async ({ page }) => {
  const state = await installChat(page);
  await page.goto("/chat/chat-1");
  await page.locator('[data-tour="model-button"]').click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "Transcription", exact: true }).click();
  const transcriptionSettings = page.getByRole("region", { name: "Transcription settings", exact: true });
  await transcriptionSettings.getByPlaceholder("Search models").fill("other");
  await expect(transcriptionSettings.getByRole("button", { name: "Whisper" })).toHaveCount(0);
  await transcriptionSettings.getByRole("button", { name: "Other transcription model test/stt", exact: true }).click();
  await expect.poll(() => state.settings.transcription_model).toBe("test/stt");
  expect(state.settings.default_model).toBe("test/model");
});

for (const mode of ["write", "brainstorm"]) {
  test(`${mode} can transcribe into its prompt`, async ({ page }) => {
    page.on("pageerror", (error) => { throw error; });
    await installWriteApi(page);
    await mockMicrophone(page);
    await page.route("**/api/transcription", (route) => route.fulfill({ json: { text: "spoken writing idea" } }));
    await page.goto(mode === "write" ? "/write/story/story-1/chapter/chapter-1" : "/write/story/story-1/brainstorm");
    await page.getByRole("button", { name: "Record prompt", exact: true }).click();
    await page.getByRole("button", { name: "Transcribe to prompt", exact: true }).click();
    await expect(page.locator(mode === "write" ? "form textarea" : ".brainstorm-composer textarea")).toHaveValue("spoken writing idea");
  });
}

test("failed transcription can retry the recording without losing the draft", async ({ page }) => {
  await installChat(page);
  await mockMicrophone(page);
  let attempts = 0;
  await page.route("**/api/transcription", (route) => {
    attempts += 1;
    return route.fulfill({ status: attempts === 1 ? 502 : 200, json: attempts === 1 ? { detail: "Temporary failure" } : { text: "retried transcript" } });
  });
  await page.goto("/chat/chat-1");
  await page.getByRole("textbox").fill("draft");
  await page.getByRole("button", { name: "Record prompt", exact: true }).click();
  await page.getByRole("button", { name: "Transcribe to prompt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Temporary failure");
  await page.getByRole("button", { name: "Transcribe to prompt", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("draft\nretried transcript");
});

test("recording bar fits mobile and Escape releases the microphone", async ({ page }) => {
  await installChat(page);
  await mockMicrophone(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat/chat-1");
  await page.getByRole("button", { name: "Record prompt", exact: true }).click();
  const recording = page.getByRole("dialog", { name: "Record a prompt" });
  await expect(recording).toBeVisible();
  await expect(page.getByRole("button", { name: "Transcribe to prompt", exact: true })).toBeEnabled();
  await page.screenshot({ path: "/tmp/routerchat-recording-mobile.png" });
  const bounds = await recording.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(recording).not.toBeVisible();
  expect(await page.evaluate(() => window.stoppedTracks)).toBeGreaterThan(0);
});
