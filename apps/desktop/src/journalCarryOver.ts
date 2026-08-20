import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { JournalDay } from "./journal";

/** How far back a carry-over looks for work nobody finished. */
export const CARRY_OVER_DAYS = 7;

/**
 * The days a carry-over reads: the seven before this one that have a page,
 * oldest first, so what is carried lands in the order it was written. Further
 * back than that is not unfinished work any more -- it is a decision somebody
 * already made by leaving it there.
 */
export function carryOverDays(
  days: readonly JournalDay[],
  date: string
): readonly JournalDay[] {
  return days
    .filter((day) => day.date < date)
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, CARRY_OVER_DAYS)
    .reverse();
}

function unfinished(node: NoteView | undefined): boolean {
  return node !== undefined && node.marker === "todo" && !node.completed &&
    !node.deleted;
}

/**
 * The rows a carry-over would move, in the order they would land: unfinished
 * To-dos on those days, each the top of what it brings. A To-do under another
 * To-do travels with its parent, so naming both would move the same rows twice.
 */
export function carryOverRows(
  nodes: readonly NoteView[],
  dayIds: readonly string[]
): readonly NoteView[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const days = new Set(dayIds);
  /** The day a row sits on, and whether an unfinished To-do stands above it. */
  const place = (node: NoteView): { day?: string; covered: boolean } => {
    let covered = false;
    let current = node;
    while (current.parentId !== null) {
      if (days.has(current.parentId)) return { day: current.parentId, covered };
      const parent = byId.get(current.parentId);
      if (!parent) return { covered };
      covered = covered || unfinished(parent);
      current = parent;
    }
    return { covered };
  };
  const rowsByDay = new Map<string, NoteView[]>();
  for (const node of nodes) {
    if (!unfinished(node)) continue;
    const { day, covered } = place(node);
    if (day === undefined || covered) continue;
    const rows = rowsByDay.get(day);
    if (rows) rows.push(node);
    else rowsByDay.set(day, [node]);
  }
  return dayIds.flatMap((dayId) =>
    (rowsByDay.get(dayId) ?? []).sort(
      (left, right) => left.sortKey - right.sortKey
    ));
}
