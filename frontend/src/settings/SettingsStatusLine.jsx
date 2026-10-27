import { cx } from "../uiShared.js";

export function SettingsStatusLine({ items, onJump }) {
  return (
    <div role="group" aria-label="Current setup" className="settings-status-line">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onJump(item.page, item.target)}
          title={`${item.label}: open ${item.pageLabel}`}
          aria-label={`${item.label}: ${item.value}${item.status ? `, ${item.status}` : ""}. Open ${item.pageLabel} settings`}
          className="settings-status-item"
        >
          {item.tone && (
            <span
              aria-hidden="true"
              className={cx("settings-status-dot", item.tone === "error" ? "is-error" : "is-ok")}
            />
          )}
          <span className="truncate">{item.value}</span>
          {item.warning && <span className="settings-status-warning">{item.warning}</span>}
        </button>
      ))}
    </div>
  );
}
