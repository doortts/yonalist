import type { IpcMarkerKind } from "../../../../packages/contracts/generated/IpcMarkerKind";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { bySiblingOrder } from "./outlineSortKeys";

/** The number a numbered row was created at, or `null` for any other marker. */
export function orderedStart(marker: IpcMarkerKind): number | null {
  return typeof marker === "object" ? marker.ordered.start : null;
}

export function isOrdered(marker: IpcMarkerKind): boolean {
  return orderedStart(marker) !== null;
}

/**
 * The number every numbered row draws. A run is the numbered rows standing
 * together under one parent: it counts up from the number its first row was
 * typed with, and anything else between two numbered siblings ends it, so the
 * next one starts its own count. Nothing is stored per row but that first
 * number, which is what keeps the numbers right when a row is added, moved or
 * taken away.
 *
 * The PDF export counts the same way, in `notes-export`.
 */
export function orderedNumbers(
  nodes: readonly NoteView[]
): ReadonlyMap<string, number> {
  const siblingsByParent = new Map<string, NoteView[]>();
  for (const node of nodes) {
    if (node.deleted || !node.parentId) continue;
    const siblings = siblingsByParent.get(node.parentId);
    if (siblings) siblings.push(node);
    else siblingsByParent.set(node.parentId, [node]);
  }
  const numbers = new Map<string, number>();
  for (const siblings of siblingsByParent.values()) {
    const ordered = [...siblings].sort(bySiblingOrder);
    let running: number | null = null;
    for (const sibling of ordered) {
      const start = orderedStart(sibling.marker);
      if (start === null) {
        running = null;
        continue;
      }
      running = running === null ? start : running + 1;
      numbers.set(sibling.id, running);
    }
  }
  return numbers;
}
