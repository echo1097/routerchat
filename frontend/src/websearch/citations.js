const BARE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const CITATION_SEPARATOR = /^[,;·|]?\s*$/;

export function linkHostname(href) {
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isCitationLink(href, label) {
  const text = String(label || "").trim().replace(/^www\./, "");
  if (!text || !BARE_DOMAIN.test(text)) return false;

  const hostname = linkHostname(href);
  if (!hostname) return false;

  return hostname === text.toLowerCase() || hostname.endsWith(`.${text.toLowerCase()}`);
}

export function linkText(node) {
  if (!node) return "";
  if (node.type === "text") return node.value || "";
  if (!Array.isArray(node.children)) return "";

  return node.children.map(linkText).join("");
}

function isCitationNode(node) {
  return node?.type === "link" && isCitationLink(node.url, linkText(node));
}

function citationRunEnd(children, start) {
  let index = start;
  let found = 0;

  while (index < children.length) {
    if (!isCitationNode(children[index])) break;
    found += 1;
    index += 1;

    const separator = children[index];
    if (separator?.type === "text" && CITATION_SEPARATOR.test(separator.value)) {
      index += 1;
    }
  }

  return found ? index : start;
}

export function stripCitationParens(node) {
  if (!node || !Array.isArray(node.children)) return;

  const children = node.children;
  for (const child of children) {
    stripCitationParens(child);
  }

  for (let index = 0; index < children.length; index += 1) {
    const opener = children[index];
    if (opener?.type !== "text" || !opener.value.endsWith("(")) continue;

    const end = citationRunEnd(children, index + 1);
    if (end === index + 1) continue;

    const closer = children[end];
    if (closer?.type !== "text" || !closer.value.startsWith(")")) continue;

    opener.value = opener.value.slice(0, -1);
    closer.value = closer.value.slice(1);
  }
}

export function remarkCitationPills() {
  return (tree) => stripCitationParens(tree);
}

const URL_IN_TEXT = /https?:\/\/[^\s<>()\[\]"'`]+/gi;

export function normalizeCitationUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}${parsed.search}`;
  } catch {
    return String(url || "").trim().toLowerCase().replace(/\/+$/, "");
  }
}

export function citedUrls(content) {
  const found = String(content || "").match(URL_IN_TEXT) || [];
  return new Set(found.map(normalizeCitationUrl));
}

export function uncitedSources(content, sources) {
  const cited = citedUrls(content);

  return (sources || []).filter(
    (source) => !cited.has(normalizeCitationUrl(source.url)),
  );
}
