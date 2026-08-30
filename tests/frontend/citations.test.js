import { describe, expect, it } from "vitest";

import {
  isCitationLink,
  linkHostname,
  stripCitationParens,
} from "../../frontend/src/websearch/citations.js";

function text(value) {
  return { type: "text", value };
}

function link(url, label) {
  return { type: "link", url, children: [text(label)] };
}

describe("spotting a citation link", () => {
  it("treats a bare domain pointing at that domain as a citation", () => {
    expect(isCitationLink("https://www.reuters.com/world/story", "reuters.com")).toBe(true);
    expect(isCitationLink("https://support.google.com/a", "support.google.com")).toBe(true);
  });

  it("accepts a citation that names the site without its subdomain", () => {
    expect(isCitationLink("https://news.bbc.co.uk/story", "bbc.co.uk")).toBe(true);
  });

  it("leaves ordinary prose links alone", () => {
    expect(isCitationLink("https://reuters.com/x", "this report")).toBe(false);
    expect(isCitationLink("https://reuters.com/x", "Reuters coverage of the story")).toBe(false);
  });

  it("does not pill a link whose text names a different site", () => {
    expect(isCitationLink("https://example.com/x", "reuters.com")).toBe(false);
  });

  it("survives a href it cannot parse", () => {
    expect(linkHostname("not a url")).toBe("");
    expect(isCitationLink("not a url", "reuters.com")).toBe(false);
  });
});

describe("tidying the parentheses around citations", () => {
  it("drops the brackets the model wrapped a citation in", () => {
    const tree = {
      type: "paragraph",
      children: [
        text("It rained "),
        text("("),
        link("https://reuters.com/a", "reuters.com"),
        text(") yesterday."),
      ],
    };

    stripCitationParens(tree);
    expect(tree.children.map((node) => node.value ?? "link")).toEqual([
      "It rained ",
      "",
      "link",
      " yesterday.",
    ]);
  });

  it("handles several citations inside one bracket", () => {
    const tree = {
      type: "paragraph",
      children: [
        text("Both agree ("),
        link("https://reuters.com/a", "reuters.com"),
        text(", "),
        link("https://bbc.co.uk/b", "bbc.co.uk"),
        text(")."),
      ],
    };

    stripCitationParens(tree);
    expect(tree.children[0].value).toBe("Both agree ");
    expect(tree.children[4].value).toBe(".");
  });

  it("leaves brackets that hold ordinary text", () => {
    const tree = {
      type: "paragraph",
      children: [
        text("The report ("),
        link("https://reuters.com/a", "read it here"),
        text(") says so."),
      ],
    };

    stripCitationParens(tree);
    expect(tree.children[0].value).toBe("The report (");
    expect(tree.children[2].value).toBe(") says so.");
  });

  it("walks nested content", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [text("("), link("https://reuters.com/a", "reuters.com"), text(")")],
        },
      ],
    };

    stripCitationParens(tree);
    expect(tree.children[0].children[0].value).toBe("");
    expect(tree.children[0].children[2].value).toBe("");
  });
});
