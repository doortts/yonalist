import { describe, expect, it } from "vitest";
import {
  isStandaloneRemoteMarkdownImage,
  parseNoteMarkdown,
  sourceOffsetFromPresentation
} from "./noteMarkdown";

describe("parseNoteMarkdown", () => {
  it.each([
    ["# Heading", "heading", 1, 2],
    ["## Heading", "heading", 2, 3],
    ["### Heading", "heading", 3, 4]
  ] as const)(
    "parses %s as level %s",
    (source, kind, level, markerEndUtf16) => {
      expect(parseNoteMarkdown(source)).toMatchObject({
        kind,
        level,
        markerEndUtf16
      });
    }
  );

  it.each(["#tag", "##tag", "#### Heading", "# ", " # Heading"])(
    "keeps non-heading %s as text",
    (source) => {
      expect(parseNoteMarkdown(source)).toMatchObject({ kind: "text" });
    }
  );

  it("recognizes only the exact two-character divider", () => {
    expect(parseNoteMarkdown("--")).toEqual({ kind: "divider" });
    for (const source of ["---", " --", "-- ", "- -"]) {
      expect(parseNoteMarkdown(source)).toMatchObject({ kind: "text" });
    }
  });

  it("recognizes a non-empty quote prefix at the first source position", () => {
    expect(parseNoteMarkdown("> Quote")).toMatchObject({
      kind: "quote",
      markerEndUtf16: 2
    });
    for (const source of [">", "> ", ">Quote", " > Quote"]) {
      expect(parseNoteMarkdown(source)).toMatchObject({ kind: "text" });
    }
  });

  it("tokenizes links, strong text, and struck text with source ranges", () => {
    const source =
      "Read [문서](https://example.com) then **굵게** and ~~취소~~";
    const parsed = parseNoteMarkdown(source);

    expect(parsed).toMatchObject({ kind: "text" });
    if (parsed.kind !== "text") return;
    expect(parsed.inline).toEqual([
      {
        kind: "text",
        startUtf16: 0,
        endUtf16: 5,
        contentStartUtf16: 0,
        contentEndUtf16: 5
      },
      {
        kind: "link",
        startUtf16: 5,
        endUtf16: 30,
        contentStartUtf16: 6,
        contentEndUtf16: 8,
        href: "https://example.com"
      },
      {
        kind: "text",
        startUtf16: 30,
        endUtf16: 36,
        contentStartUtf16: 30,
        contentEndUtf16: 36
      },
      {
        kind: "strong",
        startUtf16: 36,
        endUtf16: 42,
        contentStartUtf16: 38,
        contentEndUtf16: 40
      },
      {
        kind: "text",
        startUtf16: 42,
        endUtf16: 47,
        contentStartUtf16: 42,
        contentEndUtf16: 47
      },
      {
        kind: "strike",
        startUtf16: 47,
        endUtf16: 53,
        contentStartUtf16: 49,
        contentEndUtf16: 51
      }
    ]);
  });

  it.each([
    "[x](javascript:alert(1))",
    "[x](data:text/plain,no)",
    "[](https://example.com)",
    "[x]()",
    "[open](https://example.com",
    "** open**",
    "~~ ~~"
  ])("leaves unsupported or incomplete inline syntax as text: %s", (source) => {
    const parsed = parseNoteMarkdown(source);
    expect(parsed).toMatchObject({ kind: "text" });
    if (parsed.kind !== "text") return;
    expect(parsed.inline).toEqual([
      {
        kind: "text",
        startUtf16: 0,
        endUtf16: source.length,
        contentStartUtf16: 0,
        contentEndUtf16: source.length
      }
    ]);
  });

  it("accepts a standalone HTTPS image but rejects mixed or unsafe images", () => {
    expect(
      parseNoteMarkdown("![차트](https://example.com/chart.png)")
    ).toEqual({
      kind: "remoteImage",
      alt: "차트",
      url: "https://example.com/chart.png"
    });
    expect(
      parseNoteMarkdown("![](https://example.com/chart.png)")
    ).toEqual({
      kind: "remoteImage",
      alt: "",
      url: "https://example.com/chart.png"
    });
    for (const source of [
      "앞 ![차트](https://example.com/chart.png)",
      "![차트](https://example.com/chart.png) 뒤",
      "![차트](http://example.com/chart.png)",
      "![차트](data:image/png;base64,AA)",
      "![차트](https://example.com/chart.png \"title\")"
    ]) {
      expect(parseNoteMarkdown(source)).toMatchObject({ kind: "text" });
      expect(isStandaloneRemoteMarkdownImage(source)).toBe(false);
    }
    expect(
      isStandaloneRemoteMarkdownImage(
        "![차트](https://example.com/chart.png)"
      )
    ).toBe(true);
  });
});

describe("sourceOffsetFromPresentation", () => {
  it("skips hidden block and inline markers", () => {
    const source = "## 한😀글 **굵게**";
    const parsed = parseNoteMarkdown(source);

    expect(sourceOffsetFromPresentation(parsed, 0)).toBe(3);
    expect(sourceOffsetFromPresentation(parsed, 1)).toBe(4);
    expect(sourceOffsetFromPresentation(parsed, 3)).toBe(6);
    expect(sourceOffsetFromPresentation(parsed, 5)).toBe(10);
    expect(sourceOffsetFromPresentation(parsed, 6)).toBe(11);
    expect(sourceOffsetFromPresentation(parsed, 8)).toBe(source.length);
    expect(sourceOffsetFromPresentation(parsed, 999)).toBe(source.length);
  });

  it("maps a rendered link label into its label source range", () => {
    const source = "A [문서](https://example.com) Z";
    const parsed = parseNoteMarkdown(source);

    expect(sourceOffsetFromPresentation(parsed, 2)).toBe(3);
    expect(sourceOffsetFromPresentation(parsed, 3)).toBe(4);
    expect(sourceOffsetFromPresentation(parsed, 4)).toBe(27);
  });

  it("maps a divider and remote image to safe source boundaries", () => {
    expect(sourceOffsetFromPresentation(parseNoteMarkdown("--"), 0)).toBe(0);
    expect(sourceOffsetFromPresentation(parseNoteMarkdown("--"), 4)).toBe(2);
    const image = "![x](https://example.com/x.png)";
    expect(
      sourceOffsetFromPresentation(parseNoteMarkdown(image), 0)
    ).toBe(0);
    expect(
      sourceOffsetFromPresentation(parseNoteMarkdown(image), 1)
    ).toBe(image.length);
  });
});
