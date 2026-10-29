import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ErrorNotice } from "../../frontend/src/components/ErrorNotice.jsx";
import { liveErrorNotice, savedErrorNotice } from "../../frontend/src/components/errorNotice.js";

const noop = () => {};

function render(error, handlers = {}) {
  return renderToStaticMarkup(<ErrorNotice error={error} {...handlers} />);
}

describe("saved error notices", () => {
  it("reads a structured error saved on a message", () => {
    const saved = JSON.stringify({ kind: "noCredit", title: "Out of OpenRouter credit", message: "Add credit." });

    expect(savedErrorNotice(saved)).toMatchObject({ kind: "noCredit", title: "Out of OpenRouter credit" });
  });

  it("ignores old plain text errors that already live in the reply", () => {
    expect(savedErrorNotice("OpenRouter error 402: Insufficient credits")).toBeNull();
    expect(savedErrorNotice(null)).toBeNull();
  });
});

describe("live error notices", () => {
  it("keeps the kind, title, and provider from a stream event", () => {
    const notice = liveErrorNotice({ kind: "badKey", title: "API key isn't working", message: "Update it.", provider: "Anthropic" });

    expect(notice).toEqual({ kind: "badKey", title: "API key isn't working", message: "Update it.", provider: "Anthropic" });
  });

  it("turns a plain string into an unknown error", () => {
    expect(liveErrorNotice("Something broke")).toMatchObject({ kind: "unknown", message: "Something broke" });
  });

  it("falls back to a message when there is nothing to show", () => {
    expect(liveErrorNotice(null, "Try again.").message).toBe("Try again.");
  });
});

describe("error notice buttons", () => {
  it("sends a bad key to settings without offering a retry", () => {
    const html = render({ kind: "badKey", title: "API key isn't working", message: "Update it." }, {
      onRetry: noop,
      onOpenSettings: noop,
    });

    expect(html).toContain("Open Settings");
    expect(html).not.toContain("Retry");
  });

  it("links out to add credit and still offers a retry", () => {
    const html = render(
      { kind: "noCredit", title: "Out of OpenRouter credit", message: "Add credit.", provider: "OpenRouter" },
      { onRetry: noop },
    );

    expect(html).toContain("https://openrouter.ai/settings/credits");
    expect(html).toContain("Add credit");
    expect(html).toContain("Retry");
  });

  it("offers a new chat when the conversation is too long", () => {
    const html = render({ kind: "contextTooLong", title: "Conversation is too long", message: "Start fresh." }, {
      onNewChat: noop,
      onRetry: noop,
    });

    expect(html).toContain("New chat");
  });

  it("shows only the buttons it has handlers for", () => {
    const html = render({ kind: "timeout", title: "Anthropic took too long", message: "Try again." });

    expect(html).not.toContain("<button");
  });

  it("renders nothing without an error", () => {
    expect(render(null)).toBe("");
  });
});
