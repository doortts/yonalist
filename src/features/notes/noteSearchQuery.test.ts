import { describe, expect, it } from "vitest";
import {
  canonicalNoteSearchQueryKey,
  canonicalizeNoteSearchQuery,
  parseNoteSearchQuery
} from "./noteSearchQuery";
import { tokenizeNoteText } from "./noteTokens";
import tokenizerFixtures from "./noteTokenizer.fixtures.json";

describe("note tokenizer shared parity fixtures", () => {
  it.each(tokenizerFixtures)("matches shared UTF-16 tokens for $source", (fixture) => {
    expect(
      tokenizeNoteText(fixture.source)
        .filter((token) => token.kind === "tag")
        .map(({ prefix, display, normalized, startUtf16, endUtf16 }) => ({
          prefix,
          display,
          normalized,
          startUtf16,
          endUtf16
        }))
    ).toEqual(fixture.tags);
  });
});

describe("parseNoteSearchQuery", () => {
  it("parses plain text with required and excluded tag clauses", () => {
    expect(parseNoteSearchQuery("release notes #Roadmap @Minji -#Blocked")).toEqual({
      text: "release notes",
      requiredTags: [
        { prefix: "#", normalizedTag: "roadmap", displayTag: "Roadmap" },
        { prefix: "@", normalizedTag: "minji", displayTag: "Minji" }
      ],
      excludedTags: [
        { prefix: "#", normalizedTag: "blocked", displayTag: "Blocked" }
      ],
      orGroups: []
    });
  });

  it("joins only uppercase OR chains of positive tags", () => {
    expect(
      parseNoteSearchQuery("launch #Frontend OR @Platform OR #Desktop owner OR team")
    ).toEqual({
      text: "launch owner OR team",
      requiredTags: [],
      excludedTags: [],
      orGroups: [
        [
          { prefix: "#", normalizedTag: "desktop", displayTag: "Desktop" },
          { prefix: "#", normalizedTag: "frontend", displayTag: "Frontend" },
          { prefix: "@", normalizedTag: "platform", displayTag: "Platform" }
        ]
      ]
    });

    expect(parseNoteSearchQuery("#one or #two").text).toBe("or");
    expect(parseNoteSearchQuery("#one or #two").requiredTags).toEqual([
      { prefix: "#", normalizedTag: "one", displayTag: "one" },
      { prefix: "#", normalizedTag: "two", displayTag: "two" }
    ]);
  });

  it("does not turn invalid clauses or URL fragments into filters", () => {
    expect(
      parseNoteSearchQuery("# https://example.com/#fragment -# foo#bar /#root")
    ).toEqual({
      text: "# https://example.com/#fragment -# foo#bar /#root",
      requiredTags: [],
      excludedTags: [],
      orGroups: []
    });
  });

  it("uses Unicode lowercase normalization for Korean, astral, and combining tags", () => {
    expect(parseNoteSearchQuery("#프로젝트 @𐐏 #CAFE\u0301").requiredTags).toEqual([
      { prefix: "#", normalizedTag: "cafe\u0301", displayTag: "CAFE\u0301" },
      { prefix: "#", normalizedTag: "프로젝트", displayTag: "프로젝트" },
      { prefix: "@", normalizedTag: "𐐷", displayTag: "𐐏" }
    ]);
  });
});

describe("canonicalizeNoteSearchQuery", () => {
  it("normalizes, deduplicates, and sorts filters and OR groups", () => {
    expect(
      canonicalizeNoteSearchQuery({
        text: "  release   notes  ",
        requiredTags: [
          { prefix: "@", normalizedTag: "MINJI", displayTag: "MINJI" },
          { prefix: "#", normalizedTag: "Roadmap", displayTag: "Roadmap" },
          { prefix: "#", normalizedTag: "roadmap", displayTag: "roadmap" }
        ],
        excludedTags: [
          { prefix: "@", normalizedTag: "BOT", displayTag: "BOT" },
          { prefix: "@", normalizedTag: "bot", displayTag: "bot" }
        ],
        orGroups: [
          [
            { prefix: "@", normalizedTag: "QA", displayTag: "QA" },
            { prefix: "#", normalizedTag: "Web", displayTag: "Web" }
          ],
          [
            { prefix: "#", normalizedTag: "web", displayTag: "web" },
            { prefix: "@", normalizedTag: "qa", displayTag: "qa" }
          ],
          [{ prefix: "#", normalizedTag: "Solo", displayTag: "Solo" }]
        ]
      })
    ).toEqual({
      text: "release notes",
      requiredTags: [
        { prefix: "#", normalizedTag: "roadmap", displayTag: "Roadmap" },
        { prefix: "#", normalizedTag: "solo", displayTag: "Solo" },
        { prefix: "@", normalizedTag: "minji", displayTag: "MINJI" }
      ],
      excludedTags: [
        { prefix: "@", normalizedTag: "bot", displayTag: "BOT" }
      ],
      orGroups: [
        [
          { prefix: "#", normalizedTag: "web", displayTag: "Web" },
          { prefix: "@", normalizedTag: "qa", displayTag: "QA" }
        ]
      ]
    });
  });

  it("produces the same stable key for equivalent filter ordering and display case", () => {
    const left = parseNoteSearchQuery("notes #Topic @ALICE OR #Roadmap -@BOT");
    const right = parseNoteSearchQuery("notes -@bot #roadmap OR @alice #topic");

    expect(canonicalNoteSearchQueryKey(left)).toBe(
      canonicalNoteSearchQueryKey(right)
    );
  });
});
