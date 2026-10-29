import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Prose } from "./prose.js";

describe("Prose", () => {
  // The system prompt view used to split the prompt on newlines the JSX transform
  // had already removed, so a prompt reached the preview as one wall of text.
  it("renders authored prose as formatted text: paragraphs, headings and lists", () => {
    const html = renderToStaticMarkup(
      <Prose text={"You are a support agent.\n\n## Rules\n- Answer in one sentence.\n- Never invent prices."} />,
    );

    expect(html).toMatch(/<p[^>]*>You are a support agent\.<\/p>/);
    expect(html).toMatch(/<h2[^>]*>Rules<\/h2>/);
    expect(html).toMatch(/<li[^>]*>Answer in one sentence\.<\/li>/);
    expect(html).toMatch(/<li[^>]*>Never invent prices\.<\/li>/);
  });

  it("keeps a line break inside a paragraph for the stylesheet to show", () => {
    const html = renderToStaticMarkup(<Prose text={"Rule one.\nRule two."} />);

    expect(html).toMatch(/<p[^>]*>Rule one\.\nRule two\.<\/p>/);
    expect(html).toContain('class="prose-view markdown-message"');
  });
});
