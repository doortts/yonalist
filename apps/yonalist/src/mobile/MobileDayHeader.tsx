import { shiftDay, weekdayOf } from "../journal";
import { MobileIcon } from "./MobileIcon";

/**
 * `Aug 21, 2026` — a day named the way a calendar names it.
 *
 * Read back in UTC, the zone it was built in, for the same reason `weekdayOf`
 * is: west of Greenwich a UTC midnight is still the day before locally, and
 * the date would slip by one.
 */
function dayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * What a day carries above its rows on a phone: which day it is, and the two
 * days either side.
 *
 * The steps name dates rather than pages, because a day is always there to be
 * walked to whether or not anything has been written on it. The desktop's own
 * bar says the same things in a row across the top; here the date is the
 * heading, since the phone has no window title to carry it.
 */
export function MobileDayHeader({
  date,
  today,
  onOpenDay
}: {
  readonly date: string;
  /** Today, so the day can say when it is the one being lived. */
  readonly today: string;
  readonly onOpenDay: (date: string) => void;
}) {
  const previous = shiftDay(date, -1);
  const next = shiftDay(date, 1);
  return (
    <header className="mobile-day-header">
      <div className="mobile-day-names">
        <h1 className="mobile-day-date">{dayLabel(date)}</h1>
        <p className="mobile-day-weekday">
          {weekdayOf(date)}
          {date === today && <span className="mobile-day-today"> · Today</span>}
        </p>
      </div>
      <button
        className="mobile-day-step"
        type="button"
        aria-label={`Previous day, ${previous}`}
        onClick={() => onOpenDay(previous)}
      >
        <MobileIcon name="chevron-left" size={18} />
      </button>
      <button
        className="mobile-day-step"
        type="button"
        aria-label={`Next day, ${next}`}
        onClick={() => onOpenDay(next)}
      >
        <MobileIcon name="chevron-right" size={18} />
      </button>
    </header>
  );
}
