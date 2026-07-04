import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdownRender";

describe("renderMarkdown", () => {
  it("renders markdown to HTML", () => {
    const { __html } = renderMarkdown("**bold** and a [link](https://example.com)");

    expect(__html).toContain("<strong>bold</strong>");
    expect(__html).toContain('href="https://example.com"');
  });

  it("strips raw script tags from the output", () => {
    const { __html } = renderMarkdown('<script>alert(1)</script>**safe**');

    expect(__html).not.toContain("<script>");
    expect(__html).toContain("<strong>safe</strong>");
  });

  it("does not emit javascript: links", () => {
    const { __html } = renderMarkdown("[click](javascript:alert(1))");

    expect(__html).not.toContain('href="javascript:');
    expect(__html).not.toContain("<a");
  });

  it("neutralizes raw HTML so it renders as text, not elements", () => {
    const { __html } = renderMarkdown('<img src="x" onerror="alert(1)">');

    expect(__html).not.toContain("<img");
    expect(__html).toContain("&lt;img");
  });

  it("renders GFM task lists as checkboxes", () => {
    const { __html } = renderMarkdown("- [x] done\n- [ ] todo");

    const checkboxes = __html.match(/type="checkbox"/g) ?? [];
    expect(checkboxes.length).toBe(2);
    expect(__html).toContain("checked");
  });

  it("renders GFM tables", () => {
    const { __html } = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");

    expect(__html).toContain("<table");
    expect(__html).toContain("<th>a</th>");
    expect(__html).toContain("<td>1</td>");
  });

  it("renders strikethrough", () => {
    const { __html } = renderMarkdown("~~gone~~");
    expect(__html).toContain("<s>gone</s>");
  });

  it("converts emoji shortcodes", () => {
    const { __html } = renderMarkdown("ship it :tada:");
    expect(__html).toContain("🎉");
  });

  it("adds a language class to fenced code blocks for highlighting", () => {
    const { __html } = renderMarkdown("```js\nconst a = 1;\n```");
    expect(__html).toContain("language-js");
    // highlight.js wraps tokens in spans
    expect(__html).toContain("hljs");
  });
});
