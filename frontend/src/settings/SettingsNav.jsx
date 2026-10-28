import { ArrowLeft } from "lucide-react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { MaskIcon } from "../components/IconButton.jsx";
import { SearchClearField } from "../components/SearchClearField.jsx";
import { groupPages } from "./settingsPages.js";

const navRowClass = cx(
  "flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/20",
  CONTROL_MOTION,
);


export function SettingsNavToggle({ label, onClick, className }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx(
        "grid h-9 w-9 shrink-0 place-items-center rounded-lg text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
        CONTROL_MOTION,
        className,
      )}
    >
      <MaskIcon src="/icons/sidebar.png" size={15} />
    </button>
  );
}


function SearchResults({ results, onSelect }) {
  if (results.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-pretty text-[13px] leading-5 text-[#8a8a8a]">
        No settings match that search.
      </p>
    );
  }

  return (
    <ul aria-label="Matching settings" className="space-y-0.5">
      {results.map((result) => (
        <li key={`${result.page}-${result.title}`}>
          <button
            type="button"
            onClick={() => onSelect(result)}
            className={cx(navRowClass, "h-auto min-h-11 flex-col items-start justify-center gap-0 py-2 text-neutral-200 hover:bg-white/[0.06] hover:text-white")}
          >
            <span className="block w-full truncate">{result.title}</span>
            <span className="block w-full truncate text-[12px] font-normal text-[#8a8a8a]">{result.pageLabel}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}


export function SettingsNav({
  pages,
  activePage,
  warnings = {},
  query,
  onQueryChange,
  results,
  onSelectPage,
  onSelectResult,
  onBack,
  onCollapse,
  onCloseMobile,
}) {
  const searching = query.trim().length > 0;

  return (
    <div className="flex h-full w-[264px] flex-col px-3 pb-3 pt-3.5">
      <div className="flex h-9 items-center justify-between">
        <SettingsNavToggle label="Collapse settings menu" onClick={onCollapse} className="hidden lg:grid" />
        <SettingsNavToggle label="Close settings menu" onClick={onCloseMobile} className="lg:hidden" />
      </div>

      <button
        type="button"
        onClick={onBack}
        className={cx(navRowClass, "mt-5 text-neutral-200 hover:bg-white/[0.06] hover:text-white")}
      >
        <ArrowLeft size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        Back to app
      </button>

      <div className="mt-3">
        <SearchClearField value={query} onChange={onQueryChange} placeholder="Search settings" />
      </div>

      <nav aria-label="Settings sections" className="settings-thin-scroll -mx-3 mt-4 min-h-0 flex-1 overflow-y-auto px-3">
        {searching ? (
          <SearchResults results={results} onSelect={onSelectResult} />
        ) : (
          <div className="space-y-5">
            {groupPages(pages).map((group) => (
              <div key={group.label}>
                <h2 className="mb-1 px-3 text-[13px] font-medium text-[#8a8a8a]">{group.label}</h2>
                <ul className="space-y-0.5">
                  {group.pages.map((page) => {
                    const Icon = page.icon;
                    const active = page.id === activePage;
                    const warning = warnings[page.id];

                    return (
                      <li key={page.id}>
                        <button
                          type="button"
                          aria-current={active ? "page" : undefined}
                          onClick={() => onSelectPage(page.id)}
                          className={cx(
                            navRowClass,
                            active
                              ? "bg-white/[0.08] text-white"
                              : "text-neutral-300 hover:bg-white/[0.05] hover:text-white",
                          )}
                        >
                          <Icon size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{page.label}</span>
                          {warning && (
                            <span className="settings-nav-warning" title={warning}>
                              <span className="sr-only">{warning}</span>
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </nav>
    </div>
  );
}
