import { cx, CONTROL_MOTION } from "../uiShared.js";

export function TemporaryChatButton({ active, onClick }) {
  return (
    <button
      type="button"
      data-tour="temp-chat-button"
      aria-label={active ? "Temporary chat on" : "Temporary chat off"}
      title={active ? "Temporary chat on" : "Temporary chat off"}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full text-[17px] leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        CONTROL_MOTION,
        active
          ? "text-neutral-100"
          : "text-neutral-400 hover:text-neutral-100",
      )}
    >
      <span className="t-icon-swap temp-chat-toggle-icon" data-state={active ? "b" : "a"}>
        <span className="t-icon" data-icon="a" aria-hidden="true">
          <i className="fi fi-rr-ghost" />
        </span>
        <span className="t-icon" data-icon="b" aria-hidden="true">
          <i className="fi fi-sr-ghost" />
        </span>
      </span>
    </button>
  );
}

export function TemporaryChatMarker({ visible }) {
  if (!visible) return null;

  return (
    <div
      className="pointer-events-none absolute left-4 top-16 z-20 flex h-10 w-10 items-center justify-center text-[18px] leading-none text-neutral-100 sm:left-8 sm:top-4 lg:left-10"
      aria-hidden="true"
    >
      <i className="fi fi-rs-ghost" />
    </div>
  );
}
