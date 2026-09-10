import { useEffect, useState } from "react";
import { api } from "../api.js";
import "./UsagePanel.css";

const chartColors = ["#c59af5", "#e5ae78", "#7dc7ba", "#e68eb0", "#aebad1", "#b9c984"];
const tokenSeries = [
  { id: "promptTokens", name: "Prompt", color: "#aebad1" },
  { id: "outputTokens", name: "Completion", color: "#c59af5" },
  { id: "reasoningTokens", name: "Reasoning", color: "#e68eb0" },
];

export function formatUsage(value, money = false) {
  if (value == null) return "Unavailable";
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

function UsageMetric({ metric, usage }) {
  const [activeIndex, setActiveIndex] = useState(null);
  const days = usage.days;
  const maxValue = Math.max(...days.map((day) => day[metric.key] || 0), 0.000001);
  const points = days.map((day, index) => ({
    x: 4 + index / Math.max(days.length - 1, 1) * 88,
    y: 30 - (day[metric.key] || 0) / maxValue * 26,
  }));
  const activeDay = activeIndex == null ? null : days[activeIndex];
  const activePoint = activeIndex == null ? null : points[activeIndex];

  function selectDay(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = ((event.clientX - bounds.left) / bounds.width * 96 - 4) / 88;
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
    <section className="usage-metric" aria-label={metric.label}>
      <h3>{metric.label}</h3>
      <div className="usage-metric-value">
        <strong>
          {formatUsage(activeDay ? activeDay[metric.key] : usage.current[metric.key], metric.money)}
        </strong>
        <svg
          className="usage-sparkline"
          viewBox="0 0 96 34"
          role="slider"
          tabIndex={0}
          aria-label={`${metric.label} by day`}
          aria-valuemin={0}
          aria-valuemax={days.length - 1}
          aria-valuenow={activeIndex ?? days.length - 1}
          aria-valuetext={`${dateLabel((activeDay || days.at(-1)).date)}: ${formatUsage((activeDay || days.at(-1))[metric.key], metric.money)}`}
          onPointerMove={selectDay}
          onPointerDown={selectDay}
          onPointerLeave={() => setActiveIndex(null)}
          onFocus={() => setActiveIndex(days.length - 1)}
          onBlur={() => setActiveIndex(null)}
          onKeyDown={navigateDays}
        >
          <polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} />
          {activePoint && (
            <g className="usage-sparkline-marker" style={{ transform: `translateX(${activePoint.x}px)` }}>
              <line x1={0} x2={0} y1={0} y2={34} />
              <circle cx={0} cy={0} r={3} style={{ transform: `translateY(${activePoint.y}px)` }} />
            </g>
          )}
        </svg>
      </div>
      <p>
        {activeDay ? dateLabel(activeDay.date) : comparison(usage.current[metric.key], usage.previous[metric.key])}
      </p>
    </section>
  );
}

function UsageChart({ title, days, series, getValue, money = false }) {
  const maxValue = Math.max(...days.map((day) => series.reduce((sum, item) => sum + getValue(day, item), 0)), 0);
  return (
    <section className="usage-chart-card" aria-label={title}>
      <div className="usage-section-heading">
        <h3>{title}</h3>
        <span>{money ? "USD" : "Tokens"}</span>
      </div>
      <div className="usage-chart">
        <div className="usage-axis">
          <span>{formatUsage(maxValue, money)}</span>
          <span>{formatUsage(maxValue / 2, money)}</span>
          <span>0</span>
        </div>
        <div className="usage-plot">
          <div className="usage-grid-lines" aria-hidden="true">
            <i /><i /><i />
          </div>
          {days.map((day) => (
            <div className="usage-day" key={day.date}>
              <div className="usage-bar" tabIndex={0} aria-label={`${day.date}: ${series.map((item) => `${item.name} ${formatUsage(getValue(day, item), money)}`).join(", ")}`}>
                {series.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      height: `${maxValue ? getValue(day, item) / maxValue * 100 : 0}%`,
                      background: item.color,
                    }}
                  />
                ))}
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
              </div>
              <span className="usage-day-label">{dayLabel(day.date)}</span>
            </div>
          ))}
          {!maxValue && <span className="usage-chart-empty">No recorded {money ? "spend" : "tokens"} this week</span>}
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

export function UsagePanel({ models }) {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setUsage(null);
    api(`/api/usage?offsetMinutes=${new Date().getTimezoneOffset()}`, { signal: controller.signal })
      .then(setUsage)
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError.message || "Usage could not be loaded.");
      });
    return () => controller.abort();
  }, [retryKey]);

  if (error) return (
    <div className="usage-state" role="alert">
      <p>Usage could not be loaded.</p>
      <button onClick={() => setRetryKey((value) => value + 1)}>Try again</button>
    </div>
  );
  if (!usage) return <div className="usage-state" role="status">Loading usage…</div>;

  const modelSeries = usage.models.map((item, index) => ({
    ...item,
    name: models.find((model) => model.id === item.id)?.name
      || (item.id === "unknown" ? "Unrecorded model" : item.id.split("/").at(-1)),
    color: chartColors[index % chartColors.length],
  }));
  const topModels = modelSeries.slice(0, 5);
  const chartSeries = modelSeries.length > 5 ? [...topModels, { id: "other", name: "Other", color: chartColors[5] }] : topModels;
  const getModelSpend = (day, item) => item.id === "other" ? modelSeries.slice(5).reduce((sum, model) => sum + (day.models[model.id] || 0), 0) : day.models[item.id] || 0;
  const metrics = [
    { key: "cost", label: "Total spend", money: true },
    { key: "requests", label: "Requests" },
    { key: "totalTokens", label: "Token volume" },
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
      <UsageChart title="Usage by model" days={usage.days} series={chartSeries} getValue={getModelSpend} money />
      <UsageChart title="Token breakdown" days={usage.days} series={tokenSeries} getValue={(day, item) => day[item.id]} />
      <section className="usage-models" aria-label="Model totals">
        <div className="usage-section-heading">
          <h3>Model totals</h3>
          <span>This week</span>
        </div>
        {modelSeries.length ? (
          <div className="usage-table-wrap">
            <table>
              <thead>
                <tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Spend</th></tr>
              </thead>
              <tbody>
                {modelSeries.map((model) => (
                  <tr key={model.id}>
                    <td><i style={{ background: model.color }} />{model.name}</td>
                    <td>{formatUsage(model.requests)}</td>
                    <td>{formatUsage(model.totalTokens)}</td>
                    <td>{formatUsage(model.cost, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="usage-muted">Your model usage will appear here.</p>}
      </section>
      <p className="usage-note">Saved RouterChat history only, including imported history. Deleted history and requests without saved usage are not included. All amounts are USD.</p>
    </div>
  );
}
