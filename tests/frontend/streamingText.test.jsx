import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import { streamWordsPlugin, takeWords } from "../../frontend/src/streamingText.js";

//the reveal cursor lives in a ref so the plugin can stamp already resolved words at render time,
//otherwise a markdown reparse mid stream flashes visible words back out

function render(markdown, revealed = 0) {
  const revealedRef = { current: revealed };
  return renderToStaticMarkup(
    <ReactMarkdown rehypePlugins={[streamWordsPlugin(revealedRef)]}>{markdown}</ReactMarkdown>,
  );
}

function countWords(html) {
  return (html.match(/class="t-stream-w/g) || []).length;
}

describe("streaming text word splitting", () => {
  it("wraps every word in its own span", () => {
    const html = render("the cat sat down");

    expect(countWords(html)).toBe(4);
    expect(html).toContain(">the</span>");
    expect(html).toContain(">down</span>");
  });

  it("keeps the whitespace between words", () => {
    const html = render("one two");

    expect(html.replace(/<[^>]+>/g, "")).toBe("one two");
  });

  it("leaves code blocks alone so whitespace survives", () => {
    const html = render("```\nif x:\n    return 1\n```");

    expect(countWords(html)).toBe(0);
    expect(html).toContain("    return 1");
  });

  it("leaves inline code alone", () => {
    const html = render("run `npm run build` now");

    expect(html).toContain("<code>npm run build</code>");
  });

  it("still splits words inside bold and links", () => {
    const html = render("a **bold word** here");

    expect(countWords(html)).toBe(4);
    expect(html).toContain("<strong>");
  });

  it("stamps is-in on words already behind the cursor", () => {
    const html = render("one two three four", 2);

    const resolved = (html.match(/class="t-stream-w is-in"/g) || []).length;
    expect(resolved).toBe(2);
    expect(countWords(html)).toBe(4);
  });

  it("counts words across block boundaries with one running cursor", () => {
    const html = render("first para\n\nsecond para", 3);

    const resolved = (html.match(/class="t-stream-w is-in"/g) || []).length;
    expect(resolved).toBe(3);
    expect(countWords(html)).toBe(4);
  });
});

describe("takeWords", () => {
  it("cuts the markdown at the reveal cursor instead of hiding the tail", () => {
    expect(takeWords("one two three four", 2)).toBe("one two");
  });

  it("hands back the whole string once the cursor has caught up", () => {
    const markdown = "one two three\n\nfour";

    expect(takeWords(markdown, 4)).toBe(markdown);
    expect(takeWords(markdown, 99)).toBe(markdown);
  });

  it("keeps the block structure that has already been revealed", () => {
    expect(takeWords("# Title\n\nA sentence here", 3)).toBe("# Title\n\nA");
  });

  it("returns nothing before the cursor has moved", () => {
    expect(takeWords("one two", 0)).toBe("");
  });
});
