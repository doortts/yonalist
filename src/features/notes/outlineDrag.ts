import type { MoveNoteNodeInput, NoteId } from "../../domain/notes";
import type { FlattenedOutlineRow } from "./outlineTree";

export const OUTLINE_INDENT_PX = 36;
export const OUTLINE_NARROW_INDENT_PX = 28;
export const OUTLINE_NARROW_MEDIA_QUERY = "(max-width: 720px)";

export interface OutlineSiblingOrder {
  rootIds: readonly NoteId[];
  childIdsByParent: Readonly<Record<NoteId, readonly NoteId[]>>;
  zoomRootId: NoteId | null;
}

export interface OutlineDropProjection
  extends Omit<MoveNoteNodeInput, "id"> {
  expandNodeId?: NoteId;
}

export interface OutlineDropPreview {
  beforeId: NoteId | null;
  parentId: NoteId | null;
  depth: number;
}

export type OutlineSelectionDropInvalidReason =
  | "empty-selection"
  | "invalid-geometry"
  | "active-outside-selection"
  | "selected-forest-target";

export interface OutlineSelectionDropInvalid {
  readonly kind: "invalid";
  readonly reason: OutlineSelectionDropInvalidReason;
}

/** Opaque, immutable geometry snapshot created once when selection drag starts. */
export interface PreparedOutlineSelectionDrag {
  readonly kind: "ready";
  readonly nodeIds: readonly NoteId[];
}

export type OutlineSelectionDragPreparation =
  | PreparedOutlineSelectionDrag
  | OutlineSelectionDropInvalid;

export type OutlineSelectionDropResult =
  | {
      readonly kind: "valid";
      readonly nodeIds: readonly NoteId[];
      readonly projection: OutlineDropProjection;
    }
  | OutlineSelectionDropInvalid;

function hasValidRowShape(
  rows: readonly FlattenedOutlineRow[],
  zoomRootId: NoteId | null
): boolean {
  const seen = new Map<NoteId, FlattenedOutlineRow>();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = rows[index - 1];
    const isNestedZoomRoot = index === 0 && row.id === zoomRootId;
    if (
      seen.has(row.id) ||
      !Number.isInteger(row.depth) ||
      row.depth < 0 ||
      row.ancestorIds.length !== row.depth ||
      (!previous && row.depth !== 0)
    ) {
      return false;
    }

    const expectedAncestorIds = previous
      ? row.depth === previous.depth + 1
        ? [...previous.ancestorIds, previous.id]
        : row.depth <= previous.depth
          ? previous.ancestorIds.slice(0, row.depth)
          : null
      : [];
    if (
      expectedAncestorIds === null ||
      expectedAncestorIds.some(
        (ancestorId, depth) => row.ancestorIds[depth] !== ancestorId
      ) ||
      (row.depth === 0
        ? row.parentId !== null && !isNestedZoomRoot
        : row.ancestorIds[row.depth - 1] !== row.parentId)
    ) {
      return false;
    }

    for (let depth = 0; depth < row.ancestorIds.length; depth += 1) {
      const ancestor = seen.get(row.ancestorIds[depth]);
      if (!ancestor || ancestor.depth !== depth) {
        return false;
      }
    }
    seen.set(row.id, row);
  }

  return true;
}

function isInsideZoom(
  row: FlattenedOutlineRow,
  zoomRootId: NoteId | null
): boolean {
  return (
    zoomRootId === null ||
    row.id === zoomRootId ||
    row.ancestorIds.includes(zoomRootId)
  );
}

function directSiblings(
  parentId: NoteId | null,
  order: OutlineSiblingOrder
): readonly NoteId[] {
  return parentId === null
    ? order.rootIds
    : (order.childIdsByParent[parentId] ?? []);
}

function parentAtDepth(
  previous: FlattenedOutlineRow | undefined,
  depth: number
): NoteId | null | undefined {
  if (depth === 0) {
    return null;
  }
  if (!previous) {
    return undefined;
  }
  if (previous.depth < depth) {
    return previous.depth + 1 === depth ? previous.id : undefined;
  }
  if (previous.depth === depth) {
    return previous.parentId;
  }
  return previous.ancestorIds[depth - 1];
}

