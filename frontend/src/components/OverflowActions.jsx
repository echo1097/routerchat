import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { cx, CONTROL_MOTION } from "../uiShared.js";

export function OverflowActions({
  id,
  title,
  label,
  isFirst = false,
  forceVisible = false,
  menuWidth = 156,
  children,
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [menuStyle, setMenuStyle] = useState({});
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const closeTimerRef = useRef(null);
  const menuId = `${id}-actions`;

  function updateMenuPosition() {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - menuWidth - 12);

    setMenuStyle({
      left: `${Math.max(12, left)}px`,
      top: `${rect.bottom + 6}px`,
    });
  }

  function clearCloseTimer() {
    if (!closeTimerRef.current) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }

  function closeMenu() {
    if (!open) return;
    clearCloseTimer();
    setOpen(false);
    setClosing(true);
    const closeMs = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--dropdown-close-dur"),
    ) || 150;
    closeTimerRef.current = window.setTimeout(() => {
      setClosing(false);
      closeTimerRef.current = null;
    }, closeMs);
  }

  function toggleMenu(event) {
    event.stopPropagation();
    if (open) {
      closeMenu();
      return;
    }
    clearCloseTimer();
    setClosing(false);
    updateMenuPosition();
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (rootRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      closeMenu();
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") closeMenu();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open]);

  useEffect(() => () => clearCloseTimer(), []);

  const menu = (open || closing) && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          data-origin="top-left"
          style={menuStyle}
          className={cx(
            "t-dropdown chat-history-menu",
            open && "is-open",
            closing && "is-closing",
          )}
        >
          {children(closeMenu)}
        </div>,
        document.body,
      )
    : null;

  return (
    <div
      ref={rootRef}
      className={cx(
        "chat-history-actions relative flex",

        forceVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
      )}
    >
      <button
        ref={buttonRef}
        type="button"
        title={label}
        data-tour={isFirst ? "chat-actions-button" : undefined}
        aria-label={`${label} for ${title}`}
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="menu"
        onClick={toggleMenu}
        className={cx(
          "chat-history-menu-button grid h-7 w-7 place-items-center rounded-full bg-transparent text-neutral-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15",
          CONTROL_MOTION,
          open
            ? "text-neutral-200"
            : "hover:text-neutral-200",
        )}
      >
        <i className="fi fi-bs-menu-dots" aria-hidden="true" />
      </button>
      {menu}
    </div>
  );
}
