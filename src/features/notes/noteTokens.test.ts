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

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      kind: "text",
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
});
