import { ArrowDownToLine, ChevronLeft, ChevronRight } from "lucide-react";
import {
  useCallback, useEffect, useRef, useState, useSyncExternalStore
} from "react";
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
  // The button is quiet from the press until the count behind it has been read
  // again, not merely until the move lands: in between, what it says is the
  // number of rows that have already arrived here.
  const [carrying, setCarrying] = useState(false);
  const [rows, readAgain] = useCarryOverRows(store, date, pageId);
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
            void onCarryRows(pageId, rows.map((node) => node.id))
              .then(readAgain, readAgain)
              .finally(() => setCarrying(false));
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
 * Read when the days to read change, when the redo stack moves, and when a
 * carry-over the bar itself ran has settled. Not on every revision: a keystroke
 * on the open day cannot change what an earlier day is still carrying, and
 * reading seven days again for each one would put an IPC round trip inside the
 * typing debounce.
 *
 * The redo depth is what catches Undo. A carry-over moves rows between days
 * without changing which days they are, so the day list looks identical either
 * side of it and either side of undoing it; the depth does not -- undo raises
 * it, redo lowers it, and the next command clears it, while a run of typing
 * leaves it alone. Without it the button that correctly emptied itself would
 * stay empty after the rows had been put back.
 */
function useCarryOverRows(
  store: NotesStore,
  date: string,
  pageId: string
): readonly [readonly NoteView[], () => Promise<void>] {
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
  // Which read is the current one. A read that lands after another has started
  // is answering a question nobody is asking any more.
  const reading = useRef(0);
  const read = useCallback(async () => {
    const epoch = ++reading.current;
    const ids = dayIds.length === 0 ? [] : dayIds.split(" ");
    if (ids.length === 0) {
      setRows([]);
      return;
    }
    try {
      const forest = await store.queryForest(ids);
      if (reading.current === epoch) setRows(carryOverRows(forest.nodes, ids));
    } catch {
      // Days that could not be read offer nothing to carry, which is what an
      // empty list already says.
      if (reading.current === epoch) setRows([]);
    }
  }, [dayIds, store]);
  const redoDepth = shell.redoDepth;
  useEffect(() => {
    void read();
  }, [read, redoDepth]);
  return [rows, read];
}
