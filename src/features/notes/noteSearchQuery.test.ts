import { describe, expect, it } from "vitest";
import {
  NOTE_SEARCH_QUERY_LIMITS,
  canonicalNoteSearchQueryKey,
  canonicalizeNoteSearchQuery,
  parseAndValidateNoteSearchQuery,
  parseNoteSearchQuery,
  validateAndCanonicalizeNoteSearchQuery
} from "./noteSearchQuery";
import type { NoteSearchTag, NoteStructuredSearchQuery } from "../../domain/notes";
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

function queryTag(index: number): NoteSearchTag {
  return {
    prefix: index % 2 === 0 ? "#" : "@",
    normalizedTag: `tag-${index}`,
    displayTag: `Tag-${index}`
  };
}

function limitedQuery(
  overrides: Partial<NoteStructuredSearchQuery> = {}
): NoteStructuredSearchQuery {
  return {
    text: "",
    requiredTags: [],
    excludedTags: [],
    orGroups: [],
    ...overrides
  };
}

describe("structured Notes search query limits", () => {
  it("accepts 4096 UTF-8 text bytes and rejects 4097 with a stable error", () => {
    const boundaryText = `${"가".repeat(1365)}a`;
    expect(new TextEncoder().encode(boundaryText)).toHaveLength(
      NOTE_SEARCH_QUERY_LIMITS.maxTextUtf8Bytes
    );
    expect(
      validateAndCanonicalizeNoteSearchQuery(limitedQuery({ text: boundaryText }))
    ).toMatchObject({ ok: true });

    expect(
      validateAndCanonicalizeNoteSearchQuery(
        limitedQuery({ text: `${boundaryText}b` })
      )
    ).toEqual({
      ok: false,
      error: {
        code: "textTooLong",
        message: "Structured Notes search text exceeds 4096 UTF-8 bytes."
      }
    });
  });

  it("accepts 64 unique tags and rejects 65 after normalization and deduplication", () => {
    const boundaryTags = Array.from(
      { length: NOTE_SEARCH_QUERY_LIMITS.maxUniqueTagAlternatives },
      (_, index) => queryTag(index)
    );
    expect(
      validateAndCanonicalizeNoteSearchQuery(
        limitedQuery({
          requiredTags: [...boundaryTags, { ...boundaryTags[0] }]
        })
      )
    ).toMatchObject({ ok: true });

    expect(
      validateAndCanonicalizeNoteSearchQuery(
        limitedQuery({ requiredTags: [...boundaryTags, queryTag(64)] })
      )
    ).toEqual({
      ok: false,
      error: {
        code: "tooManyUniqueTags",
        message:
          "Structured Notes search has more than 64 unique tag alternatives."
      }
    });
  });

  it("accepts 16 OR groups and rejects 17 before canonical group deduplication", () => {
    const group = [queryTag(0), queryTag(1)];
    expect(
      validateAndCanonicalizeNoteSearchQuery(
        limitedQuery({
          orGroups: Array.from(
            { length: NOTE_SEARCH_QUERY_LIMITS.maxOrGroups },
            () => group.map((tag) => ({ ...tag }))
          )
        })
      )
    ).toMatchObject({ ok: true });

    expect(
      validateAndCanonicalizeNoteSearchQuery(
        limitedQuery({
          orGroups: Array.from(
            { length: NOTE_SEARCH_QUERY_LIMITS.maxOrGroups + 1 },
            () => group.map((tag) => ({ ...tag }))
          )
        })
      )
    ).toEqual({
      ok: false,
      error: {
        code: "tooManyOrGroups",
        message: "Structured Notes search has more than 16 OR groups."
      }
    });
  });

  it("accepts 16 alternatives in one OR group and rejects 17", () => {
    const alternatives = Array.from(
      { length: NOTE_SEARCH_QUERY_LIMITS.maxAlternativesPerOrGroup },
      (_, index) => queryTag(index)
    );
    expect(
      validateAndCanonicalizeNoteSearchQuery(
        limitedQuery({ orGroups: [alternatives] })
      )
    ).toMatchObject({ ok: true });

    expect(
      validateAndCanonicalizeNoteSearchQuery(
        limitedQuery({ orGroups: [[...alternatives, queryTag(16)]] })
      )
    ).toEqual({
      ok: false,
      error: {
        code: "tooManyOrAlternatives",
        message:
          "Structured Notes search OR group has more than 16 alternatives."
      }
    });
  });

  it("exposes parser validation without silently truncating the query", () => {
    const result = parseAndValidateNoteSearchQuery("x".repeat(4097));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "textTooLong" }
    });
  });

  it("validates raw parser OR shape before canonicalization can deduplicate it", () => {
    const duplicateGroups = Array.from(
      { length: NOTE_SEARCH_QUERY_LIMITS.maxOrGroups + 1 },
      () => "#one OR @two"
    ).join(" ");
    expect(parseAndValidateNoteSearchQuery(duplicateGroups)).toMatchObject({
      ok: false,
      error: { code: "tooManyOrGroups" }
    });

    const duplicateAlternatives = Array.from(
      { length: NOTE_SEARCH_QUERY_LIMITS.maxAlternativesPerOrGroup + 1 },
      () => "#same"
    ).join(" OR ");
    expect(parseAndValidateNoteSearchQuery(duplicateAlternatives)).toMatchObject({
      ok: false,
      error: { code: "tooManyOrAlternatives" }
    });
  });
});
