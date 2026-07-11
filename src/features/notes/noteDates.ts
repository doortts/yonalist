import { tokenizeNoteText } from "./noteTokens";

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export type WeekStartsOn = "monday" | "sunday";

export type NumericDateFormat =
  | "MM-DD-YYYY"
  | "MM/DD/YYYY"
  | "MM-DD-YY"
  | "MM/DD/YY"
  | "MM-DD"
  | "MM/DD";

export type NaturalDatePhrase =
  | "today"
  | "tomorrow"
  | "yesterday"
  | "this week"
  | "next week"
  | "last week"
  | "this month"
  | "next month"
  | "last month"
  | "this year"
  | "next year"
  | "last year";

export interface NumericNoteDateSource {
  readonly kind: "numeric";
  readonly startFormat: NumericDateFormat;
  readonly endFormat: NumericDateFormat | null;
}

export interface NaturalNoteDateSource {
  readonly kind: "natural";
  readonly phrase: NaturalDatePhrase;
}

export type NoteDateSource = NumericNoteDateSource | NaturalNoteDateSource;

export interface NoteDateValue {
  readonly start: LocalDate;
  readonly end: LocalDate | null;
  readonly source: NoteDateSource;
}

export interface NoteDateMatch extends NoteDateValue {
  readonly raw: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export interface NoteDateParseOptions {
  readonly today: LocalDate;
  readonly weekStartsOn?: WeekStartsOn;
}

const minimumYear = 1;
const maximumYear = 9999;
const unicodeWordCharacter = /^[\p{L}\p{N}\p{M}_]$/u;
const naturalPhrases: readonly NaturalDatePhrase[] = [
  "yesterday",
  "tomorrow",
  "this month",
  "next month",
  "last month",
  "this week",
  "next week",
  "last week",
  "this year",
  "next year",
  "last year",
  "today"
];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonthUnchecked(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11
    ? 30
    : 31;
}

export function daysInLocalMonth(year: number, month: number): number {
  if (
    !Number.isInteger(year) ||
    year < minimumYear ||
    year > maximumYear ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    throw new RangeError("year and month must identify a valid calendar month");
  }
  return daysInMonthUnchecked(year, month);
}

export function isValidLocalDate(date: LocalDate): boolean {
  return (
    Number.isInteger(date.year) &&
    date.year >= minimumYear &&
    date.year <= maximumYear &&
    Number.isInteger(date.month) &&
    date.month >= 1 &&
    date.month <= 12 &&
    Number.isInteger(date.day) &&
    date.day >= 1 &&
    date.day <= daysInMonthUnchecked(date.year, date.month)
  );
}

function assertValidLocalDate(date: LocalDate, name: string): void {
  if (!isValidLocalDate(date)) {
    throw new RangeError(`${name} must be a valid LocalDate`);
  }
}

function assertIntegerAmount(amount: number): void {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError("calendar arithmetic amount must be a safe integer");
  }
}

function daysFromCivil(date: LocalDate): number {
  let year = date.year;
  year -= date.month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const adjustedMonth = date.month + (date.month > 2 ? -3 : 9);
  const dayOfYear =
    Math.floor((153 * adjustedMonth + 2) / 5) + date.day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra;
}

