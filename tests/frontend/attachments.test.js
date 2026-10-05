import { describe, expect, it } from "vitest";

import { supportsImageInput } from "../../frontend/src/modelReasoning.js";
import {
  MAX_TEXT_BYTES,
  acceptAttribute,
  attachmentKind,
  fileExtension,
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

describe("file picker accept attribute", () => {
  it("offers images only when the model can read them", () => {
    expect(acceptAttribute(true)).toContain(".png");
    expect(acceptAttribute(false)).not.toContain(".png");
  });

  it("always offers documents", () => {
    expect(acceptAttribute(false)).toContain(".pdf");
    expect(acceptAttribute(false)).toContain(".md");
  });
});

describe("readable size", () => {
  it("scales the unit to the size", () => {
    expect(readableSize(512)).toBe("512 B");
    expect(readableSize(2048)).toBe("2 KB");
    expect(readableSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
