import { useRef, useState, useEffect } from "react";
import { getModelContextLimit, priceLabel, formatTokens } from "../modelFormatting.js";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { Search } from "lucide-react";
import { LOREBOOK_MODEL_INHERIT } from "./settingsDefaults.js";

export function ModelPicker({
  models,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  emptyMessage,
  note = null,
  inheritOption = null,
  disabled = false,
  activePage,
  searchWrapRef,
  searchInputRef,
}) {
  const listRef = useRef(null);
  const [listScrolled, setListScrolled] = useState(false);
  const [listHasMoreBelow, setListHasMoreBelow] = useState(false);

  function updateEdges(element) {
    const bottomOffset = element.scrollHeight - element.clientHeight - element.scrollTop;
    setListScrolled(element.scrollTop > 2);
    setListHasMoreBelow(bottomOffset > 2);
  }

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    requestAnimationFrame(() => updateEdges(list));
  }, [models.length, activePage]);

  function modelRowValues(model) {
    const contextLimit = getModelContextLimit(model);
    return {
      price: priceLabel(model) || "-",
      context: Number.isFinite(contextLimit) ? `${formatTokens(contextLimit)} context` : "—",
    };
  }

  function row({ key, name, subLabel, price, context, isSelected }) {
    return (
      <div
        key={key}
        className={cx(
          "grid min-h-[52px] grid-cols-[minmax(0,1fr)_104px] items-center rounded-lg px-1 py-2 transition-colors duration-150 ease-out",
          isSelected ? "bg-white/[0.035]" : "hover:bg-white/[0.02]",
          disabled && !isSelected && "opacity-45",
        )}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect(key)}
          className={cx(
            "min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
            CONTROL_MOTION,
            disabled && !isSelected && "cursor-not-allowed active:scale-100",
          )}
        >
          <span className="block truncate text-sm font-medium text-neutral-100">{name}</span>
          <span className="mt-0.5 block truncate text-xs text-neutral-600">{subLabel}</span>
        </button>
        <span className="flex min-w-0 flex-col items-center px-1 text-center text-xs leading-4 tabular-nums text-neutral-500">
          <span className="whitespace-nowrap">{price}</span>
          <span className="whitespace-nowrap">{context}</span>
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="pb-2.5">
        <div ref={searchWrapRef} className="t-input-wrap">
          <div
            ref={searchInputRef}
            className="t-input model-search-input flex h-10 items-center gap-2 rounded-xl bg-black/20 px-3 text-neutral-500 shadow-[var(--shadow-border)] transition-[background-color,box-shadow] duration-150 ease-out focus-within:bg-black/25 focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.16)]"
          >
            <Search size={15} />
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search models"
              data-1p-ignore="true"
              className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
            />
            <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] tabular-nums text-neutral-500">
              {models.length}
            </span>
          </div>
        </div>
        {note}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_104px] items-center px-1 pb-2 pt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-600">
        <span>Model</span>
        <span className="whitespace-nowrap text-center">Price + Context</span>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={(event) => updateEdges(event.currentTarget)}
          className="min-h-0 h-full overflow-y-auto"
        >
          {inheritOption && !query.trim() && row({
            key: LOREBOOK_MODEL_INHERIT,
            name: inheritOption.name,
            subLabel: inheritOption.subLabel,
            ...(inheritOption.model ? modelRowValues(inheritOption.model) : { price: "-", context: "-" }),
            isSelected: selectedId === LOREBOOK_MODEL_INHERIT,
          })}

          {models.length === 0 ? (
            <div className="mt-3 rounded-[18px] bg-black/15 p-4 text-pretty text-sm leading-6 text-neutral-500 shadow-[var(--shadow-border)]">
              {emptyMessage}
            </div>
          ) : (
            models.map((model) =>
              row({
                key: model.id,
                name: model.name,
                subLabel: model.id,
                ...modelRowValues(model),
                isSelected: model.id === selectedId,
              }),
            )
          )}
        </div>
        <div
          aria-hidden="true"
          className={cx(
            "settings-list-fade pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-[#202020]/95 to-transparent transition-opacity duration-150 ease-out",
            listScrolled ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          aria-hidden="true"
          className={cx(
            "settings-list-fade pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-[#202020]/95 to-transparent transition-opacity duration-150 ease-out",
            listHasMoreBelow ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
    </>
  );
}