function civilFromDays(serialDay: number): LocalDate {
  const era = Math.floor(serialDay / 146097);
  const dayOfEra = serialDay - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra +
      Math.floor(yearOfEra / 4) -
      Math.floor(yearOfEra / 100));
  const adjustedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day =
    dayOfYear - Math.floor((153 * adjustedMonth + 2) / 5) + 1;
  const month = adjustedMonth + (adjustedMonth < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

export function compareLocalDates(left: LocalDate, right: LocalDate): number {
  assertValidLocalDate(left, "left");
  assertValidLocalDate(right, "right");
  const difference = daysFromCivil(left) - daysFromCivil(right);
  return difference === 0 ? 0 : difference < 0 ? -1 : 1;
}

export function addLocalDateDays(date: LocalDate, amount: number): LocalDate {
  assertValidLocalDate(date, "date");
  assertIntegerAmount(amount);
  const result = civilFromDays(daysFromCivil(date) + amount);
  assertValidLocalDate(result, "result");
  return result;
}

export function addLocalDateMonths(date: LocalDate, amount: number): LocalDate {
  assertValidLocalDate(date, "date");
  assertIntegerAmount(amount);
  const absoluteMonth = (date.year - 1) * 12 + date.month - 1 + amount;
  if (absoluteMonth < 0 || absoluteMonth >= maximumYear * 12) {
    throw new RangeError("result must be a valid LocalDate");
  }
  const year = Math.floor(absoluteMonth / 12) + 1;
  const month = (absoluteMonth % 12) + 1;
  return {
    year,
    month,
    day: Math.min(date.day, daysInMonthUnchecked(year, month))
  };
}

export function addLocalDateYears(date: LocalDate, amount: number): LocalDate {
  assertIntegerAmount(amount);
  return addLocalDateMonths(date, amount * 12);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function localDayOfWeek(date: LocalDate): number {
  const unixEpoch = { year: 1970, month: 1, day: 1 };
  return positiveModulo(daysFromCivil(date) - daysFromCivil(unixEpoch) + 4, 7);
}

export function startOfLocalWeek(
  date: LocalDate,
  weekStartsOn: WeekStartsOn
): LocalDate {
  assertValidLocalDate(date, "date");
  if (weekStartsOn !== "monday" && weekStartsOn !== "sunday") {
    throw new RangeError("weekStartsOn must be monday or sunday");
  }
  const firstDay = weekStartsOn === "monday" ? 1 : 0;
  return addLocalDateDays(
    date,
    -positiveModulo(localDayOfWeek(date) - firstDay, 7)
  );
}

export function formatLocalDateIso(date: LocalDate): string {
  assertValidLocalDate(date, "date");
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(
    2,
    "0"
  )}-${String(date.day).padStart(2, "0")}`;
}

function scalarAt(source: string, offsetUtf16: number): string {
  return String.fromCodePoint(source.codePointAt(offsetUtf16)!);
}

function scalarBefore(source: string, offsetUtf16: number): string {
  let startUtf16 = offsetUtf16 - 1;
  const trailingCodeUnit = source.charCodeAt(startUtf16);
  if (
    trailingCodeUnit >= 0xdc00 &&
    trailingCodeUnit <= 0xdfff &&
    startUtf16 > 0
  ) {
    const leadingCodeUnit = source.charCodeAt(startUtf16 - 1);
    if (leadingCodeUnit >= 0xd800 && leadingCodeUnit <= 0xdbff) {
      startUtf16 -= 1;
    }
  }
  return source.slice(startUtf16, offsetUtf16);
}

function isWordCharacter(character: string): boolean {
  return unicodeWordCharacter.test(character);
}

function hasStartBoundary(source: string, startUtf16: number): boolean {
  if (startUtf16 === 0) {
    return true;
  }
  const previous = scalarBefore(source, startUtf16);
  return !isWordCharacter(previous) && previous !== "/";
}

function hasNumericStartBoundary(source: string, startUtf16: number): boolean {
  return (
    hasStartBoundary(source, startUtf16) &&
    (startUtf16 === 0 || scalarBefore(source, startUtf16) !== "-")
  );
}

function hasNaturalEndBoundary(source: string, endUtf16: number): boolean {
  return endUtf16 === source.length || !isWordCharacter(scalarAt(source, endUtf16));
}

function hasNumericEndBoundary(source: string, endUtf16: number): boolean {
  if (endUtf16 === source.length) {
    return true;
  }
  const next = scalarAt(source, endUtf16);
  return !isWordCharacter(next) && next !== "/" && next !== "-";
}

function isAsciiDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function readTwoDigits(source: string, startUtf16: number): number | null {
  const first = source[startUtf16];
  const second = source[startUtf16 + 1];
  return isAsciiDigit(first) && isAsciiDigit(second)
    ? Number(first) * 10 + Number(second)
    : null;
}

interface NumericCandidate {
  readonly month: number;
  readonly day: number;
  readonly explicitYear: number | null;
  readonly format: NumericDateFormat;
  readonly endUtf16: number;
}

function readYearlessNumericCandidate(
  source: string,
  startUtf16: number,
  limitUtf16: number
): NumericCandidate | null {
  if (startUtf16 + 5 > limitUtf16) {
    return null;
  }
  const month = readTwoDigits(source, startUtf16);
  const separator = source[startUtf16 + 2];
  const day = readTwoDigits(source, startUtf16 + 3);
  if (
    month === null ||
    day === null ||
    (separator !== "-" && separator !== "/")
  ) {
    return null;
  }

  return {
    month,
    day,
    explicitYear: null,
    format: separator === "-" ? "MM-DD" : "MM/DD",
    endUtf16: startUtf16 + 5
  };
}

function readNumericCandidate(
  source: string,
  startUtf16: number,
  limitUtf16: number
): NumericCandidate | null {
  const yearlessCandidate = readYearlessNumericCandidate(
    source,
    startUtf16,
    limitUtf16
  );
  if (yearlessCandidate === null) {
    return null;
  }

  const separator = source[startUtf16 + 2];
  const yearSeparatorUtf16 = yearlessCandidate.endUtf16;
  if (source[yearSeparatorUtf16] !== separator) {
    return yearlessCandidate;
  }

  let yearEndUtf16 = yearSeparatorUtf16 + 1;
  while (yearEndUtf16 < limitUtf16 && isAsciiDigit(source[yearEndUtf16])) {
    yearEndUtf16 += 1;
  }
  const yearLength = yearEndUtf16 - yearSeparatorUtf16 - 1;
  if (yearLength !== 2 && yearLength !== 4) {
    return null;
  }
  const yearText = source.slice(yearSeparatorUtf16 + 1, yearEndUtf16);
  const explicitYear =
    yearLength === 2 ? 2000 + Number(yearText) : Number(yearText);
  const format: NumericDateFormat =
    separator === "-"
      ? yearLength === 2
        ? "MM-DD-YY"
        : "MM-DD-YYYY"
      : yearLength === 2
        ? "MM/DD/YY"
        : "MM/DD/YYYY";
  return {
    month: yearlessCandidate.month,
    day: yearlessCandidate.day,
    explicitYear,
    format,
    endUtf16: yearEndUtf16
  };
}

function resolveCandidate(
  candidate: NumericCandidate,
  year: number
): LocalDate | null {
  const date = { year, month: candidate.month, day: candidate.day };
  return isValidLocalDate(date) ? date : null;
}

function canInferYearBoundary(
  startCandidate: NumericCandidate,
  endCandidate: NumericCandidate
): boolean {
  return startCandidate.month === 12 && endCandidate.month === 1;
}

function resolveNumericRange(
  startCandidate: NumericCandidate,
  endCandidate: NumericCandidate,
  todayYear: number
): { start: LocalDate; end: LocalDate } | null {
  let startYear = startCandidate.explicitYear;
  let endYear = endCandidate.explicitYear;
  const mayCrossYear = canInferYearBoundary(startCandidate, endCandidate);

  if (startYear === null && endYear === null) {
    startYear = todayYear;
    endYear = todayYear;
    const sameYearStart = resolveCandidate(startCandidate, startYear);
    const sameYearEnd = resolveCandidate(endCandidate, endYear);
    if (
      sameYearStart !== null &&
      sameYearEnd !== null &&
      compareLocalDates(sameYearEnd, sameYearStart) < 0 &&
      mayCrossYear
    ) {
      endYear += 1;
    }
  } else if (startYear !== null && endYear === null) {
    endYear = startYear;
    const sameYearStart = resolveCandidate(startCandidate, startYear);
    const sameYearEnd = resolveCandidate(endCandidate, endYear);
    if (
      sameYearStart !== null &&
      sameYearEnd !== null &&
      compareLocalDates(sameYearEnd, sameYearStart) < 0 &&
      mayCrossYear
    ) {
      endYear += 1;
    }
  } else if (startYear === null && endYear !== null) {
    startYear = endYear;
    const sameYearStart = resolveCandidate(startCandidate, startYear);
    const sameYearEnd = resolveCandidate(endCandidate, endYear);
    if (
      sameYearStart !== null &&
      sameYearEnd !== null &&
      compareLocalDates(sameYearStart, sameYearEnd) > 0 &&
      mayCrossYear
    ) {
      startYear -= 1;
    }
  }

  const start = resolveCandidate(startCandidate, startYear!);
  const end = resolveCandidate(endCandidate, endYear!);
  if (start === null || end === null || compareLocalDates(start, end) > 0) {
    return null;
  }
  return { start, end };
}

interface InternalMatch extends NoteDateValue {
  readonly endUtf16: number;
}

interface RejectedNumericSpan {
  readonly rejected: true;
  readonly endUtf16: number;
}

function tryNumericRangeMatch(
  source: string,
  startCandidate: NumericCandidate,
  limitUtf16: number,
  todayYear: number
): InternalMatch | RejectedNumericSpan | null {
  let separatorUtf16 = startCandidate.endUtf16;
  while (
    separatorUtf16 < limitUtf16 &&
    (source[separatorUtf16] === " " || source[separatorUtf16] === "\t")
  ) {
    separatorUtf16 += 1;
  }
  if (source[separatorUtf16] === "-") {
    const hasWhitespaceBeforeSeparator =
      separatorUtf16 > startCandidate.endUtf16;
    let endStartUtf16 = separatorUtf16 + 1;
    while (
      endStartUtf16 < limitUtf16 &&
      (source[endStartUtf16] === " " || source[endStartUtf16] === "\t")
    ) {
      endStartUtf16 += 1;
    }
    const hasWhitespaceAfterSeparator = endStartUtf16 > separatorUtf16 + 1;
    const endCandidate = readNumericCandidate(
      source,
      endStartUtf16,
      limitUtf16
    );
    if (
      endCandidate !== null &&
      hasNumericEndBoundary(source, endCandidate.endUtf16)
    ) {
      if (hasWhitespaceBeforeSeparator && hasWhitespaceAfterSeparator) {
        const range = resolveNumericRange(
          startCandidate,
          endCandidate,
          todayYear
        );
        if (range !== null) {
          return {
            ...range,
            source: {
              kind: "numeric",
              startFormat: startCandidate.format,
              endFormat: endCandidate.format
            },
            endUtf16: endCandidate.endUtf16
          };
        }
      }
      return { rejected: true, endUtf16: endCandidate.endUtf16 };
    }
  }
  return null;
}

function tryNumericMatch(
  source: string,
  startUtf16: number,
  limitUtf16: number,
  todayYear: number
): InternalMatch | RejectedNumericSpan | null {
  if (!hasNumericStartBoundary(source, startUtf16)) {
    return null;
  }
  const yearlessCandidate = readYearlessNumericCandidate(
    source,
    startUtf16,
    limitUtf16
  );
  if (yearlessCandidate === null) {
    return null;
  }
  const yearlessRange = tryNumericRangeMatch(
    source,
    yearlessCandidate,
    limitUtf16,
    todayYear
  );
  if (yearlessRange !== null) {
    return yearlessRange;
  }

  const startCandidate = readNumericCandidate(source, startUtf16, limitUtf16);
  if (startCandidate === null) {
    return null;
  }
  if (startCandidate.endUtf16 !== yearlessCandidate.endUtf16) {
    const explicitYearRange = tryNumericRangeMatch(
      source,
      startCandidate,
      limitUtf16,
      todayYear
    );
    if (explicitYearRange !== null) {
      return explicitYearRange;
    }
  }

  if (!hasNumericEndBoundary(source, startCandidate.endUtf16)) {
    return null;
  }
  const start = resolveCandidate(
    startCandidate,
    startCandidate.explicitYear ?? todayYear
  );
  return start === null
    ? null
    : {
        start,
        end: null,
        source: {
          kind: "numeric",
          startFormat: startCandidate.format,
          endFormat: null
        },
        endUtf16: startCandidate.endUtf16
      };
}

function resolveNaturalPhrase(
  phrase: NaturalDatePhrase,
  today: LocalDate,
  weekStartsOn: WeekStartsOn
): Omit<NoteDateValue, "source"> | null {
  try {
    if (phrase === "today") {
      return { start: today, end: null };
    }
    if (phrase === "tomorrow" || phrase === "yesterday") {
      return {
        start: addLocalDateDays(today, phrase === "tomorrow" ? 1 : -1),
        end: null
      };
    }

    const [relative, period] = phrase.split(" ") as [
      "this" | "next" | "last",
      "week" | "month" | "year"
    ];
    const offset = relative === "this" ? 0 : relative === "next" ? 1 : -1;
    if (period === "week") {
      const start = addLocalDateDays(
        startOfLocalWeek(today, weekStartsOn),
        offset * 7
      );
      return { start, end: addLocalDateDays(start, 6) };
    }
    if (period === "month") {
      const start = addLocalDateMonths(
        { year: today.year, month: today.month, day: 1 },
        offset
      );
      return {
        start,
        end: {
          year: start.year,
          month: start.month,
          day: daysInMonthUnchecked(start.year, start.month)
        }
      };
    }
    const year = today.year + offset;
    const start = { year, month: 1, day: 1 };
    const end = { year, month: 12, day: 31 };
    return isValidLocalDate(start) && isValidLocalDate(end)
      ? { start, end }
      : null;
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}

function tryNaturalMatch(
  source: string,
  startUtf16: number,
  limitUtf16: number,
  today: LocalDate,
  weekStartsOn: WeekStartsOn
): InternalMatch | null {
  if (!hasStartBoundary(source, startUtf16)) {
    return null;
  }
  for (const phrase of naturalPhrases) {
    const endUtf16 = startUtf16 + phrase.length;
    if (
      endUtf16 > limitUtf16 ||
      source.slice(startUtf16, endUtf16).toLowerCase() !== phrase ||
      !hasNaturalEndBoundary(source, endUtf16)
    ) {
      continue;
    }
    const resolved = resolveNaturalPhrase(phrase, today, weekStartsOn);
    if (resolved === null) {
      return null;
    }
    return {
      ...resolved,
      source: { kind: "natural", phrase },
      endUtf16
    };
  }
  return null;
}

export function findNoteDateMatches(
  source: string,
  options: NoteDateParseOptions
): readonly NoteDateMatch[] {
  assertValidLocalDate(options.today, "today");
  const weekStartsOn = options.weekStartsOn ?? "monday";
  if (weekStartsOn !== "monday" && weekStartsOn !== "sunday") {
    throw new RangeError("weekStartsOn must be monday or sunday");
  }

  const matches: NoteDateMatch[] = [];
  for (const token of tokenizeNoteText(source)) {
    if (token.kind !== "text") {
      continue;
    }
    let offsetUtf16 = token.startUtf16;
    while (offsetUtf16 < token.endUtf16) {
      const character = scalarAt(source, offsetUtf16);
      const match = isAsciiDigit(character)
        ? tryNumericMatch(
            source,
            offsetUtf16,
            token.endUtf16,
            options.today.year
          )
        : tryNaturalMatch(
            source,
            offsetUtf16,
            token.endUtf16,
            options.today,
            weekStartsOn
          );
      if (match === null) {
        offsetUtf16 += character.length;
        continue;
      }
      if ("rejected" in match) {
        offsetUtf16 = match.endUtf16;
        continue;
      }
      matches.push({
        start: match.start,
        end: match.end,
        source: match.source,
        raw: source.slice(offsetUtf16, match.endUtf16),
        startUtf16: offsetUtf16,
        endUtf16: match.endUtf16
      });
      offsetUtf16 = match.endUtf16;
    }
  }
  return matches;
}

export function parseNoteDateExpression(
  input: string,
  options: NoteDateParseOptions
): NoteDateValue | null {
  const trimmedStartUtf16 = input.length - input.trimStart().length;
  const trimmedEndUtf16 = input.trimEnd().length;
  if (trimmedStartUtf16 === trimmedEndUtf16) {
    return null;
  }
  const matches = findNoteDateMatches(input, options);
  if (
    matches.length !== 1 ||
    matches[0].startUtf16 !== trimmedStartUtf16 ||
    matches[0].endUtf16 !== trimmedEndUtf16
  ) {
    return null;
  }
  return {
    start: matches[0].start,
    end: matches[0].end,
    source: matches[0].source
  };
}
