import { ArrowDownToLine, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import { journalDays, shiftDay, weekdayOf } from "./journal";
import { carryOverDays, carryOverRows } from "./journalCarryOver";

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
  date,
  onOpenDay,
  onCarryRows,
  today
}: {
  readonly store: NotesStore;
  readonly pageId: string;
  readonly date: string;
  readonly onOpenDay: (date: string) => void;
  readonly onCarryRows: (
    pageId: string,
    rowIds: readonly string[]
  ) => Promise<void>;
  /** Today, so the day can say when it is the one being lived. */
  readonly today: string;
}) {
  // Two pieces of the same state: how many carry-overs have settled, and
  // whether one is in flight. The button goes quiet while it is, so a second
  // press cannot move rows that are already on their way here.
  const [carried, setCarried] = useState(0);
  const [carrying, setCarrying] = useState(false);
  const rows = useCarryOverRows(store, date, pageId, carried);
  const previous = shiftDay(date, -1);
  const next = shiftDay(date, 1);
  return (
    <div className="notes-journal-day-bar" role="group" aria-label={`Day ${date}`}>
      <span className="notes-journal-day-bar-weekday">{weekdayOf(date)}</span>
      {date === today && (
        <span className="notes-journal-today-chip">Today</span>
      )}
      <span className="notes-journal-day-bar-spacer" />
      {rows.length > 0 && (
        <button
          className="notes-journal-carry"
          type="button"
          disabled={carrying}
          onClick={() => {
            setCarrying(true);
            void onCarryRows(pageId, rows.map((node) => node.id)).finally(() => {
              setCarrying(false);
              setCarried((count) => count + 1);
            });
          }}
        >
          <ArrowDownToLine size={13} aria-hidden="true" />
          <span>{`Carry over ${rows.length}`}</span>
        </button>
      )}
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

/**
 * The unfinished To-dos waiting on the days before this one. Read here rather
 * than counted from what is on screen: those days are not open, and the count
 * is the whole of what the button can honestly say before it is pressed.
 *
 * Read when the days to read change, and not on every revision: a keystroke on
 * the open day cannot change what an earlier day is still carrying, and reading
 * seven days again for each one would put an IPC round trip inside the typing
 * debounce. A carry-over is the one thing that empties these days without
 * changing which days they are, so it says so itself through `carried` -- the
 * page list looks identical either side of it, and an effect watching only that
 * would go on offering rows that are already on this page.
 */
function useCarryOverRows(
  store: NotesStore,
  date: string,
  pageId: string,
  /** Bumped each time a carry-over settles, which is when to look again. */
  carried: number
): readonly NoteView[] {
  const shell = useSyncExternalStore(
    store.subscribeShell,
    store.getShellSnapshot,
    store.getShellSnapshot
  );
  const [rows, setRows] = useState<readonly NoteView[]>([]);
  const dayIds = carryOverDays(journalDays(shell.pages), date)
    .filter((day) => day.id !== pageId)
    .map((day) => day.id)
    .join(" ");
  useEffect(() => {
    if (dayIds.length === 0) {
      setRows([]);
      return () => undefined;
    }
    let active = true;
    const ids = dayIds.split(" ");
    void store.queryForest(ids).then(
      (forest) => {
        if (active) setRows(carryOverRows(forest.nodes, ids));
      },
      () => {
        // Days that could not be read offer nothing to carry, which is what an
        // empty list already says.
        if (active) setRows([]);
      }
    );
    return () => {
      active = false;
    };
  }, [carried, dayIds, store]);
  return rows;
}
