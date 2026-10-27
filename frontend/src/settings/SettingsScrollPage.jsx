import { useRef } from "react";
import { cx } from "../uiShared.js";
import { ScrollEdgeBlur, useScrollEdges } from "../components/ScrollEdgeBlur.jsx";

export function SettingsScrollPage({ pageId, label, active, className, children }) {
  const scrollRef = useRef(null);
  const edges = useScrollEdges(scrollRef, [active]);

  return (
    <section
      ref={scrollRef}
      className={cx("settings-scroll-page t-page overflow-y-auto", className)}
      data-page-id={pageId}
      aria-label={label}
    >
      <div className="settings-scroll-edge is-top">
        <ScrollEdgeBlur edge="top" visible={edges.top} size={40} />
      </div>
      <div className="settings-inline py-5 md:py-6">
        {children}
      </div>
      <div className="settings-scroll-edge is-bottom">
        <ScrollEdgeBlur edge="bottom" visible={edges.bottom} size={56} />
      </div>
    </section>
  );
}

export function SettingsFixedPage({ pageId, label, children }) {
  return (
    <section
      className="t-page flex min-h-0 flex-col overflow-hidden"
      data-page-id={pageId}
      aria-label={label}
    >
      <div className="settings-inline flex min-h-0 flex-1 flex-col py-5 md:py-6">
        {children}
      </div>
    </section>
  );
}
