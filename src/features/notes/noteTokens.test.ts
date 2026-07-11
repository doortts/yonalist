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
});
