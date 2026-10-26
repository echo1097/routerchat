import { describe, expect, it } from "vitest";

import { supportsImageInput } from "../../frontend/src/modelReasoning.js";
import {
  MAX_TEXT_BYTES,
  attachmentKind,
  detectAttachmentKind,
  fileExtension,
  looksLikeText,
  readableSize,
  rejectionReason,
  requestSizeRejection,
  totalAttachmentBytes,
} from "../../frontend/src/attachments/attachmentsApi.js";

const models = [
  {
    id: "test/vision",
    architecture: { input_modalities: ["text", "image"], modality: "text+image->text" },
  },
  {
    id: "test/text-only",
    architecture: { input_modalities: ["text"], modality: "text->text" },
  },
  {
    id: "test/legacy-vision",
    architecture: { modality: "text+image->text" },
  },
  {
    id: "test/no-metadata",
  },
];

function fakeFile(name, size) {
  return { name, size };
}

function realFile(name, bytes) {
  return new File([bytes], name);
}

describe("model image input support", () => {
  it("reads image support from the input modalities list", () => {
    expect(supportsImageInput(models, "test/vision")).toBe(true);
    expect(supportsImageInput(models, "test/text-only")).toBe(false);
  });

  it("falls back to the combined modality string on older cached entries", () => {
    expect(supportsImageInput(models, "test/legacy-vision")).toBe(true);
  });

  it("treats a model with no architecture metadata as text only", () => {
    expect(supportsImageInput(models, "test/no-metadata")).toBe(false);
    expect(supportsImageInput(models, "test/missing")).toBe(false);
  });

  it("ignores the nitro suffix when matching a model", () => {
    expect(supportsImageInput(models, "test/vision:nitro")).toBe(true);
  });
});

describe("attachment classification", () => {
  it("reads the extension case insensitively", () => {
    expect(fileExtension("Screenshot.PNG")).toBe(".png");
    expect(fileExtension("noextension")).toBe("");
  });

  it("sorts files into the three kinds", () => {
    expect(attachmentKind("shot.png")).toBe("image");
    expect(attachmentKind("paper.pdf")).toBe("pdf");
    expect(attachmentKind("notes.md")).toBe("text");
    expect(attachmentKind("archive.zip")).toBe(null);
  });
});

describe("attachment rejection", () => {
  it("accepts a supported file within its size limit", () => {
    expect(rejectionReason(fakeFile("notes.md", 2048), true)).toBe(null);
  });

  it("rejects an unsupported file type", () => {
    expect(rejectionReason(fakeFile("archive.zip", 2048), true))
      .toContain("not a supported file type");
  });

  it("rejects an image when the model cannot read images", () => {
    expect(rejectionReason(fakeFile("shot.png", 2048), false))
      .toBe("This model cannot read images.");
  });

  it("still accepts documents when the model cannot read images", () => {
    expect(rejectionReason(fakeFile("notes.md", 2048), false)).toBe(null);
    expect(rejectionReason(fakeFile("paper.pdf", 2048), false)).toBe(null);
  });

  it("rejects a file over its kind's size limit", () => {
    expect(rejectionReason(fakeFile("big.txt", MAX_TEXT_BYTES + 1), true))
      .toContain("larger than");
  });

  it("rejects an image over the provider's own limit", () => {
    const limits = { maxImageBytes: 7.5 * 1024 * 1024, providerName: "Anthropic" };

    expect(rejectionReason(fakeFile("shot.png", 7.5 * 1024 * 1024 + 1), true, limits))
      .toBe("shot.png is larger than 7.5 MB, the most Anthropic accepts for an image.");
    expect(rejectionReason(fakeFile("shot.png", 7.5 * 1024 * 1024), true, limits)).toBe(null);
  });

  it("keeps the provider image limit away from other files and providers", () => {
    const limits = { maxImageBytes: 7.5 * 1024 * 1024, providerName: "Anthropic" };
    const nineMegabytes = 9 * 1024 * 1024;

    expect(rejectionReason(fakeFile("paper.pdf", nineMegabytes), true, limits)).toBe(null);
    expect(rejectionReason(fakeFile("shot.png", nineMegabytes), true)).toBe(null);
    expect(rejectionReason(fakeFile("shot.png", nineMegabytes), true, { maxImageBytes: null })).toBe(null);
  });

  it("rejects an empty file", () => {
    expect(rejectionReason(fakeFile("empty.txt", 0), true)).toContain("is empty");
  });
});

