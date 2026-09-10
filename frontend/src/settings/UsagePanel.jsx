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

function comparison(value, previous, money) {
  if (value == null || previous == null) return "No comparison available";
  if (previous === 0) return value === 0 ? "No change from last week" : "No usage last week";
  const change = ((value - previous) / previous) * 100;
  if (Math.abs(change) < 0.05) return "No change from last week";
  return `${change > 0 ? "↑" : "↓"} ${Math.abs(change).toFixed(1)}% vs last week`;
}

function Sparkline({ values }) {
  const maxValue = Math.max(...values, 0.000001);
  const points = values.map((value, index) => `${index * 16},${30 - value / maxValue * 26}`).join(" ");
  return <svg className="usage-sparkline" viewBox="0 0 96 34" aria-hidden="true"><polyline points={points} /></svg>;
}

function UsageChart({ title, days, series, getValue, money = false }) {
  const maxValue = Math.max(...days.map((day) => series.reduce((sum, item) => sum + getValue(day, item), 0)), 0);
  return (
    <section className="usage-chart-card" aria-label={title}>
      <div className="usage-section-heading"><h3>{title}</h3><span>{money ? "USD" : "Tokens"}</span></div>
      <div className="usage-chart">
        <div className="usage-axis"><span>{formatUsage(maxValue, money)}</span><span>{formatUsage(maxValue / 2, money)}</span><span>0</span></div>
        <div className="usage-plot">
          <div className="usage-grid-lines" aria-hidden="true"><i /><i /><i /></div>
          {days.map((day) => (
            <div className="usage-day" key={day.date}>
              <div className="usage-bar" tabIndex={0} aria-label={`${day.date}: ${series.map((item) => `${item.name} ${formatUsage(getValue(day, item), money)}`).join(", ")}`}>
                {series.map((item) => <div key={item.id} style={{ height: `${maxValue ? getValue(day, item) / maxValue * 100 : 0}%`, background: item.color }} />)}
                <div className="usage-tooltip"><strong>{day.date}</strong>{series.map((item) => <span key={item.id}>{item.name}: {formatUsage(getValue(day, item), money)}</span>)}</div>
              </div>
              <span className="usage-day-label">{dayLabel(day.date)}</span>
            </div>
          ))}
          {!maxValue && <span className="usage-chart-empty">No recorded {money ? "spend" : "tokens"} this week</span>}
        </div>
      </div>
      <div className="usage-legend">{series.map((item) => <span key={item.id}><i style={{ background: item.color }} />{item.name}</span>)}</div>
    </section>
  );
}

export function UsagePanel({ models }) {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

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
  }, [refreshKey]);

  if (error) return <div className="usage-state" role="alert"><p>Usage could not be loaded.</p><button onClick={() => setRefreshKey((value) => value + 1)}>Try again</button></div>;
  if (!usage) return <div className="usage-state" role="status">Loading usage…</div>;

  const modelSeries = usage.models.map((item, index) => ({ ...item, name: models.find((model) => model.id === item.id)?.name || (item.id === "unknown" ? "Unrecorded model" : item.id.split("/").at(-1)), color: chartColors[index % chartColors.length] }));
  const topModels = modelSeries.slice(0, 5);
  const chartSeries = modelSeries.length > 5 ? [...topModels, { id: "other", name: "Other", color: chartColors[5] }] : topModels;
  const getModelSpend = (day, item) => item.id === "other" ? modelSeries.slice(5).reduce((sum, model) => sum + (day.models[model.id] || 0), 0) : day.models[item.id] || 0;
  const metrics = [
    { key: "cost", label: "Recorded spend", money: true },
    { key: "requests", label: "Requests" },
    { key: "totalTokens", label: "Token volume" },
    { key: "blendedCost", label: "Cost / 1M tokens", money: true },
  ];
  const dateRange = `${new Date(`${usage.startDate}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(`${usage.endDate}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  return (
    <div className="usage-panel">
      <div className="usage-period"><span>Last 7 days</span><span>{dateRange}</span><button onClick={() => setRefreshKey((value) => value + 1)} aria-label="Refresh usage">Refresh</button></div>
      <div className="usage-summary">
        {metrics.map((metric) => <section className="usage-metric" key={metric.key} aria-label={metric.label}>
          <h3>{metric.label}</h3>
          <div className="usage-metric-value"><strong>{formatUsage(usage.current[metric.key], metric.money)}</strong><Sparkline values={usage.days.map((day) => day[metric.key] || 0)} /></div>
          <p>{comparison(usage.current[metric.key], usage.previous[metric.key], metric.money)}</p>
        </section>)}
      </div>
      <UsageChart title="Usage by model" days={usage.days} series={chartSeries} getValue={getModelSpend} money />
      <UsageChart title="Token breakdown" days={usage.days} series={tokenSeries} getValue={(day, item) => day[item.id]} />
      <section className="usage-models" aria-label="Model totals">
        <div className="usage-section-heading"><h3>Model totals</h3><span>This week</span></div>
        {modelSeries.length ? <div className="usage-table-wrap"><table><thead><tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Spend</th></tr></thead><tbody>{modelSeries.map((model) => <tr key={model.id}><td><i style={{ background: model.color }} />{model.name}</td><td>{formatUsage(model.requests)}</td><td>{formatUsage(model.totalTokens)}</td><td>{formatUsage(model.cost, true)}</td></tr>)}</tbody></table></div> : <p className="usage-muted">Your model usage will appear here.</p>}
      </section>
      <p className="usage-note">Saved RouterChat history only, including imported history. Deleted history and requests without saved usage are not included. All amounts are USD. Reasoning is shown separately from other completion tokens.</p>
      {(usage.current.missingCost > 0 || usage.current.missingTokens > 0) && <p className="usage-note">{usage.current.missingCost} requests have no recorded cost; {usage.current.missingTokens} have incomplete token details. Totals include available values.</p>}
    </div>
  );
}
