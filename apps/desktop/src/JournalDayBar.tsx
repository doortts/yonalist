import { ChevronLeft, ChevronRight } from "lucide-react";
import type { NotesStore } from "./notesStore";
import { journalDateOf, shiftDay, weekdayOf } from "./journal";
import { useNotesNode } from "./useNotesNode";

/** `8/23`, the short way a day is named when it is only a direction. */
function shortDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric", day: "numeric", timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * What a day page carries above its rows: what day of the week it is, and the
 * two days either side of it. A day is always there to be walked to, whether or
 * not anything has been written on it -- which is why the buttons name dates
 * rather than pages.
 */
export function JournalDayBar({
  store,
  pageId,
  onOpenDay
}: {
  readonly store: NotesStore;
  readonly pageId: string;
  readonly onOpenDay: (date: string) => void;
}) {
  const date = journalDateOf(useNotesNode(store, pageId).title);
  if (!date) return null;
  const previous = shiftDay(date, -1);
  const next = shiftDay(date, 1);
  return (
    <div className="notes-journal-day-bar" role="group" aria-label={`Day ${date}`}>
      <span className="notes-journal-day-bar-weekday">{weekdayOf(date)}</span>
      <span className="notes-journal-day-bar-spacer" />
      <button
        className="notes-journal-day-step"
        type="button"
        aria-label={`Previous day, ${previous}`}
        onClick={() => onOpenDay(previous)}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        <span>{shortDay(previous)}</span>
      </button>
      <button
        className="notes-journal-day-step"
        type="button"
        aria-label={`Next day, ${next}`}
        onClick={() => onOpenDay(next)}
      >
        <span>{shortDay(next)}</span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
