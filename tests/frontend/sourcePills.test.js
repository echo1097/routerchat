import { describe, expect, it } from "vitest";

import {
  faviconUrl,
  groupSourcesByDomain,
  siteLabel,
} from "../../frontend/src/websearch/SourcePills.jsx";

const sources = [
  { url: "https://support.google.com/a", title: "First", domain: "support.google.com" },
  { url: "https://en.wikipedia.org/b", title: "Second", domain: "en.wikipedia.org" },
  { url: "https://support.google.com/c", title: "Third", domain: "support.google.com" },
];

describe("grouping sources into pills", () => {
  it("puts every page from one site in a single pill", () => {
    const groups = groupSourcesByDomain(sources);
    expect(groups).toHaveLength(2);
    expect(groups[0].domain).toBe("support.google.com");
    expect(groups[0].pages).toHaveLength(2);
    expect(groups[1].pages).toHaveLength(1);
  });

  it("keeps the order the sites were first cited in", () => {
    expect(groupSourcesByDomain(sources).map((group) => group.domain))
      .toEqual(["support.google.com", "en.wikipedia.org"]);
  });

  it("skips entries with nothing to link to", () => {
    const groups = groupSourcesByDomain([
      { url: "", domain: "example.com" },
      { url: "https://example.com/a" },
      { url: "https://example.com/b", domain: "example.com" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].pages).toHaveLength(1);
  });

  it("handles a message with no sources at all", () => {
    expect(groupSourcesByDomain(undefined)).toEqual([]);
    expect(groupSourcesByDomain([])).toEqual([]);
  });
});

describe("pill labels and icons", () => {
  it("drops the www prefix from the site name", () => {
    expect(siteLabel("www.example.com")).toBe("example.com");
    expect(siteLabel("news.example.com")).toBe("news.example.com");
  });

  it("falls back to a readable label", () => {
    expect(siteLabel("")).toBe("Source");
  });

  it("asks the local backend for the icon rather than a third party", () => {
    expect(faviconUrl("example.com")).toBe("/api/favicon?domain=example.com");
    expect(faviconUrl("a b.com")).toBe("/api/favicon?domain=a%20b.com");
  });
});
