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

  it("allows sanitized raw image HTML tags", () => {
    const { __html } = renderMarkdown(
      '<img src="https://example.com/image.png" width="600px" onerror="alert(1)" />'
    );

    expect(__html).toContain("<img");
    expect(__html).toContain('src="https://example.com/image.png"');
    expect(__html).toContain('width="600px"');
    expect(__html).not.toContain("onerror");
  });

  it("removes unsafe raw image attributes", () => {
    const { __html } = renderMarkdown('<img src="x" onerror="alert(1)">');

    expect(__html).toContain("<img");
    expect(__html).not.toContain("onerror");
  });

  it("still strips raw script tags from HTML content", () => {
    const { __html } = renderMarkdown('<script>alert(1)</script><img src="https://example.com/a.png">');

    expect(__html).not.toContain("<script>");
    expect(__html).toContain("<img");
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

  it("highlights the common languages that stay registered", () => {
    for (const [lang, sample] of [
      ["typescript", "const a: number = 1;"],
      ["python", "def f():\n  return 1"],
      ["rust", "fn main() {}"],
      ["bash", "echo hi"],
      ["json", '{"a": 1}'],
      ["yaml", "a: 1"],
      ["diff", "+added\n-removed"]
    ] as const) {
      const { __html } = renderMarkdown(`\`\`\`${lang}\n${sample}\n\`\`\``);
      expect(__html, lang).toContain(`language-${lang}`);
      expect(__html, lang).toContain("hljs-");
    }
  });

  it("highlights common language aliases like golang", () => {
    const { __html } = renderMarkdown("```golang\nfunc main() {\n  println(\"hi\")\n}\n```");

    expect(__html).toContain('class="hljs language-go"');
    expect(__html).not.toContain("language-golang");
    expect(__html).toContain("hljs-");
  });

  it("falls back to escaped plain text for unregistered languages", () => {
    const { __html } = renderMarkdown("```brainfuck\n<+>-\n```");

    // No crash, code still fenced and escaped, no bogus token spans.
    expect(__html).toContain("<pre class=\"hljs\">");
    expect(__html).toContain("&lt;+&gt;-");
    expect(__html).not.toContain("language-brainfuck");
  });
});
