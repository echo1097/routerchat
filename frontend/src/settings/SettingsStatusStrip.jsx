import { ChevronRight } from "lucide-react";
import { cx } from "../uiShared.js";

export function SettingsStatusStrip({ items, onJump }) {
  return (
    <div
      role="group"
      aria-label="Current setup"
      className="settings-strip"
      style={{ "--strip-count": items.length }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onJump(item.page, item.target)}
          aria-label={`${item.label}: ${item.value}${item.status ? `, ${item.status}` : ""}. Open ${item.pageLabel} settings`}
          className="settings-strip-tile group"
        >
          <span className="flex w-full items-center justify-between gap-2">
            <span
              className={cx(
                "truncate text-[11.5px] font-medium",
                item.tone === "error" ? "text-[#fca5a5]" : "text-[#8a8a8a]",
              )}
            >
              {item.caption || item.label}
            </span>
            <ChevronRight
              size={13}
              strokeWidth={2}
              aria-hidden="true"
              className="settings-strip-chevron shrink-0 text-neutral-500"
            />
          </span>
          <span className="flex w-full min-w-0 items-center gap-2">
            {item.tone && (
              <span
                aria-hidden="true"
                className={cx("settings-strip-dot", item.tone === "error" ? "is-error" : "is-ok")}
              />
            )}
            <span className="truncate text-sm font-medium text-neutral-100">{item.value}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
