import { cx } from "../uiShared.js";

export function SidebarGroup({ label, open, onToggle, children, dropProps = {}, dropActive = false }) {
  const panelId = `${label.toLowerCase()}-chat-history`;

  return (
    <section
      className={cx(
        "t-acc chat-history-group rounded-2xl border border-transparent px-1 transition-[background-color,border-color,box-shadow] duration-150 ease-out",
        dropActive && "border-white/20 bg-white/[0.07]",
      )}
      data-open={String(open)}
      {...dropProps}
    >
      <button
        type="button"
        className="t-acc-head chat-history-group-heading"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span>{label}</span>
        <span className="t-acc-chevron chat-history-group-chevron" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M4 6.5L8 10.5L12 6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <div id={panelId} className="t-acc-panel">
        <div className="t-acc-panel-inner chat-history-group-items">
          {children}
        </div>
      </div>
    </section>
  );
}
