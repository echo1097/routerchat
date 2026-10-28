import { cx } from "../uiShared.js";

function SettingsPageTitle({ children }) {
  return (
    <h1 className="settings-page-title mb-7 shrink-0 text-[24px] font-semibold leading-tight tracking-[-0.015em] text-neutral-50">
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
