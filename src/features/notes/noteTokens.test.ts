import { describe, expect, it } from "vitest";
import { tokenizeNoteText } from "./noteTokens";

function expectLosslessCoverage(source: string) {
  const tokens = tokenizeNoteText(source);

  expect(tokens.map((token) => token.raw).join("")).toBe(source);

  let expectedStart = 0;
  for (const token of tokens) {
    expect(token.startUtf16).toBe(expectedStart);
    expect(token.endUtf16).toBeGreaterThan(token.startUtf16);
    expect(token.raw).toBe(source.slice(token.startUtf16, token.endUtf16));

    const startCodeUnit = source.charCodeAt(token.startUtf16);
    const endCodeUnit = source.charCodeAt(token.endUtf16);
    expect(startCodeUnit >= 0xdc00 && startCodeUnit <= 0xdfff).toBe(false);
    expect(endCodeUnit >= 0xdc00 && endCodeUnit <= 0xdfff).toBe(false);

    expectedStart = token.endUtf16;
  }
  expect(expectedStart).toBe(source.length);
}

describe("tokenizeNoteText", () => {
  it("tokenizes Korean and ASCII tags while preserving display text", () => {
    expect(tokenizeNoteText("안녕 #프로젝트 @Person_1 #a-b")).toEqual([
      {
        kind: "text",
        raw: "안녕 ",
        startUtf16: 0,
        endUtf16: 3
      },
      {
        kind: "tag",
        prefix: "#",
        display: "프로젝트",
        normalized: "프로젝트",
        raw: "#프로젝트",
        startUtf16: 3,
        endUtf16: 8
      },
      {
        kind: "text",
        raw: " ",
        startUtf16: 8,
        endUtf16: 9
      },
      {
        kind: "tag",
        prefix: "@",
        display: "Person_1",
        normalized: "person_1",
        raw: "@Person_1",
        startUtf16: 9,
        endUtf16: 18
      },
      {
        kind: "text",
        raw: " ",
        startUtf16: 18,
        endUtf16: 19
      },
      {
        kind: "tag",
        prefix: "#",
        display: "a-b",
        normalized: "a-b",
        raw: "#a-b",
        startUtf16: 19,
        endUtf16: 23
      }
    ]);
  });

  it("uses half-open UTF-16 offsets without splitting emoji surrogate pairs", () => {
    expect(tokenizeNoteText("😀#Tag 🚀끝")).toEqual([
      {
        kind: "text",
        raw: "😀",
        startUtf16: 0,
        endUtf16: 2
      },
      {
        kind: "tag",
        prefix: "#",
        display: "Tag",
        normalized: "tag",
        raw: "#Tag",
        startUtf16: 2,
        endUtf16: 6
      },
      {
        kind: "text",
        raw: " 🚀끝",
        startUtf16: 6,
        endUtf16: 10
      }
    ]);
  });

  it("recognizes tags after punctuation and stops at non-body characters", () => {
    const tokens = tokenizeNoteText("(#one),[@two];!#three.more");

    expect(tokens.filter((token) => token.kind === "tag")).toEqual([
      expect.objectContaining({ raw: "#one", display: "one" }),
      expect.objectContaining({ raw: "@two", display: "two" }),
      expect.objectContaining({ raw: "#three", display: "three" })
    ]);
    expectLosslessCoverage("(#one),[@two];!#three.more");
  });

  it("keeps ordinary punctuation boundaries outside URL-like segments", () => {
    const tokens = tokenizeNoteText("(#tag) hello, #next");

    expect(tokens.filter((token) => token.kind === "tag")).toEqual([
      expect.objectContaining({ raw: "#tag", display: "tag" }),
      expect.objectContaining({ raw: "#next", display: "next" })
    ]);
    expectLosslessCoverage("(#tag) hello, #next");
  });

  it.each([
    ["and/or,#tag", "#tag"],
    ["what?yes=#tag", "#tag"],
    ["?user=@alice", "@alice"]
  ])(
    "does not infer a URL from punctuation alone in %j",
    (source, expectedTag) => {
      expect(
        tokenizeNoteText(source)
          .filter((token) => token.kind === "tag")
          .map((token) => token.raw)
      ).toEqual([expectedTag]);
      expectLosslessCoverage(source);
    }
  );

  it.each([
    "https://x/?q=#tag",
    "www.x.com/?u=@alice",
    "example.com/?q=#tag",
    "/path/?q=#tag"
  ])("rejects markers inside the URL-like segment %j", (source) => {
    expect(tokenizeNoteText(source).filter((token) => token.kind === "tag"))
      .toHaveLength(0);
    expectLosslessCoverage(source);
  });

  it("suppresses only markers after URL evidence in the same segment", () => {
    const source = "#first,https://x/?q=#second";

    expect(
      tokenizeNoteText(source)
        .filter((token) => token.kind === "tag")
        .map((token) => token.raw)
    ).toEqual(["#first"]);
    expectLosslessCoverage(source);
  });

  it.each([
    "foo#bar",
    "name@example.com",
    "https://example.com/#fragment",
    "_#tag",
    "-#tag",
    "/#tag",
    "#",
    "@",
    "##tag",
    "@@person",
    "#@tag",
    "@#tag"
  ])("rejects invalid marker context in %j", (source) => {
    expect(tokenizeNoteText(source).filter((token) => token.kind === "tag"))
      .toHaveLength(0);
    expectLosslessCoverage(source);
  });

  it("keeps duplicate case variants as ordered source tokens", () => {
    const tokens = tokenizeNoteText("#Topic, #topic, @ALICE @alice");

    expect(tokens.filter((token) => token.kind === "tag")).toEqual([
      expect.objectContaining({
        prefix: "#",
        display: "Topic",
        normalized: "topic",
        raw: "#Topic"
      }),
      expect.objectContaining({
        prefix: "#",
        display: "topic",
        normalized: "topic",
        raw: "#topic"
      }),
      expect.objectContaining({
        prefix: "@",
        display: "ALICE",
        normalized: "alice",
        raw: "@ALICE"
      }),
      expect.objectContaining({
        prefix: "@",
        display: "alice",
        normalized: "alice",
        raw: "@alice"
      })
    ]);
    expectLosslessCoverage("#Topic, #topic, @ALICE @alice");
  });

  it.each(["cafe\u0301#todo", "नमस्ते#todo"])(
    "treats combining marks as word continuation in %j",
    (source) => {
      expect(tokenizeNoteText(source).filter((token) => token.kind === "tag"))
        .toHaveLength(0);
      expectLosslessCoverage(source);
    }
  );

  it.each(["#cafe\u0301", "#नमस्ते"])(
    "keeps combining marks in the tag body and derives an NFC value %j",
    (source) => {
      expect(tokenizeNoteText(source)).toEqual([
        {
          kind: "tag",
          prefix: "#",
          // The derived value is NFC-normalized; `raw` and the offsets still index
          // the original (possibly decomposed) source.
          display: source.slice(1).normalize("NFC"),
          normalized: source.slice(1).normalize("NFC").toLowerCase(),
          raw: source,
          startUtf16: 0,
          endUtf16: source.length
        }
      ]);
      expectLosslessCoverage(source);
    }
  );

  it("requires a letter, number, underscore, or hyphen before body marks", () => {
    const source = "#\u0301todo";

    expect(tokenizeNoteText(source)).toEqual([
      {
        kind: "text",
        raw: source,
        startUtf16: 0,
        endUtf16: source.length
      }
    ]);
  });

  it("uses UTF-16 offsets for astral Unicode tag letters", () => {
    expect(tokenizeNoteText("#𐐷")).toEqual([
      {
        kind: "tag",
        prefix: "#",
        display: "𐐷",
        normalized: "𐐷",
        raw: "#𐐷",
        startUtf16: 0,
        endUtf16: 3
      }
    ]);
    expectLosslessCoverage("#𐐷");
  });

  it("returns lossless text tokens for plain and empty source", () => {
    expect(tokenizeNoteText("plain text")).toEqual([
      {
        kind: "text",
        raw: "plain text",
        startUtf16: 0,
        endUtf16: 10
      }
    ]);
    expect(tokenizeNoteText("")).toEqual([]);
    expectLosslessCoverage("plain 😀 text");
    expectLosslessCoverage("");
  });

  it.each([
    ["**bold**", "strong", 2, 6],
    ["*slanted*", "em", 1, 8],
    ["~~struck~~", "strike", 2, 8],
    ["`code`", "code", 1, 5]
  ])(
    "recognizes the %j inline span keeping markers in raw",
    (source, kind, innerStartUtf16, innerEndUtf16) => {
      expect(tokenizeNoteText(source)).toEqual([
        {
          kind,
          raw: source,
          startUtf16: 0,
          endUtf16: source.length,
          innerStartUtf16,
          innerEndUtf16
        }
      ]);
      expectLosslessCoverage(source);
    }
  );

  it("splits surrounding prose from an inline span", () => {
    expect(tokenizeNoteText("say **hi** now")).toEqual([
      { kind: "text", raw: "say ", startUtf16: 0, endUtf16: 4 },
      {
        kind: "strong",
        raw: "**hi**",
        startUtf16: 4,
        endUtf16: 10,
        innerStartUtf16: 6,
        innerEndUtf16: 8
      },
      { kind: "text", raw: " now", startUtf16: 10, endUtf16: 14 }
    ]);
    expectLosslessCoverage("say **hi** now");
  });

  it("prefers the two-character strong marker over emphasis", () => {
    const tokens = tokenizeNoteText("**bold** *italic*");

    expect(tokens.map((token) => [token.kind, token.raw])).toEqual([
      ["strong", "**bold**"],
      ["text", " "],
      ["em", "*italic*"]
    ]);
    expectLosslessCoverage("**bold** *italic*");
  });

  it.each([
    "**unclosed bold",
    "trailing marker*",
    "a * b * c",
    "space after ** bold**",
    "*bold *",
    "empty pair ****",
    "lone `backtick",
    "~~half strike"
  ])("keeps one-sided or whitespace-flanked markers literal in %j", (source) => {
    expect(
      tokenizeNoteText(source).filter((token) => token.kind !== "text")
    ).toHaveLength(0);
    expectLosslessCoverage(source);
  });

  it("does not recurse: a tag inside a span is plain styled content", () => {
    // The FE overlay renders spans non-recursively, so `#alice` inside `**…**`
    // stays part of the strong token (no separate tag token). NOTE: the Rust
    // FTS tokenizer is formatting-unaware and still indexes this tag; that
    // divergence is intentional and documented as a follow-up.
    expect(tokenizeNoteText("**owner #alice**")).toEqual([
      {
        kind: "strong",
        raw: "**owner #alice**",
        startUtf16: 0,
        endUtf16: 16,
        innerStartUtf16: 2,
        innerEndUtf16: 14
      }
    ]);
    expectLosslessCoverage("**owner #alice**");
  });

  it("recognizes a tag that sits outside an inline span", () => {
    const tokens = tokenizeNoteText("**done** #ship");

    expect(tokens.map((token) => [token.kind, token.raw])).toEqual([
      ["strong", "**done**"],
      ["text", " "],
      ["tag", "#ship"]
    ]);
    expectLosslessCoverage("**done** #ship");
  });

  it("keeps emoji inside a span without splitting surrogate pairs", () => {
    expect(tokenizeNoteText("**😀ok**")).toEqual([
      {
        kind: "strong",
        raw: "**😀ok**",
        startUtf16: 0,
        endUtf16: 8,
        innerStartUtf16: 2,
        innerEndUtf16: 6
      }
    ]);
    expectLosslessCoverage("**😀ok**");
  });

  it("scans long input without losing or duplicating source", () => {
    const source = `${"word#not-a-tag ".repeat(20_000)}😀#끝`;
    const tokens = tokenizeNoteText(source);

    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toEqual({
      kind: "tag",
      prefix: "#",
      display: "끝",
      normalized: "끝",
      raw: "#끝",
      startUtf16: source.length - 2,
      endUtf16: source.length
    });
    expectLosslessCoverage(source);
  });

  it("scans a long URL-like segment with many markers in linear time", () => {
    const source = `https://example.test/?q=${"#todo&next=".repeat(20_000)}end`;
    const tokens = tokenizeNoteText(source);

    // The whole run is a single http URL token: its `#` markers are consumed as
    // URL characters, never re-scanned as tags. The scan stays linear.
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      kind: "url",
      raw: source,
      startUtf16: 0,
      endUtf16: source.length
    });
    expectLosslessCoverage(source);
  });

  it.each(["café", "한글"])(
    "unifies decomposed and composed tag derivations to NFC for %j",
    (word) => {
      // Derive both spellings explicitly so the test does not depend on how the
      // source literal above happens to be normalized on disk.
      const composedSource = `#${word.normalize("NFC")}`;
      const decomposedSource = `#${word.normalize("NFD")}`;
      const composedValue = word.normalize("NFC");
      const decomposed = tokenizeNoteText(decomposedSource);
      const composed = tokenizeNoteText(composedSource);

      expect(decomposed).toHaveLength(1);
      expect(composed).toHaveLength(1);
      const decomposedTag = decomposed[0];
      const composedTag = composed[0];
      if (decomposedTag.kind !== "tag" || composedTag.kind !== "tag") {
        throw new Error("expected tag tokens");
      }

      // A decomposed spelling derives the same tag value as the composed spelling.
      expect(decomposedTag.display).toBe(composedTag.display);
      expect(decomposedTag.normalized).toBe(composedTag.normalized);
      expect(decomposedTag.display).toBe(composedValue);
      expect(decomposedTag.display.normalize("NFC")).toBe(decomposedTag.display);
      // Offsets still index the ORIGINAL source, so the decomposed span is longer.
      expect(decomposedSource.length).toBeGreaterThan(composedSource.length);
      expect(decomposedTag.endUtf16).toBe(decomposedSource.length);
      expect(composedTag.endUtf16).toBe(composedSource.length);
      expectLosslessCoverage(decomposedSource);
      expectLosslessCoverage(composedSource);
    }
  );

  it("extracts an http URL and splits the surrounding prose", () => {
    expect(tokenizeNoteText("see http://example.com now")).toEqual([
      { kind: "text", raw: "see ", startUtf16: 0, endUtf16: 4 },
      {
        kind: "url",
        raw: "http://example.com",
        startUtf16: 4,
        endUtf16: 22
      },
      { kind: "text", raw: " now", startUtf16: 22, endUtf16: 26 }
    ]);
    expectLosslessCoverage("see http://example.com now");
  });

  it("keeps the whole https URL, including query and fragment", () => {
    expect(tokenizeNoteText("https://example.com/a/b?x=1#frag")).toEqual([
      {
        kind: "url",
        raw: "https://example.com/a/b?x=1#frag",
        startUtf16: 0,
        endUtf16: 32
      }
    ]);
    expectLosslessCoverage("https://example.com/a/b?x=1#frag");
  });

  it("matches the URL scheme case-insensitively", () => {
    expect(tokenizeNoteText("HTTPS://Example.com/Path")).toEqual([
      {
        kind: "url",
        raw: "HTTPS://Example.com/Path",
        startUtf16: 0,
        endUtf16: 24
      }
    ]);
    expectLosslessCoverage("HTTPS://Example.com/Path");
  });

  it.each([
    ["Visit https://example.com.", "https://example.com"],
    ["Visit https://example.com, then", "https://example.com"],
    ["(https://example.com)", "https://example.com"],
    ["see [https://example.com]!", "https://example.com"],
    ["ask https://example.com?", "https://example.com"]
  ])(
    "trims trailing sentence punctuation and unbalanced brackets in %j",
    (source, expected) => {
      const url = tokenizeNoteText(source).find(
        (token) => token.kind === "url"
      );
      expect(url?.raw).toBe(expected);
      expectLosslessCoverage(source);
    }
  );

  it("keeps balanced parentheses inside a URL", () => {
    const source = "https://en.wikipedia.org/wiki/Foo_(bar)";
    const tokens = tokenizeNoteText(source);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      kind: "url",
      raw: source,
      startUtf16: 0,
      endUtf16: source.length
    });
    expectLosslessCoverage(source);
  });

  it.each([
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "ftp://files.example.com/pub",
    "www.example.com/path",
    "http:/example.com",
    "https//example.com"
  ])("does not linkify non-http(s) text %j", (source) => {
    expect(tokenizeNoteText(source).some((token) => token.kind === "url")).toBe(
      false
    );
    expectLosslessCoverage(source);
  });

  it("requires a word boundary before the scheme", () => {
    const source = "xhttp://example.com";

    expect(tokenizeNoteText(source).some((token) => token.kind === "url")).toBe(
      false
    );
    expectLosslessCoverage(source);
  });

  it.each(["http://", "https://", "http:// spaced"])(
    "does not linkify a bare scheme without an authority in %j",
    (source) => {
      expect(
        tokenizeNoteText(source).some((token) => token.kind === "url")
      ).toBe(false);
      expectLosslessCoverage(source);
    }
  );

  it("does not recurse: a URL inside a formatting span stays styled text", () => {
    expect(tokenizeNoteText("**see http://example.com**")).toEqual([
      {
        kind: "strong",
        raw: "**see http://example.com**",
        startUtf16: 0,
        endUtf16: 26,
        innerStartUtf16: 2,
        innerEndUtf16: 24
      }
    ]);
    expectLosslessCoverage("**see http://example.com**");
  });

  it("wins over a formatting span that opens inside the URL", () => {
    // `*em*` would be emphasis, but it sits inside the URL that starts first, so
    // the URL consumes the markers as plain URL characters (non-recursion).
    const source = "http://example.com/*em*/page";
    const tokens = tokenizeNoteText(source);

    expect(tokens).toEqual([
      { kind: "url", raw: source, startUtf16: 0, endUtf16: source.length }
    ]);
    expectLosslessCoverage(source);
  });

  it("recognizes a tag that follows a URL separated by whitespace", () => {
    const source = "http://example.com #tag";

    expect(tokenizeNoteText(source).map((token) => [token.kind, token.raw])).toEqual(
      [
        ["url", "http://example.com"],
        ["text", " "],
        ["tag", "#tag"]
      ]
    );
    expectLosslessCoverage(source);
  });
});
