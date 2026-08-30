import React, { useState } from "react";

import { cx, CONTROL_MOTION } from "../uiShared.js";

export function faviconUrl(domain) {
  return `/api/favicon?domain=${encodeURIComponent(domain)}`;
}

export function siteLabel(domain) {
  const name = String(domain || "").replace(/^www\./, "");
  return name || "Source";
}

export function groupSourcesByDomain(sources) {
  const groups = [];
  const byDomain = new Map();

  for (const source of sources || []) {
    if (!source?.url || !source?.domain) continue;

    const existing = byDomain.get(source.domain);
    if (existing) {
      existing.pages.push(source);
      continue;
    }

    const group = { domain: source.domain, pages: [source] };
    byDomain.set(source.domain, group);
    groups.push(group);
  }

  return groups;
}

function SourceIcon({ domain }) {
  const [failed, setFailed] = useState(false);
  const label = siteLabel(domain);

  if (failed) {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-white/10 text-[9px] font-semibold uppercase text-neutral-300">
        {label.slice(0, 1)}
      </span>
    );
  }

  return (
    <img
      src={faviconUrl(domain)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-4 w-4 shrink-0 rounded-full bg-white/10 object-contain"
    />
  );
}

function SourcePill({ group }) {
  const [first, ...rest] = group.pages;
  const label = siteLabel(group.domain);
  const title = rest.length
    ? `${first.title || first.url}\n+${rest.length} more from ${label}`
    : first.title || first.url;

  return (
    <a
      href={first.url}
      target="_blank"
      rel="noreferrer noopener"
      title={title}
      className={cx(
        "source-pill inline-flex max-w-[220px] items-center gap-2 rounded-full bg-white/[0.06] py-1 pl-2 pr-3",
        "text-xs font-medium text-neutral-300 hover:text-white focus:outline-none",
        CONTROL_MOTION,
      )}
    >
      <SourceIcon domain={group.domain} />
      <span className="truncate">{label}</span>
      {rest.length > 0 && (
        <span className="shrink-0 tabular-nums text-neutral-500">+{rest.length}</span>
      )}
    </a>
  );
}

export default function SourcePills({ sources, className = "" }) {
  const groups = groupSourcesByDomain(sources);
  if (groups.length === 0) return null;

  return (
    <div className={cx("flex flex-wrap items-center gap-2", className)}>
      {groups.map((group) => (
        <SourcePill key={group.domain} group={group} />
      ))}
    </div>
  );
}
