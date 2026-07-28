import type { NoteView } from "../../../packages/contracts/generated/NoteView";

export interface SelectionNodeMove {
  readonly id: string;
  readonly parentId: string;
  readonly beforeId: string | null;
}

export type SelectionMovePlan =
  | { readonly available: true; readonly moves: readonly SelectionNodeMove[] }
  | { readonly available: false; readonly reason: string };

export type SelectionDuplicatePlan =
  | {
      readonly available: true;
      readonly parentId: string;
      readonly beforeId: string | null;
    }
  | { readonly available: false; readonly reason: string };

export function selectedCompletion(
  nodes: readonly NoteView[],
  selectedIds: readonly string[]
): boolean {
  const selected = new Set(selectedIds);
  const selectedNodes = nodes.filter((node) => selected.has(node.id));
  return selectedNodes.length > 0 && selectedNodes.every((node) => node.completed);
}

function siblingsOf(nodes: readonly NoteView[], parentId: string | null) {
  return nodes
    .filter((node) => node.parentId === parentId && !node.deleted)
    .sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id));
}

export function planSelectionIndent(
  nodes: readonly NoteView[],
  visibleIds: readonly string[],
  rootIds: readonly string[]
): SelectionMovePlan {
  const selected = new Set(rootIds);
  const visible = new Set(visibleIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const moves: SelectionNodeMove[] = [];
  for (const id of rootIds) {
    const node = byId.get(id);
    if (!node) return { available: false, reason: "The selection is stale." };
    const siblings = siblingsOf(nodes, node.parentId);
    let index = siblings.findIndex((sibling) => sibling.id === id) - 1;
    while (index >= 0 && selected.has(siblings[index].id)) index -= 1;
    const previous = siblings[index];
    if (!previous || !visible.has(previous.id)) {
      return {
        available: false,
        reason: "The first selected item has no preceding visible sibling."
      };
    }
    moves.push({ id, parentId: previous.id, beforeId: null });
  }
  return { available: true, moves };
}

export function planSelectionOutdent(
  nodes: readonly NoteView[],
  rootIds: readonly string[],
  outlineRootId: string
): SelectionMovePlan {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const moves = rootIds.flatMap((id): SelectionNodeMove[] => {
    const node = byId.get(id);
    const parent = node?.parentId ? byId.get(node.parentId) : undefined;
    if (!node || !parent || node.parentId === outlineRootId || !parent.parentId) return [];
    const parentSiblings = siblingsOf(nodes, parent.parentId);
    const parentIndex = parentSiblings.findIndex((sibling) => sibling.id === parent.id);
    return [{
      id,
      parentId: parent.parentId,
      beforeId: parentSiblings[parentIndex + 1]?.id ?? null
    }];
  });
  return moves.length > 0
    ? { available: true, moves }
    : { available: false, reason: "The selection cannot move outside this outline." };
}

export function planSelectionReorder(
  nodes: readonly NoteView[],
  rootIds: readonly string[],
  direction: "up" | "down"
): SelectionMovePlan {
  if (rootIds.length === 0) return { available: false, reason: "Nothing is selected." };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentId = byId.get(rootIds[0])?.parentId;
  if (!parentId || rootIds.some((id) => byId.get(id)?.parentId !== parentId)) {
    return { available: false, reason: "Reorder requires one shared parent." };
  }
  const siblings = siblingsOf(nodes, parentId);
  const positions = rootIds.map((id) =>
    siblings.findIndex((sibling) => sibling.id === id));
  if (positions.some((position, index) =>
    position < 0 || (index > 0 && position !== positions[index - 1] + 1))) {
    return { available: false, reason: "Reorder requires contiguous siblings." };
  }
  const first = positions[0];
  const last = positions.at(-1)!;
  if (
    (direction === "up" && first === 0) ||
    (direction === "down" && last === siblings.length - 1)
  ) {
    return { available: false, reason: "The selection is already at that boundary." };
  }
  const beforeId = direction === "up"
    ? siblings[first - 1].id
    : siblings[last + 2]?.id ?? null;
  return {
    available: true,
    moves: rootIds.map((id) => ({ id, parentId, beforeId }))
  };
}

export function planSelectionDuplicate(
  nodes: readonly NoteView[],
  rootIds: readonly string[]
): SelectionDuplicatePlan {
  if (rootIds.length === 0) return { available: false, reason: "Nothing is selected." };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentId = byId.get(rootIds[0])?.parentId;
  if (!parentId || rootIds.some((id) => byId.get(id)?.parentId !== parentId)) {
    return { available: false, reason: "Duplicate requires one shared parent." };
  }
  const siblings = siblingsOf(nodes, parentId);
  const lastIndex = Math.max(...rootIds.map((id) =>
    siblings.findIndex((sibling) => sibling.id === id)));
  return {
    available: true,
    parentId,
    beforeId: siblings[lastIndex + 1]?.id ?? null
  };
}

export function buildSelectionMovePlans(
  nodes: readonly NoteView[],
  visibleIds: readonly string[],
  rootIds: readonly string[],
  outlineRootId: string
) {
  return {
    indent: planSelectionIndent(nodes, visibleIds, rootIds),
    outdent: planSelectionOutdent(nodes, rootIds, outlineRootId),
    up: planSelectionReorder(nodes, rootIds, "up"),
    down: planSelectionReorder(nodes, rootIds, "down"),
    duplicate: planSelectionDuplicate(nodes, rootIds)
  } as const;
}
