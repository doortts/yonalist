import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { JournalDay } from "./journal";
import { monthGrid, monthLabel, monthOf, shiftMonth } from "./journal";

/**
 * The letters over the columns, in the reader's own language, starting on the
 * Sunday the grid starts on.
 */
function weekdayInitials(): readonly string[] {
  const format = new Intl.DateTimeFormat(undefined, {
    weekday: "narrow", timeZone: "UTC"
  });
  // 2026-08-02 is a Sunday, and only the weekday of these dates is read.
  return Array.from({ length: 7 }, (_, day) =>
    format.format(new Date(Date.UTC(2026, 7, 2 + day))));
}

/**
 * One month, with the days that have been written in marked. Pressing a day
 * opens it whether or not it has a page: a day with nothing on it is where the
 * writing starts, and opening it still writes nothing.
 */
export function JournalCalendar({
  days,
  today,
  onOpenDay
}: {
  readonly days: readonly JournalDay[];
  readonly today: string;
  readonly onOpenDay: (date: string) => void;
}) {
  const [month, setMonth] = useState(() => monthOf(today));
  const written = useMemo(
    () => new Set(days.map((day) => day.date)),
    [days]
  );
  const cells = useMemo(() => monthGrid(month), [month]);
  const initials = useMemo(weekdayInitials, []);
  return (
    <div
      className="notes-journal-calendar"
      role="group"
      aria-label="Journal calendar"
    >
      <div className="notes-journal-calendar-head">
        <button
          className="notes-journal-calendar-step"
          type="button"
          aria-label="Previous month"
          onClick={() => setMonth((current) => shiftMonth(current, -1))}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <span className="notes-journal-calendar-month">
          {monthLabel(month)}
        </span>
        <button
          className="notes-journal-calendar-step"
          type="button"
          aria-label="Next month"
          onClick={() => setMonth((current) => shiftMonth(current, 1))}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="notes-journal-calendar-grid">
        {initials.map((initial, index) => (
          <span
            className="notes-journal-calendar-weekday"
            key={`weekday-${index}`}
            aria-hidden="true"
          >
            {initial}
          </span>
        ))}
        {cells.map((date, index) => date === null
          ? <span key={`blank-${index}`} />
          : (
            <button
              className="notes-journal-calendar-day"
              type="button"
              key={date}
              aria-label={date}
              aria-current={date === today ? "date" : undefined}
              data-journal={written.has(date) ? "true" : undefined}
              onClick={() => onOpenDay(date)}
            >
              {Number(date.slice(8))}
            </button>
          ))}
      </div>
    </div>
  );
}