function visibleSubtreeEnd(
  rows: readonly FlattenedOutlineRow[],
  rootIndex: number
): number {
  const rootId = rows[rootIndex]?.id;
  let end = rootIndex + 1;
  while (
    rootId !== undefined &&
    end < rows.length &&
    rows[end].ancestorIds.includes(rootId)
  ) {
    end += 1;
  }
  return end;
}

function deriveDropPreview(
  remaining: readonly FlattenedOutlineRow[],
  projection: OutlineDropProjection
): OutlineDropPreview | null {
  const parentIndex =
    projection.parentId === null
      ? -1
      : remaining.findIndex((row) => row.id === projection.parentId);
  if (projection.parentId !== null && parentIndex < 0) {
    return null;
  }
  const depth =
    projection.parentId === null ? 0 : remaining[parentIndex].depth + 1;

  let beforeId: NoteId | null;
  if (projection.beforeId != null) {
    const before = remaining.find((row) => row.id === projection.beforeId);
    if (!before || before.parentId !== projection.parentId) {
      return null;
    }
    beforeId = before.id;
  } else if (projection.afterId !== null) {
    const afterIndex = remaining.findIndex(
      (row) => row.id === projection.afterId
    );
    if (afterIndex >= 0) {
      if (remaining[afterIndex].parentId !== projection.parentId) {
        return null;
      }
      beforeId = remaining[visibleSubtreeEnd(remaining, afterIndex)]?.id ?? null;
    } else {
      const parent = remaining[parentIndex];
      if (!parent || projection.expandNodeId !== parent.id) {
        return null;
      }
      beforeId = remaining[visibleSubtreeEnd(remaining, parentIndex)]?.id ?? null;
    }
  } else if (projection.parentId !== null) {
    beforeId = remaining[visibleSubtreeEnd(remaining, parentIndex)]?.id ?? null;
  } else {
    beforeId = null;
  }

  return { beforeId, parentId: projection.parentId, depth };
}

export function deriveOutlineDropPreview(
  activeId: NoteId,
  rows: readonly FlattenedOutlineRow[],
  projection: OutlineDropProjection
): OutlineDropPreview | null {
  const activeIndex = rows.findIndex((row) => row.id === activeId);
  if (activeIndex < 0) {
    return null;
  }

  const activeEnd = visibleSubtreeEnd(rows, activeIndex);
  return deriveDropPreview(
    [...rows.slice(0, activeIndex), ...rows.slice(activeEnd)],
    projection
  );
}

function previousDirectSibling(
  rows: readonly FlattenedOutlineRow[],
  insertionIndex: number,
  depth: number,
  parentId: NoteId | null
): FlattenedOutlineRow | undefined {
  for (let index = insertionIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.depth < depth) {
      return undefined;
    }
    if (row.depth === depth) {
      return row.parentId === parentId ? row : undefined;
    }
  }
  return undefined;
}

function nextDirectSibling(
  rows: readonly FlattenedOutlineRow[],
  insertionIndex: number,
  depth: number,
  parentId: NoteId | null
): FlattenedOutlineRow | undefined {
  for (let index = insertionIndex; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.depth < depth) {
      return undefined;
    }
    if (row.depth === depth) {
      return row.parentId === parentId ? row : undefined;
    }
  }
  return undefined;
}

function isNoOp(
  active: FlattenedOutlineRow,
  projection: Omit<MoveNoteNodeInput, "id">,
  order: OutlineSiblingOrder
): boolean {
  if (active.parentId !== projection.parentId) {
    return false;
  }

  const siblings = directSiblings(projection.parentId, order);
  const originalIndex = siblings.indexOf(active.id);
  if (originalIndex < 0) {
    return false;
  }
  const destinationSiblings = siblings.filter((id) => id !== active.id);
  let destinationIndex = destinationSiblings.length;
  if (projection.beforeId != null) {
    destinationIndex = destinationSiblings.indexOf(projection.beforeId);
  } else if (projection.afterId !== null) {
    const anchorIndex = destinationSiblings.indexOf(projection.afterId);
    destinationIndex = anchorIndex < 0 ? -1 : anchorIndex + 1;
  }

  return destinationIndex >= 0 && destinationIndex === originalIndex;
}

