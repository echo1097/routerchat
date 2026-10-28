import { useRef } from "react";
import { cx } from "../uiShared.js";
import { ScrollEdgeBlur, useScrollEdges } from "../components/ScrollEdgeBlur.jsx";

function SettingsPageTitle({ children }) {
  return (
    <h1 className="settings-page-title mb-7 shrink-0 text-[24px] font-semibold leading-tight tracking-[-0.015em] text-neutral-50">
      {children}
    </h1>
  );
}


export function SettingsScrollPage({ pageId, title, label, active, className, children }) {
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
      <div className="settings-inline settings-page-body">
        <SettingsPageTitle>{title}</SettingsPageTitle>
        {children}
      </div>
      <div className="settings-scroll-edge is-bottom">
        <ScrollEdgeBlur edge="bottom" visible={edges.bottom} size={56} />
      </div>
    </section>
  );
}


export function SettingsFixedPage({ pageId, title, label, children }) {
  return (
    <section
      className="t-page flex min-h-0 flex-col overflow-hidden"
      data-page-id={pageId}
      aria-label={label}
    >
      <div className="settings-inline settings-page-body flex min-h-0 flex-1 flex-col">
        <SettingsPageTitle>{title}</SettingsPageTitle>
        {children}
      </div>
    </section>
  );
}
