import { useState, useRef, useEffect } from "react";
import { X } from "lucide-react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { APP_VERSION } from "../appInfo.js";
import { MaskIcon } from "../components/IconButton.jsx";
import { SlidingTabs } from "../components/SlidingTabs.jsx";
import { CHAT_MODES } from "../settings/settingsDefaults.js";
import { FeedbackLink } from "./FeedbackLink.jsx";

const headerButtonClass = cx(
  "h-9 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
  CONTROL_MOTION,
);

function useRailEdges() {
  const [railScrolling, setRailScrolling] = useState(false);
  const [railScrolled, setRailScrolled] = useState(false);
  const [railHasMoreBelow, setRailHasMoreBelow] = useState(false);
  const railRef = useRef(null);
  const contentRef = useRef(null);
  const scrollTimeoutRef = useRef(null);

  function updateRailEdges(element) {
    const bottomOffset = element.scrollHeight - element.clientHeight - element.scrollTop;
    setRailScrolled(element.scrollTop > 2);
    setRailHasMoreBelow(bottomOffset > 2);
  }

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;

    const frameId = requestAnimationFrame(() => updateRailEdges(rail));
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => updateRailEdges(rail));
    resizeObserver?.observe(rail);
    if (contentRef.current) resizeObserver?.observe(contentRef.current);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
    };
  }, []);

  useEffect(
    () => () => {
      if (scrollTimeoutRef.current) {
        window.clearTimeout(scrollTimeoutRef.current);
      }
    },
    [],
  );

  function handleRailScroll(event) {
    updateRailEdges(event.currentTarget);
    setRailScrolling(true);
    window.clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = window.setTimeout(
      () => setRailScrolling(false),
      650,
    );
  }

  return {
    railRef,
    contentRef,
    railScrolling,
    railScrolled,
    railHasMoreBelow,
    handleRailScroll,
  };
}

export function SidebarShell({
  mode,
  previousChatMode,
  onChatModeChange,
  mobileOpen,
  onCloseMobile,
  collapsed,
  onCollapse,
  onSearch,
  searchLabel,
  closeLabel,
  collapseTourId,
  actions,
  listClassName,
  children,
}) {
  const {
    railRef,
    contentRef,
    railScrolling,
    railScrolled,
    railHasMoreBelow,
    handleRailScroll,
  } = useRailEdges();

  return (
    <>
      <div
        className={cx(
          "fixed inset-0 z-30 bg-black/55 opacity-0 backdrop-blur-sm transition-[opacity,backdrop-filter] duration-200 ease-out lg:hidden",
          mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none",
        )}
        onClick={onCloseMobile}
      />
      <aside
        className={cx(
          "chat-sidebar t-resize fixed inset-y-0 left-0 z-40 flex w-[292px] flex-col overflow-hidden border-r border-line bg-[#080808] lg:static lg:z-auto lg:translate-x-0",
          collapsed
            ? "lg:w-0 lg:-translate-x-3 lg:border-r-0 lg:border-transparent lg:opacity-0"
            : "lg:w-[276px] lg:opacity-100",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div
          className={cx(
            "chat-sidebar-content flex h-full w-[292px] flex-col px-3 pb-3 pt-3.5 lg:w-[276px]",
            collapsed
              ? "lg:-translate-x-8 lg:opacity-0"
              : "lg:translate-x-0 lg:opacity-100",
          )}
        >
          <div className="mb-3 flex h-9 items-center justify-between gap-2 pl-2.5">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-[17px] font-semibold tracking-[-0.02em] text-white">
                RouterChat
              </span>
              <span className="shrink-0 text-[17px] font-semibold tracking-[-0.02em] tabular-nums text-neutral-500">
                {APP_VERSION}
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                aria-label={searchLabel}
                title={searchLabel}
                onClick={onSearch}
                className={cx(headerButtonClass, "hidden lg:inline-flex")}
              >
                <MaskIcon src="/icons/search.png" size={17} />
              </button>
              <button
                type="button"
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                data-tour={collapseTourId}
                onClick={onCollapse}
                className={cx(headerButtonClass, "hidden lg:inline-flex")}
              >
                <MaskIcon src="/icons/sidebar.png" size={15} />
              </button>
              <button
                type="button"
                aria-label={closeLabel}
                title={closeLabel}
                onClick={onCloseMobile}
                className={cx(headerButtonClass, "inline-flex lg:hidden")}
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="mb-3 flex justify-center">
            <SlidingTabs
              options={CHAT_MODES}
              value={mode}
              fromValue={previousChatMode}
              onChange={onChatModeChange}
              getValue={(option) => option.value}
              getLabel={(option) => option.label}
              ariaLabel="Interaction mode"
              className="sidebar-mode-tabs"
            />
          </div>

          <div className="mb-3">
            {actions}
          </div>

          <div className="relative min-h-0 flex-1">
            <nav
              ref={railRef}
              onScroll={handleRailScroll}
              className={cx(
                "chat-rail-scrollbar h-full overflow-y-auto pr-1",
                railScrolling && "is-scrolling",
              )}
            >
              <div ref={contentRef} className={listClassName}>
                {children}
              </div>
            </nav>
            <div
              aria-hidden="true"
              className={cx(
                "sidebar-list-fade pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-[#080808]/95 to-transparent transition-opacity duration-150 ease-out",
                railScrolled ? "opacity-100" : "opacity-0",
              )}
            />
            <div
              aria-hidden="true"
              className={cx(
                "sidebar-list-fade pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-[#080808]/95 to-transparent transition-opacity duration-150 ease-out",
                railHasMoreBelow ? "opacity-100" : "opacity-0",
              )}
            />
          </div>

          <footer className="mt-2 border-t border-white/[0.06] pt-2">
            <FeedbackLink />
          </footer>
        </div>
      </aside>
    </>
  );
}
