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
  onOpenDay
}: {
  readonly store: NotesStore;
  readonly pageId: string;
  readonly date: string;
  readonly onOpenDay: (date: string) => void;
}) {
  const carried = useCarryOverRows(store, date, pageId);
  const previous = shiftDay(date, -1);
  const next = shiftDay(date, 1);
  return (
    <div className="notes-journal-day-bar" role="group" aria-label={`Day ${date}`}>
      <span className="notes-journal-day-bar-weekday">{weekdayOf(date)}</span>
      <span className="notes-journal-day-bar-spacer" />
      {carried.length > 0 && (
        <button
          className="notes-journal-carry"
          type="button"
          onClick={() => void store.moveNodes(carried.map((node) => ({
            id: node.id,
            parentId: pageId,
            beforeId: null
          })))}
        >
          <ArrowDownToLine size={13} aria-hidden="true" />
          <span>{`Carry over ${carried.length}`}</span>
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
 * is the whole of what the button can honestly say before it is pressed. It is
 * read again on every revision, so the row that was just carried leaves the
 * count it came from.
 */
function useCarryOverRows(
  store: NotesStore,
  date: string,
  pageId: string
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
  const revision = shell.revision;
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
  }, [dayIds, revision, store]);
  return rows;
}
