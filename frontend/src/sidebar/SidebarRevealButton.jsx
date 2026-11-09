import { useState } from "react";
import { cx } from "../uiShared.js";
import { PanelLeftOpen } from "lucide-react";

export function SidebarRevealButton({ visible, onClick }) {
  const [nearEdge, setNearEdge] = useState(false);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-y-0 left-0 z-50 hidden w-16 lg:block"
      onMouseEnter={() => setNearEdge(true)}
      onMouseLeave={() => setNearEdge(false)}
    >
      <button
        type="button"
        aria-label="Expand sidebar"
        title="Expand sidebar"
        onClick={onClick}
        onFocus={() => setNearEdge(true)}
        onBlur={() => setNearEdge(false)}
        className={cx(
          "sidebar-reveal-button absolute left-3 top-3.5 inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
          nearEdge
            ? "translate-x-0 opacity-100"
            : "-translate-x-2 opacity-0 focus-visible:translate-x-0 focus-visible:opacity-100",
        )}
      >
        <PanelLeftOpen size={18} />
      </button>
    </div>
  );
}