export function projectOutlineDrop(
  activeId: NoteId,
  overId: NoteId,
  horizontalOffset: number,
  rows: readonly FlattenedOutlineRow[],
  order: OutlineSiblingOrder,
  indentPx = OUTLINE_INDENT_PX
): OutlineDropProjection | null {
  if (
    !Number.isFinite(horizontalOffset) ||
    !Number.isFinite(indentPx) ||
    indentPx <= 0 ||
    !hasValidRowShape(rows, order.zoomRootId)
  ) {
    return null;
  }

  const activeIndex = rows.findIndex((row) => row.id === activeId);
  const overIndex = rows.findIndex((row) => row.id === overId);
  if (activeIndex < 0 || overIndex < 0) {
    return null;
  }

  const active = rows[activeIndex];
  const over = rows[overIndex];
  const isSelfOver = activeId === overId;
  if (
    activeId === order.zoomRootId ||
    !isInsideZoom(active, order.zoomRootId) ||
    !isInsideZoom(over, order.zoomRootId) ||
    over.ancestorIds.includes(activeId)
  ) {
    return null;
  }

  let activeEnd = activeIndex + 1;
  while (
    activeEnd < rows.length &&
    rows[activeEnd].ancestorIds.includes(activeId)
  ) {
    activeEnd += 1;
  }
  if (
    rows.slice(activeEnd).some((row) => row.ancestorIds.includes(activeId)) ||
    (!isSelfOver && overIndex >= activeIndex && overIndex < activeEnd)
  ) {
    return null;
  }

  const remaining = [
    ...rows.slice(0, activeIndex),
    ...rows.slice(activeEnd)
  ];
  let insertionIndex = activeIndex;
  if (!isSelfOver) {
    const remainingOverIndex = remaining.findIndex((row) => row.id === overId);
    if (remainingOverIndex < 0) {
      return null;
    }
    insertionIndex =
      activeIndex < overIndex
        ? visibleSubtreeEnd(remaining, remainingOverIndex)
        : remainingOverIndex;
  }
  const previous = remaining[insertionIndex - 1];
  const next = remaining[insertionIndex];
  const minimumZoomDepth = order.zoomRootId === null ? 0 : 1;
  const minimumDepth = Math.max(minimumZoomDepth, next?.depth ?? minimumZoomDepth);
  const maximumDepth = previous ? previous.depth + 1 : minimumZoomDepth;
  if (minimumDepth > maximumDepth) {
    return null;
  }

  const requestedDepth =
    active.depth + Math.round(horizontalOffset / indentPx);
  const depth = Math.min(maximumDepth, Math.max(minimumDepth, requestedDepth));
  const parentId = parentAtDepth(previous, depth);
  if (parentId === undefined || (order.zoomRootId !== null && parentId === null)) {
    return null;
  }

  const parentRow =
    parentId === null ? undefined : rows.find((row) => row.id === parentId);
  if (
    depth > 0 &&
    (!parentRow ||
      parentRow.depth !== depth - 1 ||
      !isInsideZoom(parentRow, order.zoomRootId))
  ) {
    return null;
  }

  const siblings = directSiblings(parentId, order);
  if (parentRow?.isCollapsed) {
    const lastChildId = siblings.filter((id) => id !== activeId).at(-1) ?? null;
    const projection: OutlineDropProjection = {
      parentId,
      afterId: lastChildId,
      expandNodeId: parentRow.id
    };
    return isNoOp(active, projection, order) ? null : projection;
  }

  const previousSibling = previousDirectSibling(
    remaining,
    insertionIndex,
    depth,
    parentId
  );
  const nextSibling = nextDirectSibling(
    remaining,
    insertionIndex,
    depth,
    parentId
  );

  let projection: OutlineDropProjection;
  if (previousSibling) {
    if (!siblings.includes(previousSibling.id)) {
      return null;
    }
    projection = { parentId, afterId: previousSibling.id };
  } else if (nextSibling) {
    if (!siblings.includes(nextSibling.id)) {
      return null;
    }
    projection = { parentId, afterId: null, beforeId: nextSibling.id };
  } else {
    projection = { parentId, afterId: null };
  }

  return isNoOp(active, projection, order) ? null : projection;
}

