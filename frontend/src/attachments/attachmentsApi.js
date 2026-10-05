export const MAX_FILES_PER_MESSAGE = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
export const PDF_EXTENSIONS = [".pdf"];
export const TEXT_EXTENSIONS = [
  ".txt", ".md", ".markdown", ".csv", ".json", ".yaml", ".yml", ".xml",
  ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go",
  ".rs", ".java", ".c", ".h", ".cpp", ".cs", ".php", ".sh", ".sql",
  ".toml", ".ini", ".log",
];

export function fileExtension(filename) {
  const name = String(filename || "");
  const dotIndex = name.lastIndexOf(".");
  return dotIndex === -1 ? "" : name.slice(dotIndex).toLowerCase();
}

export function attachmentKind(filename) {
  const extension = fileExtension(filename);

  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (PDF_EXTENSIONS.includes(extension)) return "pdf";
  if (TEXT_EXTENSIONS.includes(extension)) return "text";

  return null;
}

export function acceptAttribute(allowImages) {
  const extensions = allowImages
    ? [...IMAGE_EXTENSIONS, ...PDF_EXTENSIONS, ...TEXT_EXTENSIONS]
    : [...PDF_EXTENSIONS, ...TEXT_EXTENSIONS];

  return extensions.join(",");
}

export function readableSize(byteCount) {
  const size = Number(byteCount) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function sizeLimitForKind(kind) {
  if (kind === "image") return MAX_IMAGE_BYTES;
  if (kind === "pdf") return MAX_PDF_BYTES;
  return MAX_TEXT_BYTES;
}

function providerImageLimit(kind, maxImageBytes) {
  if (kind !== "image") return null;

  const limit = Number(maxImageBytes) || 0;
  return limit > 0 && limit < MAX_IMAGE_BYTES ? limit : null;
}

export function rejectionReason(file, allowImages, providerLimits = {}) {
  const kind = attachmentKind(file.name);

  if (!kind) {
    return `${file.name} is not a supported file type.`;
  }

  if (kind === "image" && !allowImages) {
    return "This model cannot read images.";
  }

  const providerLimit = providerImageLimit(kind, providerLimits.maxImageBytes);
  if (providerLimit && file.size > providerLimit) {
    const providerName = providerLimits.providerName || "this provider";
    return `${file.name} is larger than ${readableSize(providerLimit)}, the most ${providerName} accepts for an image.`;
  }

  const limit = sizeLimitForKind(kind);
  if (file.size > limit) {
    return `${file.name} is larger than ${readableSize(limit)}.`;
  }

  if (file.size === 0) {
    return `${file.name} is empty.`;
  }

  return null;
}

export function totalAttachmentBytes(attachments) {
  return (attachments || []).reduce(
    (total, attachment) => total + (Number(attachment.size_bytes ?? attachment.size) || 0),
    0,
  );
}

export function requestSizeRejection(file, usedBytes, providerLimits = {}) {
  const limit = Number(providerLimits.maxRequestAttachmentBytes) || 0;
  if (limit <= 0 || usedBytes + file.size <= limit) return null;

  const providerName = providerLimits.providerName || "This provider";
  const limitNote = `${providerName} accepts about ${readableSize(limit)} of files per request`;

  if (providerLimits.earlierBytes > 0) {
    return `${file.name} does not fit. ${limitNote}, and earlier files in this chat are sent again with every message.`;
  }

  return `${file.name} does not fit. ${limitNote}.`;
}

export function attachmentPreviewUrl(attachmentId) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}/raw`;
}

export async function uploadAttachments(files, signal) {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file, file.name);
  }

  const response = await fetch("/api/attachments", {
    method: "POST",
    body: form,
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    let detail = null;

    try {
      detail = JSON.parse(body)?.detail;
    } catch {
      detail = null;
    }

    const message = typeof detail === "string"
      ? detail
      : detail?.message || "That file could not be uploaded.";
    throw new Error(message);
  }

  const payload = await response.json();
  return payload.attachments || [];
}

export async function deleteAttachment(attachmentId) {
  await fetch(`/api/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}
