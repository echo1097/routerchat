import { cx } from "../uiShared.js";

function SettingsPageTitle({ evenSpacing = false, children }) {
  return (
    <h1
      className={cx(
        "settings-page-title shrink-0 text-[24px] font-semibold leading-tight tracking-[-0.015em] text-neutral-50",
        evenSpacing ? "mb-4" : "mb-7",
      )}
    >
      {children}
    </h1>
  );
}


export function SettingsScrollPage({ pageId, title, label, className, children }) {
  return (
    <section
      className={cx("settings-scroll-page t-page overflow-y-auto", className)}
      data-page-id={pageId}
      aria-label={label}
    >
      <div className="settings-inline settings-page-body">
        <SettingsPageTitle>{title}</SettingsPageTitle>
        {children}
      </div>
    </section>
  );
}


export function SettingsFixedPage({ pageId, title, label, evenSpacing = false, children }) {
  return (
    <section
      className="t-page flex min-h-0 flex-col overflow-hidden"
      data-page-id={pageId}
      aria-label={label}
    >
      <div className="settings-inline settings-page-body flex min-h-0 flex-1 flex-col">
        <SettingsPageTitle evenSpacing={evenSpacing}>{title}</SettingsPageTitle>
        {children}
      </div>
    </section>
  );
}
