import { cx, CONTROL_MOTION } from "../uiShared.js";

export function SidebarActionButton({ icon, label, onClick, disabled = false, tourId }) {
  return (
    <button
      type="button"
      data-tour={tourId}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "flex h-9 w-full items-center gap-3 rounded-xl bg-transparent px-2 text-[15px] font-medium text-white hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-55",
        CONTROL_MOTION,
      )}
    >
      <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center text-neutral-200">
        {icon}
      </span>
      {label}
    </button>
  );
}
