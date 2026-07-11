import { afterEach, describe, expect, it, vi } from "vitest";
import noteDateFixtures from "./noteDateFixtures.json";
import {
  addLocalDateDays,
  addLocalDateMonths,
  addLocalDateYears,
  compareLocalDates,
  daysInLocalMonth,
  findNoteDateMatches,
  formatLocalDateIso,
  isValidLocalDate,
  parseNoteDateExpression,
  startOfLocalWeek,
  type LocalDate,
  type NaturalDatePhrase,
  type NoteDateValue,
  type NumericDateFormat
} from "./noteDates";

const today: LocalDate = { year: 2026, month: 7, day: 11 };

function localDateFromIso(value: string): LocalDate {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function numericValue(
  start: LocalDate,
  format: NumericDateFormat,
  end: LocalDate | null = null,
  endFormat: NumericDateFormat | null = null
): NoteDateValue {
  return {
    start,
    end,
    source: {
      kind: "numeric",
      startFormat: format,
      endFormat
    }
  };
}

function naturalValue(
  phrase: NaturalDatePhrase,
  start: LocalDate,
  end: LocalDate | null = null
): NoteDateValue {
  return {
    start,
    end,
    source: { kind: "natural", phrase }
  };
}

describe("LocalDate calendar arithmetic", () => {
  it("validates proleptic Gregorian local dates without constructing instants", () => {
    expect(daysInLocalMonth(2024, 2)).toBe(29);
    expect(daysInLocalMonth(2100, 2)).toBe(28);
    expect(isValidLocalDate({ year: 2024, month: 2, day: 29 })).toBe(true);
    expect(isValidLocalDate({ year: 2023, month: 2, day: 29 })).toBe(false);
    expect(isValidLocalDate({ year: 2026, month: 4, day: 31 })).toBe(false);
    expect(isValidLocalDate({ year: 0, month: 1, day: 1 })).toBe(false);
  });

  it("adds days across month, year, and leap-day boundaries", () => {
    expect(addLocalDateDays({ year: 2024, month: 2, day: 28 }, 1)).toEqual({
      year: 2024,
      month: 2,
      day: 29
    });
    expect(addLocalDateDays({ year: 2024, month: 2, day: 28 }, 2)).toEqual({
      year: 2024,
      month: 3,
      day: 1
    });
    expect(addLocalDateDays({ year: 2027, month: 1, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 12,
      day: 31
    });
  });

  it("clamps month and year navigation to the target calendar month", () => {
    expect(addLocalDateMonths({ year: 2024, month: 1, day: 31 }, 1)).toEqual({
      year: 2024,
      month: 2,
      day: 29
    });
    expect(addLocalDateMonths({ year: 2024, month: 3, day: 31 }, -1)).toEqual({
      year: 2024,
      month: 2,
      day: 29
    });
    expect(addLocalDateYears({ year: 2024, month: 2, day: 29 }, 1)).toEqual({
      year: 2025,
      month: 2,
      day: 28
    });
  });

  it("supports explicit Monday and Sunday week starts", () => {
    const thursday = { year: 2026, month: 12, day: 31 };

    expect(startOfLocalWeek(thursday, "monday")).toEqual({
      year: 2026,
      month: 12,
      day: 28
    });
    expect(startOfLocalWeek(thursday, "sunday")).toEqual({
      year: 2026,
      month: 12,
      day: 27
    });
  });

  it("compares and serializes LocalDate values for portable fixtures", () => {
    expect(
      compareLocalDates(
        { year: 2026, month: 7, day: 11 },
        { year: 2026, month: 7, day: 12 }
      )
    ).toBe(-1);
    expect(formatLocalDateIso({ year: 26, month: 2, day: 3 })).toBe(
      "0026-02-03"
    );
  });
});

describe("parseNoteDateExpression", () => {
  it.each<[
    string,
    NumericDateFormat,
    LocalDate
  ]>([
    ["07-11-2026", "MM-DD-YYYY", { year: 2026, month: 7, day: 11 }],
    ["07/11/2026", "MM/DD/YYYY", { year: 2026, month: 7, day: 11 }],
    ["07-11-26", "MM-DD-YY", { year: 2026, month: 7, day: 11 }],
    ["07/11/26", "MM/DD/YY", { year: 2026, month: 7, day: 11 }],
    ["07-11", "MM-DD", { year: 2026, month: 7, day: 11 }],
    ["07/11", "MM/DD", { year: 2026, month: 7, day: 11 }]
  ])("parses the official numeric form %s", (input, format, expected) => {
    expect(parseNoteDateExpression(input, { today })).toEqual(
      numericValue(expected, format)
    );
  });

  it("maps two-digit years to 2000-2099 deterministically", () => {
    expect(parseNoteDateExpression("01/02/00", { today })).toEqual(
      numericValue(
        { year: 2000, month: 1, day: 2 },
        "MM/DD/YY"
      )
    );
    expect(parseNoteDateExpression("01/02/99", { today })).toEqual(
      numericValue(
        { year: 2099, month: 1, day: 2 },
        "MM/DD/YY"
      )
    );
  });

  it.each([
    "02/29/2023",
    "02/29",
    "04/31/2026",
    "13/01/2026",
    "00/10/2026",
    "07/00/2026",
    "0007/11/2026",
    "7/11/2026",
    "07/1/2026",
    "07-11/2026",
    "07/11/202",
    "07/11/"
  ])("rejects invalid or malformed numeric input %j", (input) => {
    expect(parseNoteDateExpression(input, { today })).toBeNull();
  });

  it("accepts leap day only when the resolved local year is a leap year", () => {
    expect(
      parseNoteDateExpression("02/29", {
        today: { year: 2024, month: 1, day: 1 }
      })
    ).toEqual(
      numericValue({ year: 2024, month: 2, day: 29 }, "MM/DD")
    );
    expect(parseNoteDateExpression("02/29/2024", { today })).toEqual(
      numericValue({ year: 2024, month: 2, day: 29 }, "MM/DD/YYYY")
    );
  });

  it.each<[NaturalDatePhrase, LocalDate, LocalDate | null]>([
    ["today", { year: 2026, month: 12, day: 31 }, null],
    ["tomorrow", { year: 2027, month: 1, day: 1 }, null],
    ["yesterday", { year: 2026, month: 12, day: 30 }, null],
    [
      "this week",
      { year: 2026, month: 12, day: 28 },
      { year: 2027, month: 1, day: 3 }
    ],
    [
      "next week",
      { year: 2027, month: 1, day: 4 },
      { year: 2027, month: 1, day: 10 }
    ],
    [
      "last week",
      { year: 2026, month: 12, day: 21 },
      { year: 2026, month: 12, day: 27 }
    ],
    [
      "this month",
      { year: 2026, month: 12, day: 1 },
      { year: 2026, month: 12, day: 31 }
    ],
    [
      "next month",
      { year: 2027, month: 1, day: 1 },
      { year: 2027, month: 1, day: 31 }
    ],
    [
      "last month",
      { year: 2026, month: 11, day: 1 },
      { year: 2026, month: 11, day: 30 }
    ],
    [
      "this year",
      { year: 2026, month: 1, day: 1 },
      { year: 2026, month: 12, day: 31 }
    ],
    [
      "next year",
      { year: 2027, month: 1, day: 1 },
      { year: 2027, month: 12, day: 31 }
    ],
    [
      "last year",
      { year: 2025, month: 1, day: 1 },
      { year: 2025, month: 12, day: 31 }
    ]
  ])("resolves the official phrase %s", (phrase, start, end) => {
    expect(
      parseNoteDateExpression(phrase, {
        today: { year: 2026, month: 12, day: 31 },
        weekStartsOn: "monday"
      })
    ).toEqual(naturalValue(phrase, start, end));
  });

  it("matches official phrases case-insensitively but rejects broader NLP", () => {
    expect(parseNoteDateExpression("  NeXt MoNtH  ", { today })).toEqual(
      naturalValue(
        "next month",
        { year: 2026, month: 8, day: 1 },
        { year: 2026, month: 8, day: 31 }
      )
    );
    expect(parseNoteDateExpression("in two days", { today })).toBeNull();
    expect(parseNoteDateExpression("next quarter", { today })).toBeNull();
    expect(parseNoteDateExpression("todayish", { today })).toBeNull();
  });

  it("uses the injected week start when resolving week periods", () => {
    expect(
      parseNoteDateExpression("this week", {
        today: { year: 2026, month: 12, day: 31 },
        weekStartsOn: "sunday"
      })
    ).toEqual(
      naturalValue(
        "this week",
        { year: 2026, month: 12, day: 27 },
        { year: 2027, month: 1, day: 2 }
      )
    );
  });

  it("parses explicit inclusive ranges and preserves both source formats", () => {
    expect(
      parseNoteDateExpression("07/11/2026 - 07-14-26", { today })
    ).toEqual(
      numericValue(
        { year: 2026, month: 7, day: 11 },
        "MM/DD/YYYY",
        { year: 2026, month: 7, day: 14 },
        "MM-DD-YY"
      )
    );
  });

  it("infers omitted range years across a calendar-year boundary", () => {
    expect(parseNoteDateExpression("12/31 - 01/02", { today })).toEqual(
      numericValue(
        { year: 2026, month: 12, day: 31 },
        "MM/DD",
        { year: 2027, month: 1, day: 2 },
        "MM/DD"
      )
    );
    expect(
      parseNoteDateExpression("12/31/2026 - 01/02", { today })
    ).toEqual(
      numericValue(
        { year: 2026, month: 12, day: 31 },
        "MM/DD/YYYY",
        { year: 2027, month: 1, day: 2 },
        "MM/DD"
      )
    );
    expect(
      parseNoteDateExpression("12/31 - 01/02/2027", { today })
    ).toEqual(
      numericValue(
        { year: 2026, month: 12, day: 31 },
        "MM/DD",
        { year: 2027, month: 1, day: 2 },
        "MM/DD/YYYY"
      )
    );
  });

  it.each([
    "07/14 - 07/11",
    "07-14 - 07-11",
    "07/14/2026 - 07/11",
    "07/14 - 07/11/2026",
    "11/30 - 01/02"
  ])("rejects ambiguous inferred-year range %s without partial matches", (input) => {
    expect(parseNoteDateExpression(input, { today })).toBeNull();
    expect(findNoteDateMatches(input, { today })).toEqual([]);
  });

  it("rejects reversed explicit ranges and range syntax without spacing", () => {
    expect(
      parseNoteDateExpression("07/14/2026 - 07/11/2026", { today })
    ).toBeNull();
    expect(parseNoteDateExpression("07/11-07/14", { today })).toBeNull();
  });

  it("never reads the runtime clock or timezone", () => {
    vi.stubGlobal(
      "Date",
      class {
        constructor() {
          throw new Error("Date instants are forbidden");
        }
      }
    );

    expect(parseNoteDateExpression("tomorrow", { today })).toEqual(
      naturalValue("tomorrow", { year: 2026, month: 7, day: 12 })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe("findNoteDateMatches", () => {
  it.each(noteDateFixtures)("matches shared fixture: $name", (fixture) => {
    const matches = findNoteDateMatches(fixture.source, {
      today: localDateFromIso(fixture.today),
      weekStartsOn: fixture.weekStartsOn as "monday" | "sunday"
    }).map((match) => ({
      raw: match.raw,
      startUtf16: match.startUtf16,
      endUtf16: match.endUtf16,
      normalizedStart: formatLocalDateIso(match.start),
      normalizedEnd: formatLocalDateIso(match.end ?? match.start)
    }));

    expect(matches).toEqual(fixture.matches);
  });

  const yearlessEndpointFormats = [
    ["/", "MM/DD"],
    ["-", "MM-DD"]
  ] as const;
  const malformedSpacing = [
    ["zero", "", ""],
    ["left-only", " ", ""],
    ["right-only", "", " "]
  ] as const;
  const malformedRangeCases = yearlessEndpointFormats.flatMap(
    ([startDelimiter]) =>
      yearlessEndpointFormats.flatMap(([endDelimiter]) =>
        malformedSpacing.map(([spacing, before, after]) => [
          `${spacing} ${startDelimiter}/${endDelimiter}`,
          `07${startDelimiter}11${before}-${after}07${endDelimiter}14`
        ] as const)
      )
  );
  const validRangeCases = yearlessEndpointFormats.flatMap(
    ([startDelimiter, startFormat]) =>
      yearlessEndpointFormats.map(([endDelimiter, endFormat]) => [
        `07${startDelimiter}11 - 07${endDelimiter}14`,
        startFormat,
        endFormat
      ] as const)
  );

  it.each(malformedRangeCases)(
    "rejects malformed yearless range matrix case %s: %s",
    (_label, source) => {
      expect(parseNoteDateExpression(source, { today })).toBeNull();
      expect(findNoteDateMatches(source, { today })).toEqual([]);
    }
  );

  it.each(validRangeCases)(
    "parses fully spaced yearless range %s",
    (source, startFormat, endFormat) => {
      const value = numericValue(
        { year: 2026, month: 7, day: 11 },
        startFormat,
        { year: 2026, month: 7, day: 14 },
        endFormat
      );

      expect(parseNoteDateExpression(source, { today })).toEqual(value);
      expect(findNoteDateMatches(source, { today })).toEqual([
        {
          ...value,
          raw: source,
          startUtf16: 0,
          endUtf16: source.length
        }
      ]);
    }
  );

  it("returns ordered half-open UTF-16 source offsets", () => {
    const source = "😀 due 07/11/2026, then TOMORROW.";
    const matches = findNoteDateMatches(source, { today });

    expect(matches).toEqual([
      {
        ...numericValue(
          { year: 2026, month: 7, day: 11 },
          "MM/DD/YYYY"
        ),
        raw: "07/11/2026",
        startUtf16: source.indexOf("07/11/2026"),
        endUtf16: source.indexOf("07/11/2026") + "07/11/2026".length
      },
      {
        ...naturalValue("tomorrow", { year: 2026, month: 7, day: 12 }),
        raw: "TOMORROW",
        startUtf16: source.indexOf("TOMORROW"),
        endUtf16: source.indexOf("TOMORROW") + "TOMORROW".length
      }
    ]);
    for (const match of matches) {
      expect(source.slice(match.startUtf16, match.endUtf16)).toBe(match.raw);
    }
  });

  it("returns a numeric range as one stable source match", () => {
    const source = "Plan 😀 12/31 - 01/02, then next month";
    const matches = findNoteDateMatches(source, { today });

    expect(matches).toEqual([
      {
        ...numericValue(
          { year: 2026, month: 12, day: 31 },
          "MM/DD",
          { year: 2027, month: 1, day: 2 },
          "MM/DD"
        ),
        raw: "12/31 - 01/02",
        startUtf16: source.indexOf("12/31"),
        endUtf16: source.indexOf("12/31") + "12/31 - 01/02".length
      },
      {
        ...naturalValue(
          "next month",
          { year: 2026, month: 8, day: 1 },
          { year: 2026, month: 8, day: 31 }
        ),
        raw: "next month",
        startUtf16: source.indexOf("next month"),
        endUtf16: source.indexOf("next month") + "next month".length
      }
    ]);
  });

  it("does not interpret hashtag or mention tokens as dates", () => {
    const source =
      "#today @tomorrow #07-11-2026 @07/12/26 plain today 07/13/2026";

    expect(
      findNoteDateMatches(source, { today }).map((match) => match.raw)
    ).toEqual(["today", "07/13/2026"]);
  });

  it("skips invalid candidates and embedded word or numeric fragments", () => {
    const source =
      "todayish x07/11/2026 0007/11/2026 02/29/2023 then yesterday";

    expect(
      findNoteDateMatches(source, { today }).map((match) => match.raw)
    ).toEqual(["yesterday"]);
  });

  it("requires a valid injected today value", () => {
    expect(() =>
      findNoteDateMatches("today", {
        today: { year: 2026, month: 2, day: 29 }
      })
    ).toThrowError("today must be a valid LocalDate");
  });
});
