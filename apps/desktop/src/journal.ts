import type { PageSummary } from "../../../packages/contracts/generated/PageSummary";

/**
 * A journal day is a page whose title is a date and nothing else. Nothing is
 * stored to say so: the title is the whole record, which is why a vault folder
 * (`2026-08-21-<yid>`) still says which day it holds when read on its own, and
 * why a page renamed to a date becomes that day's journal.
 */
export interface JournalDay {
  readonly id: string;
  readonly date: string;
}

/**
 * `YYYY-MM-DD`, zero-padded. The padding is not cosmetic: journal days are
 * ordered by comparing these strings, and `2026-8-1` sorts before `2026-10-01`
 * as text while coming after it in the year.
 */
export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // A day past the end of its month rolls into the next one, which is how
  // 2026-02-30 gives itself away. The year is compared too: `Date.UTC` reads a
  // two-digit year as 19xx, so 0050-01-01 would otherwise pass as itself.
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** The day this title names, or `null` if the title is not a date. */
export function journalDateOf(title: string): string | null {
  const trimmed = title.trim();
  return isValidIsoDate(trimmed) ? trimmed : null;
}

/**
 * The journals among the pages, newest first. Two pages can claim one day --
 * two devices can each make it before they have seen each other -- and both
 * stay in the list, side by side, for a person to merge.
 */
export function journalDays(pages: readonly PageSummary[]): readonly JournalDay[] {
  const days: JournalDay[] = [];
  for (const page of pages) {
    const date = journalDateOf(page.title);
    if (date) days.push({ id: page.id, date });
  }
  return days.sort((left, right) => right.date.localeCompare(left.date));
}

/**
 * The page a day is written on. Where two claim it, the one the page list puts
 * first wins, so the choice is the same on every open until somebody merges
 * them.
 */
export function findJournalPage(
  pages: readonly PageSummary[],
  date: string
): PageSummary | undefined {
  return pages.find((page) => journalDateOf(page.title) === date);
}

/** The day `days` away from this one. */
export function shiftDay(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return [
    String(shifted.getUTCFullYear()).padStart(4, "0"),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-");
}

/**
 * The day's name in the reader's own language. The date itself is the identity
 * and never moves; this is only what sits beside it.
 */
export function weekdayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  // Read back in UTC, the zone it was built in: west of Greenwich a UTC
  // midnight is still the day before locally, and the name would slip a day.
  return new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}
