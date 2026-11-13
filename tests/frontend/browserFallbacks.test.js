import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText, newId } from "../../frontend/src/browserFallbacks.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;


afterEach(() => {
  vi.unstubAllGlobals();
});


function fakeDocument(copyWorks) {
  const field = {
    style: {},
    value: "",
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };

  const page = {
    field,
    createElement: vi.fn(() => field),
    body: { appendChild: vi.fn() },
    execCommand: vi.fn(() => copyWorks),
  };

  return page;
}


describe("newId", () => {
  it("uses the browser id when it is available", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "from-the-browser" });

    expect(newId()).toBe("from-the-browser");
  });

  it("still makes a valid id on pages without randomUUID", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes) => {
        bytes.forEach((_, index) => {
          bytes[index] = (index * 37 + 11) % 256;
        });
        return bytes;
      },
    });

    expect(newId()).toMatch(uuidPattern);
  });

  it("makes a different id each time", () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (bytes) => realCrypto.getRandomValues(bytes) });

    const ids = new Set(Array.from({ length: 50 }, () => newId()));

    expect(ids.size).toBe(50);
  });
});


describe("copyText", () => {
  it("uses the clipboard when the page has one", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyText("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to selecting hidden text on pages without a clipboard", async () => {
    const page = fakeDocument(true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", page);

    await copyText("hello");

    expect(page.field.value).toBe("hello");
    expect(page.execCommand).toHaveBeenCalledWith("copy");
    expect(page.field.remove).toHaveBeenCalled();
  });

  it("reports a failure and cleans up when the fallback cannot copy", async () => {
    const page = fakeDocument(false);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", page);

    await expect(copyText("hello")).rejects.toThrow("Copying isn't available");
    expect(page.field.remove).toHaveBeenCalled();
  });
});