describe("request size limit", () => {
  const megabyte = 1024 * 1024;
  const limits = { maxRequestAttachmentBytes: 21 * megabyte, providerName: "Anthropic" };

  it("adds up attachment sizes", () => {
    expect(totalAttachmentBytes([{ size_bytes: 5 }, { size_bytes: 7 }, {}])).toBe(12);
    expect(totalAttachmentBytes(undefined)).toBe(0);
  });

  it("accepts a file that still fits in the request", () => {
    expect(requestSizeRejection(fakeFile("shot.png", 7 * megabyte), 14 * megabyte, limits)).toBe(null);
  });

  it("rejects a file that pushes the request over the limit", () => {
    expect(requestSizeRejection(fakeFile("shot.png", 7 * megabyte), 15 * megabyte, limits))
      .toBe("shot.png does not fit. Anthropic accepts about 21.0 MB of files per request.");
  });

  it("explains that earlier files count when the chat already has some", () => {
    const reason = requestSizeRejection(
      fakeFile("shot.png", 7 * megabyte),
      15 * megabyte,
      { ...limits, earlierBytes: 15 * megabyte },
    );

    expect(reason).toContain("earlier files in this chat are sent again with every message");
  });

  it("has no request limit for providers that do not set one", () => {
    expect(requestSizeRejection(fakeFile("shot.png", 9 * megabyte), 90 * megabyte)).toBe(null);
    expect(requestSizeRejection(fakeFile("shot.png", 9 * megabyte), 0, { maxRequestAttachmentBytes: null }))
      .toBe(null);
  });
});

describe("text detection for unknown files", () => {
  it("treats readable files with any name as text", async () => {
    expect(await detectAttachmentKind(realFile("Main.kt", "fun main() {\n\tprintln(1)\n}\n"))).toBe("text");
    expect(await detectAttachmentKind(realFile("Dockerfile", "FROM python:3.12\n"))).toBe("text");
    expect(await detectAttachmentKind(realFile(".gitignore", "node_modules/\r\n"))).toBe("text");
    expect(await detectAttachmentKind(realFile("notes.unknownext", "café ☃ 😀"))).toBe("text");
    expect(await detectAttachmentKind(realFile("build.output", "\x1b[32mok\x1b[0m\f\n"))).toBe("text");
  });

  it("turns away files that are not text", async () => {
    expect(await detectAttachmentKind(realFile("archive.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])))).toBe(null);
    expect(await detectAttachmentKind(realFile("program.exe", new Uint8Array([0x4d, 0x5a, 0x90, 0x00])))).toBe(null);
    expect(await detectAttachmentKind(realFile("latin1.unknownext", new Uint8Array([0x63, 0x61, 0x66, 0xe9])))).toBe(null);
  });

  it("keeps using the extension for files it already knows", async () => {
    expect(await detectAttachmentKind(realFile("shot.png", new Uint8Array([0x89, 0x50, 0x00])))).toBe("image");
    expect(await detectAttachmentKind(realFile("notes.md", new Uint8Array([0xff, 0x00])))).toBe("text");
  });

  it("tolerates a character cut off where the check stops reading", async () => {
    const bytes = new Uint8Array(MAX_TEXT_BYTES + 2).fill(0x61);
    bytes.set([0xe2, 0x98, 0x83], MAX_TEXT_BYTES - 1);

    expect(await looksLikeText(realFile("long.unknownext", bytes))).toBe(true);
    expect(await looksLikeText(realFile("short.unknownext", new Uint8Array([0x61, 0xe2, 0x98])))).toBe(false);
  });

  it("treats a file it cannot read as not text", async () => {
    const unreadable = {
      name: "locked.unknownext",
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error("denied")) }),
    };

    expect(await looksLikeText(unreadable)).toBe(false);
  });

  it("lets a detected text file through and sizes it as text", async () => {
    const small = realFile("Main.kt", "fun main() {}");
    expect(rejectionReason(small, false, {}, await detectAttachmentKind(small))).toBe(null);

    const big = realFile("big.unknownext", "x".repeat(MAX_TEXT_BYTES + 1));
    expect(rejectionReason(big, true, {}, await detectAttachmentKind(big))).toContain("larger than");

    const binary = realFile("archive.zip", new Uint8Array([0x00, 0x01]));
    expect(rejectionReason(binary, true, {}, await detectAttachmentKind(binary)))
      .toContain("not a supported file type");
  });
});

describe("readable size", () => {
  it("scales the unit to the size", () => {
    expect(readableSize(512)).toBe("512 B");
    expect(readableSize(2048)).toBe("2 KB");
    expect(readableSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
