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
 * Where the caret belongs once undo or redo has been applied. Every other
 * mutation places its own caret, but history is driven from the window, so the
 * row that held the caret can be unmounted under it -- an Enter-created empty
 * bullet is the everyday case -- and the browser drops focus to the body.
 *
 * Returns the captured snapshot unchanged when its row survived, so a history
 * step that only rewrites text never disturbs a caret the DOM still holds.
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
