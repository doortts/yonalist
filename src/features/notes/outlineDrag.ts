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
  const remaining = [
    ...rows.slice(0, activeIndex),
    ...rows.slice(activeEnd)
  ];
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
