import { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { X } from "lucide-react";

export function SidebarSearchModal({
  open,
  items,
  onSelect,
  onClose,
  label = "Search chats",
  emptyText = "Your conversations will appear here.",
  noMatchText = "No chats match that search.",
  fallbackTitle = "Untitled chat",
}) {
  const [rendered, setRendered] = useState(open);
  const [phase, setPhase] = useState(open ? "open" : "closed");
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setPhase("open");
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
      return undefined;
    }

    if (!rendered) return undefined;

    setPhase("closing");
    const closeMs =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--modal-close-dur"),
      ) || 150;
    const timeoutId = window.setTimeout(() => {
      setRendered(false);
      setPhase("closed");
    }, closeMs);
    return () => window.clearTimeout(timeoutId);
  }, [open, rendered]);

  useEffect(() => {
    if (!rendered) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, rendered]);

  const recentItems = useMemo(() => {
    const sorted = [...items].sort((first, second) => {
      const firstTime = Date.parse(first.updated_at || first.created_at || "") || 0;
      const secondTime = Date.parse(second.updated_at || second.created_at || "") || 0;
      return secondTime - firstTime;
    });

    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return sorted;

    return sorted.filter((item) => (item.title || "").toLowerCase().includes(trimmed));
  }, [items, query]);

  if (!rendered) return null;

  const isOpen = phase === "open";

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center px-4 py-6">
      <button
        type="button"
        aria-label="Close search"
        className={cx(
          "absolute inset-0 bg-black/60 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-150 ease-out",
          isOpen ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cx(
          "t-modal relative z-10 flex max-h-[min(620px,calc(100dvh-3rem))] w-full max-w-[560px] flex-col overflow-hidden rounded-[26px] bg-[#191919] text-neutral-100 [box-shadow:var(--shadow-surface)]",
          isOpen ? "is-open" : "is-closing",
        )}
      >
        <header className="flex shrink-0 items-center gap-4 px-6 pb-2 pt-5">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search..."
            data-1p-ignore="true"
            className="min-w-0 flex-1 bg-transparent text-[19px] font-normal leading-7 text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
          />
          <button
            type="button"
            aria-label="Close search"
            title="Close search"
            onClick={onClose}
            className={cx(
              "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
              CONTROL_MOTION,
            )}
          >
            <X size={20} />
          </button>
        </header>

        <div className="chat-rail-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2">
          {recentItems.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[15px] leading-6 text-neutral-500">
              {query.trim() ? "Results" : "Last opened"}
            </div>
          )}

          {recentItems.length === 0 ? (
            <div className="px-3 py-6 text-sm leading-6 text-neutral-500">
              {query.trim() ? noMatchText : emptyText}
            </div>
          ) : (
            <div className="space-y-0.5">
              {recentItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className={cx(
                    "flex w-full items-center rounded-xl px-3 py-2.5 text-left text-[15px] leading-6 text-neutral-100 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                    CONTROL_MOTION,
                  )}
                >
                  <span className="truncate">{item.title || fallbackTitle}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
