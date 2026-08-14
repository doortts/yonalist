import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { SelectionNodeMove } from "../selectionMoves";
import { bySiblingOrder } from "./outlineSortKeys";

export interface OutlineMoveTarget {
  /** `null` is the synthetic top-level entry: the outline's own root. */
  readonly id: string | null;
  readonly label: string;
  readonly depth: number;
}

export const OUTLINE_MOVE_TOP_LEVEL = "Top level";

/**
 * Every place the given roots could move to, in outline order, led by the
 * synthetic top-level entry. `rootId` is the outline the chooser is looking at
 * — the zoom root when the pane is zoomed, the page otherwise — so the list
 * covers exactly what the reader can see.
 *
 * Image nodes are listed like any other: this model lets one take children,
 * and both Tab and a drop already put rows under an image, so refusing it here
 * would make Move To weaker than the gestures it exists to replace.
 */
export function outlineMoveTargets(
  nodes: readonly NoteView[],
  movingRootIds: readonly string[],
  rootId: string
): readonly OutlineMoveTarget[] {
  const moving = new Set(movingRootIds);
  const children = new Map<string, NoteView[]>();
  for (const node of nodes) {
    if (node.deleted || !node.parentId) continue;
    const bucket = children.get(node.parentId);
    if (bucket) bucket.push(node);
    else children.set(node.parentId, [node]);
  }
  for (const bucket of children.values()) {
    bucket.sort(bySiblingOrder);
  }
  const targets: OutlineMoveTarget[] = [
    { id: null, label: OUTLINE_MOVE_TOP_LEVEL, depth: 0 }
  ];
  const walk = (parentId: string, depth: number) => {
    for (const child of children.get(parentId) ?? []) {
      // Skipping the whole subtree, not just the root, is the cycle guard made
      // visible: `crates/notes-core/src/tree.rs` refuses these moves anyway.
      if (moving.has(child.id)) continue;
      targets.push({ id: child.id, label: child.text || "Untitled", depth });
      walk(child.id, depth + 1);
    }
  };
  walk(rootId, 1);
  return targets;
}

/**
 * Where the chosen destination puts the moved roots: at the bottom of its
 * children, relative order kept. `moveNodes` reads a null `beforeId` as
 * `Position::AtEnd` and applies the batch in array order, so one pass of
 * appends lands them in the order they were selected.
 */
export function outlineMoveInsertion(
  targetId: string | null,
  movingRootIds: readonly string[],
  rootId: string
): readonly SelectionNodeMove[] {
  const parentId = targetId ?? rootId;
  return movingRootIds.map((id) => ({ id, parentId, beforeId: null }));
}
