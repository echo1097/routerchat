import { useState } from "react";
import { cx } from "../uiShared.js";

export function SettingSwitch({ checked, onChange, label, disabled = false, small = false }) {
  const [interacted, setInteracted] = useState(false);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        setInteracted(true);
        onChange(!checked);
      }}
      data-on={String(checked)}
      className={cx(
        "settings-switch t-toggle relative shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25 disabled:cursor-not-allowed",
        small ? "is-small h-6 w-10" : "h-7 w-12",
        interacted && "is-init",
        disabled && "opacity-40",
      )}
    >
      <span
        className={cx(
          "settings-switch-thumb t-toggle-thumb absolute left-1 top-1 rounded-full",
          small ? "h-4 w-4" : "h-5 w-5",
        )}
      />
    </button>
  );
}

export function SettingRow({ title, description, children, stacked = false, compact = false }) {
  return (
    <div
      className={cx(
        "settings-row px-5",
        compact ? "py-2.5" : "py-4",
        stacked ? "space-y-3" : "flex items-center justify-between gap-4",
      )}
    >
      <div className="min-w-0">
        <h3 className="text-balance text-[14.5px] font-medium text-neutral-50">{title}</h3>
        {description && (
          <p className="mt-1 text-pretty text-[13px] leading-5 text-[#8a8a8a]">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

export function SettingGroup({ id, title, trailing, note, className, bodyClassName, children }) {
  const titleId = `${id}-title`;

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={titleId}
      className={cx("settings-group", className)}
    >
      <div className="mb-3 flex min-h-6 items-center justify-between gap-3">
        <h2 id={titleId} className="text-[16px] font-semibold tracking-[-0.01em] text-neutral-100">
          {title}
        </h2>
        {trailing}
      </div>
      <div className={cx("settings-group-body", bodyClassName)}>
        {children}
      </div>
      {note && (
        <p className="mt-2.5 text-pretty text-[13px] leading-5 text-[#8a8a8a]">{note}</p>
      )}
    </div>
  );
}

export function SettingChip({ children, className }) {
  return (
    <span
      className={cx(
        "inline-flex min-h-6 shrink-0 items-center rounded-full bg-white/[0.06] px-2.5 text-[11.5px] font-medium leading-none tabular-nums text-neutral-400",
        className,
      )}
    >
      {children}
    </span>
  );
}
