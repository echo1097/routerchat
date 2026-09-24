import { useEffect, useState } from "react";
import { api } from "../api.js";
import { cx } from "../uiShared.js";
import "./UsagePanel.css";

const chartColors = ["#c59af5", "#e5ae78", "#7dc7ba", "#e68eb0", "#aebad1", "#b9c984"];
const tokenSeries = [
  { id: "promptTokens", name: "Prompt", color: "#aebad1" },
  { id: "outputTokens", name: "Completion", color: "#c59af5" },
  { id: "reasoningTokens", name: "Reasoning", color: "#e68eb0" },
];

export function formatUsage(value, money = false, partial = false) {
  if (value == null) return "Unavailable";
  if (partial) return `${formatUsage(value, money)} (partial)`;
  if (money) return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function dayLabel(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
}

function dateLabel(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function comparison(value, previous) {
  if (value == null || previous == null) return "No comparison available";
  if (previous === 0) return value === 0 ? "No change from last week" : "No usage last week";
  const change = ((value - previous) / previous) * 100;
  if (Math.abs(change) < 0.05) return "No change from last week";
  return `${change > 0 ? "↑" : "↓"} ${Math.abs(change).toFixed(1)}% vs last week`;
}

const sparkWidth = 240;
const sparkHeight = 48;
const sparkPad = 8;

function niceCeiling(value) {
  if (!(value > 0)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const step = [1, 2, 2.5, 5, 10].find((candidate) => fraction <= candidate);
  return step * magnitude;
}

function UsageMetric({ metric, usage }) {
  const [activeIndex, setActiveIndex] = useState(null);
  const days = usage.days;
  const maxValue = Math.max(...days.map((day) => day[metric.key] || 0), 0.000001);
  const plotWidth = sparkWidth - sparkPad * 2;
  const points = days.map((day, index) => ({
    x: sparkPad + index / Math.max(days.length - 1, 1) * plotWidth,
    y: sparkHeight - 3 - (day[metric.key] || 0) / maxValue * (sparkHeight - 12),
  }));
  const segments = [[]];
  points.forEach((point, index) => {
    if (days[index][metric.key] == null) segments.push([]);
    else segments.at(-1).push(point);
  });
  const drawnSegments = segments.filter((segment) => segment.length > 1);
  const activeDay = activeIndex == null ? null : days[activeIndex];
  const activePoint = activeIndex == null ? null : points[activeIndex];
  const selectedTotals = activeDay || usage.current;
  const partialComparison = usage.current[metric.partialKey] || usage.previous[metric.partialKey];

  function selectDay(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = ((event.clientX - bounds.left) / bounds.width * sparkWidth - sparkPad) / plotWidth;
    setActiveIndex(Math.max(0, Math.min(days.length - 1, Math.round(position * (days.length - 1)))));
  }

  function navigateDays(event) {
    const index = activeIndex ?? days.length - 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      setActiveIndex(Math.max(0, index - 1));
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      setActiveIndex(Math.min(days.length - 1, index + 1));
    } else if (event.key === "Home") {
      setActiveIndex(0);
    } else if (event.key === "End") {
      setActiveIndex(days.length - 1);
    } else {
      return;
    }
    event.preventDefault();
  }

  return (
    <section className={cx("usage-metric", activeDay && "is-inspecting")} aria-label={metric.label}>
      <h3>{metric.label}</h3>
      <strong>{formatUsage(selectedTotals[metric.key], metric.money)}</strong>
      <p>
        {activeDay ? dateLabel(activeDay.date) : partialComparison ? "No comparison available" : comparison(usage.current[metric.key], usage.previous[metric.key])}
      </p>
      <svg
        className="usage-sparkline"
        viewBox={`0 0 ${sparkWidth} ${sparkHeight}`}
        role="slider"
        tabIndex={0}
        aria-label={`${metric.label} by day`}
        aria-valuemin={0}
        aria-valuemax={days.length - 1}
        aria-valuenow={activeIndex ?? days.length - 1}
        aria-valuetext={`${dateLabel((activeDay || days.at(-1)).date)}: ${formatUsage((activeDay || days.at(-1))[metric.key], metric.money, (activeDay || days.at(-1))[metric.partialKey])}`}
        onPointerMove={selectDay}
        onPointerDown={selectDay}
        onPointerLeave={() => setActiveIndex(null)}
        onFocus={() => setActiveIndex(days.length - 1)}
        onBlur={() => setActiveIndex(null)}
        onKeyDown={navigateDays}
      >
        {drawnSegments.map((segment, index) => (
          <polyline key={index} points={segment.map((point) => `${point.x},${point.y}`).join(" ")} />
        ))}
        {activePoint && (
          <g className="usage-sparkline-marker" style={{ transform: `translateX(${activePoint.x}px)` }}>
            <line x1={0} x2={0} y1={0} y2={sparkHeight} />
            {activeDay[metric.key] != null && <circle cx={0} cy={0} r={3.5} style={{ transform: `translateY(${activePoint.y}px)` }} />}
          </g>
        )}
      </svg>
    </section>
  );
}

function UsageChart({ title, days, series, getValue, money = false }) {
  const maxValue = Math.max(...days.map((day) => series.reduce((sum, item) => sum + getValue(day, item), 0)), 0);
  const scaleMax = niceCeiling(maxValue);
  return (
    <section className="usage-chart-card" aria-label={title}>
      <div className="usage-section-heading">
        <h3>{title}</h3>
      </div>
      <div className="usage-chart">
        <div className="usage-axis">
          <span>{scaleMax ? formatUsage(scaleMax, money) : ""}</span>
          <span>{scaleMax ? formatUsage(scaleMax / 2, money) : ""}</span>
          <span>0</span>
        </div>
        <div className="usage-plot">
          <div className="usage-grid-lines" aria-hidden="true">
            <i /><i /><i />
          </div>
          {days.map((day, dayIndex) => {
            const dayTotal = series.reduce((sum, item) => sum + (getValue(day, item) || 0), 0);
            return (
              <div className="usage-day" key={day.date}>
                <div className="usage-bar" tabIndex={0} aria-label={`${day.date}: ${series.map((item) => `${item.name} ${formatUsage(getValue(day, item), money)}`).join(", ")}`}>
                  <div
                    className={cx("usage-stack", dayTotal > 0 && "has-value")}
                    style={{
                      height: `${scaleMax ? dayTotal / scaleMax * 100 : 0}%`,
                      "--day-index": dayIndex,
                    }}
                  >
                    {series.map((item) => (
                      <div
                        key={item.id}
                        style={{
                          height: `${dayTotal ? (getValue(day, item) || 0) / dayTotal * 100 : 0}%`,
                          background: item.color,
                        }}
                      />
                    ))}
                  </div>
                </div>
                <div className="usage-tooltip usage-detail-tooltip">
                  <strong className="usage-tooltip-date">
                    {new Date(`${day.date}T12:00:00`).toLocaleDateString("en-US", {
                      month: "long", day: "numeric", year: "numeric",
                    })}
                  </strong>
                  <div className="usage-tooltip-details">
                    {series.map((item) => (
                      <div className="usage-tooltip-row" key={item.id}>
                        <i style={{ background: item.color }} />
                        <span>{item.name}</span>
                        <span className="usage-tooltip-value">{formatUsage(getValue(day, item), money)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <span className="usage-day-label">{dayLabel(day.date)}</span>
              </div>
            );
          })}
          {!maxValue && <span className="usage-chart-empty">{days.some((day) => series.some((item) => getValue(day, item) === null)) ? "Usage details unavailable" : `No recorded ${money ? "spend" : "tokens"} this week`}</span>}
        </div>
      </div>
      <div className="usage-legend">
        {series.map((item) => (
          <span key={item.id}><i style={{ background: item.color }} />{item.name}</span>
        ))}
      </div>
    </section>
  );
}

function UsageSkeleton() {
  return (
    <div className="usage-panel usage-skeleton" role="status">
      <span className="usage-visually-hidden">Loading usage…</span>
      <div className="usage-period" aria-hidden="true">
        <i className="usage-skeleton-line is-title" />
        <i className="usage-skeleton-line is-short" />
      </div>
      <div className="usage-summary" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div className="usage-metric" key={index}>
            <i className="usage-skeleton-line is-label" />
            <i className="usage-skeleton-line is-value" />
            <i className="usage-skeleton-line is-note" />
          </div>
        ))}
      </div>
      <div className="usage-charts" aria-hidden="true">
        {[0, 1].map((chart) => (
          <div className="usage-chart-card" key={chart}>
            <i className="usage-skeleton-line is-label" />
            <div className="usage-skeleton-bars">
              {[46, 72, 30, 90, 58, 22, 66].map((height, index) => (
                <i key={index} style={{ height: `${height}%` }} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function UsagePanel({ models }) {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setUsage(null);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const query = new URLSearchParams({ offsetMinutes: String(new Date().getTimezoneOffset()), timeZone });
    api(`/api/usage?${query}`, { signal: controller.signal })
      .then(setUsage)
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError.message || "Usage could not be loaded.");
      });
    return () => controller.abort();
  }, [retryKey]);

  if (error) return (
    <div className="usage-state" role="alert">
      <p>Usage could not be loaded.</p>
      <button type="button" onClick={() => setRetryKey((value) => value + 1)}>Try again</button>
    </div>
  );
  if (!usage) return <UsageSkeleton />;

  const modelSeries = usage.models.map((item, index) => ({
    ...item,
    name: item.name || models.find((model) => model.id === item.id)?.name
      || (item.id === "unknown" ? "Unrecorded model" : item.id.split("/").at(-1)),
    color: chartColors[index % chartColors.length],
  }));
  const lifetimeModels = (usage.lifetimeModels || []).map((item, index) => ({
    ...item,
    name: item.name || models.find((model) => model.id === item.id)?.name
      || (item.id === "unknown" ? "Unrecorded model" : item.id.split("/").at(-1)),
    color: modelSeries.find((model) => model.id === item.id)?.color || chartColors[index % chartColors.length],
  }));
  const topModels = modelSeries.slice(0, 5);
  const chartSeries = modelSeries.length > 5 ? [...topModels, { id: "other", name: "Other", color: chartColors[5] }] : topModels;
  const getModelSpend = (day, item) => {
    const modelIds = item.id === "other" ? modelSeries.slice(5).map((model) => model.id) : [item.id];
    const values = modelIds.map((modelId) => day.models[modelId]);
    return values.some((value) => value === null) ? null : values.reduce((sum, value) => sum + (value || 0), 0);
  };
  const metrics = [
    { key: "cost", label: "Total spend", money: true, partialKey: "partialCost" },
    { key: "requests", label: "Requests" },
    { key: "totalTokens", label: "Token volume", partialKey: "partialTokens" },
  ];
  const dateRange = `${dateLabel(usage.startDate)} – ${dateLabel(usage.endDate)}`;

  return (
    <div className="usage-panel">
      <div className="usage-period">
        <span>Last 7 days</span>
        <span>{dateRange}</span>
      </div>
      <div className="usage-summary">
        {metrics.map((metric) => (
          <UsageMetric key={metric.key} metric={metric} usage={usage} />
        ))}
      </div>
      <div className="usage-charts">
        <UsageChart title="Usage by model" days={usage.days} series={chartSeries} getValue={getModelSpend} money />
        <UsageChart title="Token breakdown" days={usage.days} series={tokenSeries} getValue={(day, item) => day[item.id]} />
      </div>
      <section className="usage-models" aria-label="Lifetime model totals">
        <div className="usage-section-heading">
          <h3>Lifetime model totals</h3>
        </div>
        {lifetimeModels.length ? (
          <div className="usage-table-wrap">
            <table>
              <thead>
                <tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Spend</th></tr>
              </thead>
              <tbody>
                {lifetimeModels.map((model) => (
                  <tr key={model.id}>
                    <td>
                      <span className="usage-model-name"><i style={{ background: model.color }} /><span>{model.name}</span></span>
                    </td>
                    <td>{formatUsage(model.requests)}</td>
                    <td>{formatUsage(model.totalTokens, false, model.partialTokens)}</td>
                    <td>{formatUsage(model.cost, true, model.partialCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="usage-muted">Your model usage will appear here.</p>}
      </section>
      <p className="usage-note">Saved RouterChat history and transcription usage, including imported history. Partial totals include recorded usage only; some requests are missing usage details. Deleted history and requests without saved usage are not included. All amounts are USD.</p>
    </div>
  );
}
