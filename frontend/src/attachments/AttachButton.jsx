import React, { useRef } from "react";
import { Plus } from "lucide-react";

import { cx, PROMPT_BAR_CONTROL_MOTION } from "../uiShared.js";
import { acceptAttribute } from "./attachmentsApi.js";

export default function AttachButton({
  onFilesPicked,
  allowImages,
  disabled = false,
  modelName = "",
}) {
  const inputRef = useRef(null);

  const title = allowImages
    ? "Attach files"
    : `Attach documents. ${modelName || "This model"} cannot read images.`;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={acceptAttribute(allowImages)}
        className="hidden"
        onChange={(event) => {
          onFilesPicked(event.target.files);
          event.target.value = "";
        }}
      />

      <button
        type="button"
        data-tour="attach-button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        aria-label={title}
        title={title}
        className={cx(
          "grid h-8 w-8 shrink-0 place-items-center rounded-full text-neutral-300",
          "hover:text-white focus:outline-none",
          "disabled:cursor-not-allowed disabled:text-neutral-600 disabled:active:scale-100",
          PROMPT_BAR_CONTROL_MOTION,
        )}
      >
        <Plus size={16} strokeWidth={2.25} />
      </button>
    </>
  );
}
