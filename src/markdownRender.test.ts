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
});
