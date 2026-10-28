import { useRef } from "react";
import { getModelContextLimit, priceLabel, formatTokens, modelDisplayName, modelMaker } from "../modelFormatting.js";
import { cx } from "../uiShared.js";
import { Search, X } from "lucide-react";
import { LOREBOOK_MODEL_INHERIT } from "./settingsDefaults.js";
import { ScrollEdgeBlur, useScrollEdges } from "../components/ScrollEdgeBlur.jsx";

const SKELETON_ROWS = [64, 48, 72, 56];

export function ModelPicker({
  models,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  emptyMessage,
  priceHeader = "Price",
  renderPrice = null,
  note = null,
  inheritOption = null,
  disabled = false,
  loading = false,
  activePage,
  searchWrapRef,
  searchInputRef,
  framed = false,
}) {
  const listRef = useRef(null);
  const queryInputRef = useRef(null);
  const showContext = !renderPrice;
  const columns = showContext ? "grid-cols-[minmax(0,1fr)_96px_64px]" : "grid-cols-[minmax(0,1fr)_136px]";
  const edges = useScrollEdges(listRef, [models.length, activePage, loading]);

  function modelRowValues(model) {
    const contextLimit = getModelContextLimit(model);
    return {
      price: priceLabel(model) || "-",
      context: Number.isFinite(contextLimit) ? formatTokens(contextLimit) : "-",
    };
  }

  function clearQuery() {
    onQueryChange("");
    queryInputRef.current?.focus();
  }

  function row({ key, name, subLabel, price, context, isSelected, model }) {
    return (
      <div
        key={key}
        className={cx(
          "model-picker-row relative grid min-h-[52px] items-center gap-3 rounded-xl px-3 py-2",
          columns,
          isSelected && "is-selected",
          disabled && !isSelected && "opacity-45",
        )}
      >
        <button
          type="button"
          disabled={disabled}
          aria-pressed={isSelected}
          onClick={() => onSelect(key)}
          className={cx(
            "model-picker-row-button min-w-0 text-left focus:outline-none",
            disabled && "cursor-not-allowed",
          )}
        >
          <span className="block truncate text-sm font-medium text-neutral-100">{name}</span>
          <span className="mt-0.5 block truncate text-xs text-[#8a8a8a]">{subLabel}</span>
        </button>
        <span className="pointer-events-none relative z-[1] min-w-0 whitespace-nowrap px-1 text-right text-xs tabular-nums text-neutral-400">
          {renderPrice && model ? <span className="pointer-events-auto">{renderPrice(model)}</span> : price}
        </span>
        {showContext && (
          <span className="pointer-events-none relative min-w-0 whitespace-nowrap px-1 text-right text-xs tabular-nums text-neutral-400">
            {context}
          </span>
        )}
      </div>
    );
  }

  function skeletonRows() {
    return SKELETON_ROWS.map((width, index) => (
      <div
        key={index}
        className={cx("grid min-h-[52px] items-center gap-3 px-3 py-2", columns)}
      >
        <span className="space-y-2">
          <i className="model-picker-skeleton block h-2.5" style={{ width: `${width}%` }} />
          <i className="model-picker-skeleton block h-2 w-16" />
        </span>
        <i className="model-picker-skeleton ml-auto block h-2.5 w-14" />
        {showContext && <i className="model-picker-skeleton ml-auto block h-2.5 w-9" />}
      </div>
    ));
  }

  return (
    <>
      <div className={framed ? "pb-4" : "pb-3"}>
        <div ref={searchWrapRef} className="t-input-wrap">
          <div
            ref={searchInputRef}
            className="t-input model-search-input flex h-10 items-center gap-2 rounded-full bg-white/[0.045] pl-4 pr-1.5 text-neutral-500 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] transition-[background-color,box-shadow] duration-150 ease-out focus-within:bg-white/[0.06] focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]"
          >
            <Search size={15} aria-hidden="true" />
            <input
              ref={queryInputRef}
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  onQueryChange("");
                }
              }}
              placeholder="Search models"
              data-1p-ignore="true"
              className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
            />
            <button
              type="button"
              onClick={clearQuery}
              aria-label="Clear search"
              tabIndex={query ? 0 : -1}
              className={cx("model-search-clear", query && "is-visible")}
            >
              <X size={13} strokeWidth={2.2} aria-hidden="true" />
            </button>
            <span className="w-11 shrink-0 rounded-full bg-white/[0.05] py-0.5 text-center text-[11px] tabular-nums text-neutral-500">
              {loading ? "-" : models.length}
            </span>
          </div>
        </div>
        {note}
      </div>

      <div className={cx("flex min-h-0 flex-1 flex-col", framed && "settings-picker-frame")}>
        <div className={cx("grid items-center gap-3 px-3 pb-2 pt-1 text-xs font-medium text-neutral-500", columns)}>
          <span>Model</span>
          <span className="whitespace-nowrap px-1 text-right">{priceHeader}</span>
          {showContext && <span className="whitespace-nowrap px-1 text-right">Context</span>}
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            ref={listRef}
            className="settings-thin-scroll h-full min-h-0 space-y-0.5 overflow-y-auto"
          >
            {loading ? skeletonRows() : (
              <>
                {inheritOption && !query.trim() && row({
                  key: LOREBOOK_MODEL_INHERIT,
                  name: inheritOption.name,
                  subLabel: inheritOption.subLabel,
                  ...(inheritOption.model ? modelRowValues(inheritOption.model) : { price: "-", context: "-" }),
                  isSelected: selectedId === LOREBOOK_MODEL_INHERIT,
                })}

                {models.length === 0 ? (
                  <div className="mt-2 rounded-2xl bg-[#141414] p-4 text-pretty text-sm leading-6 text-neutral-400 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                    {emptyMessage}
                  </div>
                ) : (
                  models.map((model) =>
                    row({
                      model,
                      key: model.id,
                      name: modelDisplayName(model),
                      subLabel: modelMaker(model),
                      ...modelRowValues(model),
                      isSelected: model.id === selectedId,
                    }),
                  )
                )}
              </>
            )}
          </div>
          <ScrollEdgeBlur edge="top" visible={edges.top} size={40} />
          <ScrollEdgeBlur edge="bottom" visible={edges.bottom} size={44} />
        </div>
      </div>
    </>
  );
}