interface OutlineSelectedForest {
  readonly rootIds: readonly NoteId[];
  readonly nodeIds: ReadonlySet<NoteId>;
  readonly activeRootId: NoteId | null;
}

function selectedForest(
  selectedRootIds: ReadonlySet<NoteId>,
  activeId: NoteId,
  order: OutlineSiblingOrder
): OutlineSelectedForest | null {
  const roots: NoteId[] = [];
  const forestNodeIds = new Set<NoteId>();
  const foundSelectedIds = new Set<NoteId>();
  const seen = new Set<NoteId>();
  const pending = order.rootIds
    .map((nodeId) => ({ nodeId, selectedRootId: null as NoteId | null }))
    .reverse();
  let activeRootId: NoteId | null = null;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const { nodeId } = current;
    if (seen.has(nodeId)) {
      return null;
    }
    seen.add(nodeId);
    const explicitlySelected = selectedRootIds.has(nodeId);
    if (explicitlySelected) {
      foundSelectedIds.add(nodeId);
    }
    const selectedRootId =
      current.selectedRootId ?? (explicitlySelected ? nodeId : null);
    if (selectedRootId !== null) {
      forestNodeIds.add(nodeId);
      if (current.selectedRootId === null) {
        roots.push(nodeId);
      }
      if (nodeId === activeId) {
        activeRootId = selectedRootId;
      }
    }
    const children = order.childIdsByParent[nodeId] ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ nodeId: children[index], selectedRootId });
    }
  }

  return foundSelectedIds.size === selectedRootIds.size
    ? { rootIds: roots, nodeIds: forestNodeIds, activeRootId }
    : null;
}

function selectionGeometryOrder(
  order: OutlineSiblingOrder,
  forestNodeIds: ReadonlySet<NoteId>,
  activeRootId: NoteId
): OutlineSiblingOrder {
  const keep = (nodeId: NoteId): boolean =>
    nodeId === activeRootId || !forestNodeIds.has(nodeId);
  const childIdsByParent: Record<NoteId, readonly NoteId[]> = {};
  for (const [parentId, childIds] of Object.entries(
    order.childIdsByParent
  )) {
    childIdsByParent[parentId] = Object.freeze(childIds.filter(keep));
  }
  return Object.freeze({
    rootIds: Object.freeze(order.rootIds.filter(keep)),
    childIdsByParent: Object.freeze(childIdsByParent),
    zoomRootId: order.zoomRootId
  });
}

interface PreparedOutlineSelectionDragState {
  readonly activeRootId: NoteId;
  readonly forestNodeIds: ReadonlySet<NoteId>;
  readonly geometryRows: readonly FlattenedOutlineRow[];
  readonly previewRows: readonly FlattenedOutlineRow[];
  readonly geometryOrder: OutlineSiblingOrder;
}

const preparedSelectionDragStates = new WeakMap<
  PreparedOutlineSelectionDrag,
  PreparedOutlineSelectionDragState
>();

