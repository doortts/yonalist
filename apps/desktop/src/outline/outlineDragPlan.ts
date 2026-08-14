import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { SelectionNodeMove } from "../selectionMoves";
import { bySiblingOrder } from "./outlineSortKeys";

export const OUTLINE_DRAG_INDENT_PX = 36;

interface OutlineDragRow {
  readonly node: NoteView;
  readonly depth: number;
  readonly ancestorIds: readonly string[];
}

export interface OutlineDropPlan {
  readonly parentId: string;
  readonly beforeId: string | null;
  readonly previewBeforeId: string | null;
  readonly depth: number;
  readonly moves: readonly SelectionNodeMove[];
}

interface PlanOutlineDropInput {
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly selectedRootIds: readonly string[];
  readonly activeId: string;
  readonly overId: string;
  readonly horizontalOffset: number;
  readonly outlineRootId: string;
  readonly indentPx?: number;
}

interface PlanCrossPaneDropInput {
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly selectedRootIds: readonly string[];
  readonly overId: string | null;
  readonly horizontalOffset: number;
  readonly outlineRootId: string;
  readonly indentPx?: number;
}

function outlineRows(
  nodes: readonly NoteView[],
  visibleNodes: readonly NoteView[],
  outlineRootId: string
): readonly OutlineDragRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return visibleNodes.map((node) => {
    const ancestors: string[] = [];
    const visited = new Set<string>();
    let parentId = node.parentId;
    while (
      parentId &&
      parentId !== outlineRootId &&
      visited.add(parentId)
    ) {
      ancestors.unshift(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return { node, depth: ancestors.length, ancestorIds: ancestors };
  });
}

function selectedForestIds(
  nodes: readonly NoteView[],
  rootIds: readonly string[]
): ReadonlySet<string> {
  const roots = new Set(rootIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return new Set(nodes.flatMap((node) => {
    let currentId: string | null = node.id;
    const visited = new Set<string>();
    while (currentId && visited.add(currentId)) {
      if (roots.has(currentId)) return [node.id];
      currentId = byId.get(currentId)?.parentId ?? null;
    }
    return [];
  }));
}

function visibleSubtreeEnd(
  rows: readonly OutlineDragRow[],
  rootIndex: number
): number {
  const rootDepth = rows[rootIndex]?.depth;
  let end = rootIndex + 1;
  while (
    rootDepth !== undefined &&
    end < rows.length &&
    rows[end].depth > rootDepth
  ) {
    end += 1;
  }
  return end;
}

function insertionParent(
  previous: OutlineDragRow | undefined,
  depth: number,
  outlineRootId: string
): string | null {
  if (depth === 0) return outlineRootId;
  if (!previous) return null;
  if (previous.depth === depth - 1) return previous.node.id;
  return previous.ancestorIds[depth - 1] ?? null;
}

function nextDirectSibling(
  rows: readonly OutlineDragRow[],
  insertionIndex: number,
  depth: number,
  parentId: string
): string | null {
  for (let index = insertionIndex; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.depth < depth) return null;
    if (row.depth === depth) {
      return row.node.parentId === parentId ? row.node.id : null;
    }
  }
  return null;
}

function orderedSiblings(
  nodes: readonly NoteView[],
  parentId: string
): readonly string[] {
  return nodes
    .filter((node) => node.parentId === parentId && !node.deleted)
    .sort(bySiblingOrder)
    .map((node) => node.id);
}

function isNoOp(
  nodes: readonly NoteView[],
  rootIds: readonly string[],
  parentId: string,
  beforeId: string | null
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sourceParent = byId.get(rootIds[0])?.parentId;
  if (
    !sourceParent ||
    sourceParent !== parentId ||
    rootIds.some((id) => byId.get(id)?.parentId !== sourceParent)
  ) {
    return false;
  }
  const original = orderedSiblings(nodes, sourceParent);
  const selected = new Set(rootIds);
  const remaining = original.filter((id) => !selected.has(id));
  const insertionIndex = beforeId === null
    ? remaining.length
    : remaining.indexOf(beforeId);
  if (insertionIndex < 0) return false;
  const projected = [...remaining];
  projected.splice(insertionIndex, 0, ...rootIds);
  return projected.length === original.length &&
    projected.every((id, index) => id === original[index]);
}

export function planOutlineDrop({
  nodes,
  visibleNodes,
  selectedRootIds,
  activeId,
  overId,
  horizontalOffset,
  outlineRootId,
  indentPx = OUTLINE_DRAG_INDENT_PX
}: PlanOutlineDropInput): OutlineDropPlan | null {
  if (
    selectedRootIds.length === 0 ||
    !Number.isFinite(horizontalOffset) ||
    !Number.isFinite(indentPx) ||
    indentPx <= 0
  ) {
    return null;
  }
  const rows = outlineRows(nodes, visibleNodes, outlineRootId);
  const rowIndex = new Map(rows.map((row, index) => [row.node.id, index]));
  const orderedRoots = [...selectedRootIds].sort(
    (left, right) => (rowIndex.get(left) ?? Infinity) -
      (rowIndex.get(right) ?? Infinity)
  );
  const forestIds = selectedForestIds(nodes, orderedRoots);
  const activeRootId = orderedRoots.find((id) =>
    id === activeId ||
    rows.find((row) => row.node.id === activeId)?.ancestorIds.includes(id)
  );
  const activeRootIndex = activeRootId ? rowIndex.get(activeRootId) : undefined;
  const overIndex = rowIndex.get(overId);
  if (
    !activeRootId ||
    activeRootIndex === undefined ||
    overIndex === undefined ||
    (forestIds.has(overId) && overId !== activeRootId)
  ) {
    return null;
  }
  const selectedIndexes = rows.flatMap((row, index) =>
    forestIds.has(row.node.id) ? [index] : []);
  const firstSelected = Math.min(...selectedIndexes);
  const lastSelected = Math.max(...selectedIndexes);
  const remaining = rows.filter((row) => !forestIds.has(row.node.id));
  let insertionIndex: number;
  if (overId === activeRootId) {
    insertionIndex = rows
      .slice(0, firstSelected)
      .filter((row) => !forestIds.has(row.node.id)).length;
  } else {
    if (overIndex > firstSelected && overIndex < lastSelected) return null;
    const remainingOverIndex = remaining.findIndex(
      (row) => row.node.id === overId
    );
    if (remainingOverIndex < 0) return null;
    insertionIndex = overIndex > lastSelected
      ? visibleSubtreeEnd(remaining, remainingOverIndex)
      : remainingOverIndex;
  }
  const activeRow = rows[activeRootIndex];
  const previous = remaining[insertionIndex - 1];
  const next = remaining[insertionIndex];
  const minimumDepth = next?.depth ?? 0;
  const maximumDepth = previous ? previous.depth + 1 : 0;
  if (minimumDepth > maximumDepth) return null;
  const requestedDepth = activeRow.depth +
    Math.round(horizontalOffset / indentPx);
  const depth = Math.min(maximumDepth, Math.max(minimumDepth, requestedDepth));
  const parentId = insertionParent(previous, depth, outlineRootId);
  if (!parentId || forestIds.has(parentId)) return null;
  const beforeId = nextDirectSibling(
    remaining,
    insertionIndex,
    depth,
    parentId
  );
  if (isNoOp(nodes, orderedRoots, parentId, beforeId)) return null;
  return {
    parentId,
    beforeId,
    previewBeforeId: next?.node.id ?? null,
    depth,
    moves: orderedRoots.map((id) => ({ id, parentId, beforeId }))
  };
}

export function planCrossPaneDrop({
  nodes,
  visibleNodes,
  selectedRootIds,
  overId,
  horizontalOffset,
  outlineRootId,
  indentPx = OUTLINE_DRAG_INDENT_PX
}: PlanCrossPaneDropInput): OutlineDropPlan | null {
  if (
    selectedRootIds.length === 0 ||
    !Number.isFinite(horizontalOffset) ||
    !Number.isFinite(indentPx) ||
    indentPx <= 0
  ) {
    return null;
  }
  const forestIds = selectedForestIds(nodes, selectedRootIds);
  if (
    forestIds.has(outlineRootId) ||
    (overId !== null && forestIds.has(overId))
  ) {
    return null;
  }
  const rows = outlineRows(nodes, visibleNodes, outlineRootId)
    .filter((row) => !forestIds.has(row.node.id));
  const insertionIndex = overId === null
    ? rows.length
    : rows.findIndex((row) => row.node.id === overId);
  if (insertionIndex < 0) return null;
  const previous = rows[insertionIndex - 1];
  const next = rows[insertionIndex];
  const minimumDepth = next?.depth ?? 0;
  const maximumDepth = previous ? previous.depth + 1 : 0;
  if (minimumDepth > maximumDepth) return null;
  const requestedDepth = (next?.depth ?? 0) +
    Math.round(horizontalOffset / indentPx);
  const depth = Math.min(maximumDepth, Math.max(minimumDepth, requestedDepth));
  const parentId = insertionParent(previous, depth, outlineRootId);
  if (!parentId || forestIds.has(parentId)) return null;
  const beforeId = nextDirectSibling(rows, insertionIndex, depth, parentId);
  if (isNoOp(nodes, selectedRootIds, parentId, beforeId)) return null;
  return {
    parentId,
    beforeId,
    previewBeforeId: next?.node.id ?? null,
    depth,
    moves: selectedRootIds.map((id) => ({ id, parentId, beforeId }))
  };
}
