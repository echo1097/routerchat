

export function Accordion({ id, title, open, onToggle, trailing, children }) {
  return (
    <section className="t-acc border-b border-white/[0.08] last:border-b-0" data-open={String(open)}>
      <button
        type="button"
        className="t-acc-head flex min-h-10 w-full items-center justify-between gap-4 rounded-xl px-1 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/35"
        aria-expanded={open}
        onClick={() => onToggle(id)}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="truncate text-sm font-semibold text-neutral-100">{title}</span>
          {trailing && (
            <span className="shrink-0 rounded-full bg-white/[0.04] px-2.5 py-1 text-[11px] text-neutral-600 shadow-[var(--shadow-border)]">
              {trailing}
            </span>
          )}
        </span>
        <span className="t-acc-chevron shrink-0 text-neutral-400">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 6.5L8 10.5L12 6.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      <div className="t-acc-panel">
        <div className="t-acc-panel-inner px-1 pb-3">
          {children}
        </div>
      </div>
    </section>
  );
}
