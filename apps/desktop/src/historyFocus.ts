import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { PaneFocusSnapshot } from "./appNavigation";

function liveNode(
  nodes: readonly NoteView[],
  id: string
): NoteView | undefined {
  return nodes.find((node) => node.id === id && !node.deleted);
}

function previousSiblingId(
  before: readonly NoteView[],
  after: readonly NoteView[],
  removed: NoteView
): string | null {
  return before
    .filter((node) => node.parentId === removed.parentId &&
      liveNode(after, node.id) &&
      (node.sortKey - removed.sortKey ||
        node.id.localeCompare(removed.id)) < 0)
    .sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id))
    .at(-1)?.id ?? null;
}

/**
 * The fallback for a caret a history step cannot simply put back. Each entry
 * records the caret its command started from, and undo restores that; this
 * covers what recording cannot -- an entry with no caret to its name, and a
 * recorded row the step itself removed. Guessing is why an undone Enter split
 * used to land at the end of the row, so nothing calls this while the recorded
 * row is still there.
 *
 * Returns the snapshot unchanged when its row survived, which is the caller's
 * signal that the DOM already holds that caret.
 */
export function resolveHistoryFocus(
  focus: PaneFocusSnapshot | null,
  before: readonly NoteView[],
  after: readonly NoteView[]
): PaneFocusSnapshot | null {
  if (!focus) return null;
  if (liveNode(after, focus.nodeId)) return focus;
  const removed = before.find((node) => node.id === focus.nodeId);
  if (!removed) return null;
  const target = previousSiblingId(before, after, removed) ?? removed.parentId;
  if (!target) return null;
  // The page root is not one of the outline's nodes, so its title keeps the
  // caret at the start rather than at an end this cannot measure.
  const caret = liveNode(after, target)?.text.length ?? 0;
  return {
    nodeId: target,
    field: "title",
    selectionStart: caret,
    selectionEnd: caret
  };
}
