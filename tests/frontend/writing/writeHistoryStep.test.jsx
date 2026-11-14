import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { WriteHistoryStep } from "../../../frontend/src/writing/WriteHistoryModal.jsx";

function render(step) {
  return renderToStaticMarkup(<WriteHistoryStep step={step} />);
}

describe("write history step details", () => {
  it("formats markdown in saved thinking instead of showing the symbols", () => {
    const markup = render({
      kind: "thinking",
      label: "Gemini thought for 4 seconds",
      detail: "**Planning the rewrite**\n\nI will keep the opening.\n\n- first point\n- second point",
    });

    expect(markup).toContain("<strong");
    expect(markup).toContain("Planning the rewrite");
    expect(markup).toContain("<li");
    expect(markup).not.toContain("**");
  });

  it("leaves a prompt exactly as the user typed it", () => {
    const markup = render({
      kind: "prompt",
      label: "User prompt",
      detail: "make the **second** paragraph shorter",
    });

    expect(markup).toContain("make the **second** paragraph shorter");
    expect(markup).not.toContain("<strong");
  });

  it("still says when no thinking was saved", () => {
    const markup = render({ kind: "thinking", label: "Thought", detail: "" });

    expect(markup).toContain("No thinking saved");
  });
});
