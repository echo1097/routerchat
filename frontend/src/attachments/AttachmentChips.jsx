import React from "react";
import { FileText, Image as ImageIcon, Loader2, X } from "lucide-react";

import { cx, CONTROL_MOTION } from "../uiShared.js";
import { attachmentPreviewUrl, readableSize } from "./attachmentsApi.js";

function AttachmentGlyph({ kind }) {
  if (kind === "image") return <ImageIcon size={15} />;
  return <FileText size={15} />;
}

export function AttachmentChip({ attachment, onRemove, compact = false }) {
  const isImage = attachment.kind === "image";

  return (
    <div
      className={cx(
        "attachment-chip group/chip relative flex min-w-0 items-center gap-2 rounded-2xl bg-white/[0.06] pl-2 pr-2",
        compact ? "h-9" : "h-11",
      )}
    >
      {isImage ? (
        <img
          src={attachmentPreviewUrl(attachment.id)}
          alt=""
          className={cx(
            "shrink-0 rounded-xl object-cover",
            compact ? "h-6 w-6" : "h-7 w-7",
          )}
        />
      ) : (
        <span
          className={cx(
            "grid shrink-0 place-items-center rounded-xl bg-white/[0.07] text-neutral-300",
            compact ? "h-6 w-6" : "h-7 w-7",
          )}
        >
          <AttachmentGlyph kind={attachment.kind} />
        </span>
      )}

      <span className="flex min-w-0 flex-col leading-tight">
        <span className="max-w-[150px] truncate text-xs font-medium text-neutral-200">
          {attachment.filename}
        </span>
        <span className="text-[11px] tabular-nums text-neutral-500">
          {readableSize(attachment.size_bytes)}
        </span>
      </span>

      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          aria-label={`Remove ${attachment.filename}`}
          title={`Remove ${attachment.filename}`}
          className={cx(
            "absolute -right-1.5 -top-1.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-neutral-700 text-neutral-200",
            "opacity-0 group-hover/chip:opacity-100 focus:opacity-100 focus:outline-none",
            "hover:bg-neutral-600 hover:text-white",
            CONTROL_MOTION,
          )}
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}

export default function AttachmentChips({
  attachments,
  uploading = false,
  onRemove,
  compact = false,
  className = "",
}) {
  if (attachments.length === 0 && !uploading) return null;

  return (
    <div className={cx("flex flex-wrap items-center gap-2", className)}>
      {attachments.map((attachment) => (
        <AttachmentChip
          key={attachment.id}
          attachment={attachment}
          onRemove={onRemove}
          compact={compact}
        />
      ))}

      {uploading && (
        <span
          className={cx(
            "inline-flex items-center gap-2 rounded-2xl bg-white/[0.06] px-3 text-xs text-neutral-400",
            compact ? "h-9" : "h-11",
          )}
        >
          <Loader2 size={14} className="animate-spin" />
          Uploading
        </span>
      )}
    </div>
  );
}