/** Normalizes the selected forest and removes it from pointer-time geometry. */
export function prepareOutlineSelectionDrag(
  activeId: NoteId,
  selectedRootIds: readonly NoteId[],
  rows: readonly FlattenedOutlineRow[],
  order: OutlineSiblingOrder
): OutlineSelectionDragPreparation {
  const selected = new Set(selectedRootIds);
  if (selected.size === 0) {
    return { kind: "invalid", reason: "empty-selection" };
  }
  const forest = selectedForest(selected, activeId, order);
  if (!forest) {
    return { kind: "invalid", reason: "invalid-geometry" };
  }
  if (forest.activeRootId === null) {
    return { kind: "invalid", reason: "active-outside-selection" };
  }
  const geometryRows = Object.freeze(
    rows.filter(
      (row) => row.id === forest.activeRootId || !forest.nodeIds.has(row.id)
    )
  );
  const previewRows = Object.freeze(
    rows.filter((row) => !forest.nodeIds.has(row.id))
  );
  const prepared = Object.freeze({
    kind: "ready" as const,
    nodeIds: Object.freeze([...forest.rootIds])
  });
  preparedSelectionDragStates.set(prepared, {
    activeRootId: forest.activeRootId,
    forestNodeIds: forest.nodeIds,
    geometryRows,
    previewRows,
    geometryOrder: selectionGeometryOrder(
      order,
      forest.nodeIds,
      forest.activeRootId
    )
  });
  return prepared;
}

/** Projects one pointer position without rereading the authoritative tree. */
export function projectPreparedOutlineSelectionDrop(
  prepared: PreparedOutlineSelectionDrag,
  overId: NoteId,
  horizontalOffset: number,
  indentPx = OUTLINE_INDENT_PX
): OutlineSelectionDropResult {
  const state = preparedSelectionDragStates.get(prepared);
  if (!state) {
    return { kind: "invalid", reason: "invalid-geometry" };
  }
  if (state.forestNodeIds.has(overId)) {
    return { kind: "invalid", reason: "selected-forest-target" };
  }
  const projection = projectOutlineDrop(
    state.activeRootId,
    overId,
    horizontalOffset,
    state.geometryRows,
    state.geometryOrder,
    indentPx
  );
  if (!projection) {
    return { kind: "invalid", reason: "invalid-geometry" };
  }
  if (
    (projection.parentId !== null &&
      state.forestNodeIds.has(projection.parentId)) ||
    (projection.afterId !== null &&
      state.forestNodeIds.has(projection.afterId)) ||
    (projection.beforeId != null &&
      state.forestNodeIds.has(projection.beforeId))
  ) {
    return { kind: "invalid", reason: "selected-forest-target" };
  }
  return { kind: "valid", nodeIds: prepared.nodeIds, projection };
}

export function projectOutlineSelectionDrop(
  activeId: NoteId,
  overId: NoteId,
  selectedRootIds: readonly NoteId[],
  horizontalOffset: number,
  rows: readonly FlattenedOutlineRow[],
  order: OutlineSiblingOrder,
  indentPx = OUTLINE_INDENT_PX
): OutlineSelectionDropResult {
  const prepared = prepareOutlineSelectionDrag(
    activeId,
    selectedRootIds,
    rows,
    order
  );
  return prepared.kind === "invalid"
    ? prepared
    : projectPreparedOutlineSelectionDrop(
        prepared,
        overId,
        horizontalOffset,
        indentPx
      );
}

function deriveSelectionDropPreview(
  remaining: readonly FlattenedOutlineRow[],
  result: OutlineSelectionDropResult
): OutlineDropPreview | null {
  return result.kind === "invalid"
    ? null
    : deriveDropPreview(remaining, result.projection);
}

export function derivePreparedOutlineSelectionDropPreview(
  prepared: PreparedOutlineSelectionDrag,
  result: OutlineSelectionDropResult
): OutlineDropPreview | null {
  const state = preparedSelectionDragStates.get(prepared);
  return state ? deriveSelectionDropPreview(state.previewRows, result) : null;
}

/** Convenience counterpart to `projectOutlineSelectionDrop`. Pointer-driven
 * consumers should reuse `derivePreparedOutlineSelectionDropPreview` instead. */
export function deriveOutlineSelectionDropPreview(
  rows: readonly FlattenedOutlineRow[],
  result: OutlineSelectionDropResult
): OutlineDropPreview | null {
  if (result.kind === "invalid") {
    return null;
  }
  const selectedRoots = new Set(result.nodeIds);
  return deriveSelectionDropPreview(
    rows.filter(
      (row) =>
        !selectedRoots.has(row.id) &&
        !row.ancestorIds.some((ancestorId) => selectedRoots.has(ancestorId))
    ),
    result
  );
}
