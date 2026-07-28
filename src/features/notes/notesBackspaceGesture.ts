import type {
  NoteId,
  NoteNode,
  NotesBackspaceTitleUpdate
} from "../../domain/notes";
import type { NotesHistoryPrimarySelection } from "./notesHistory";
import type { NotesPaneId } from "./notesPaneSession";
import {
  deriveOutlineGuideMetadata,
  type FlattenedOutlineRow
} from "./outlineTree";
import type { OptimisticOutlineProjection } from "./notesLocalStructure";

export interface OptimisticBackspaceGesture {
  readonly token: number;
  readonly ownerPaneId: NotesPaneId;
  readonly startingNodeId: NoteId;
  readonly startingSelection: NotesHistoryPrimarySelection;
  readonly removedNodeIds: readonly NoteId[];
  readonly titleUpdate: NotesBackspaceTitleUpdate | null;
  readonly focusNodeId: NoteId | null;
  readonly status: "active" | "queued" | "running" | "checking";
}

export function appendBackspaceRemoval(
  gesture: OptimisticBackspaceGesture,
  input: {
    nodeId: NoteId;
    focusNodeId: NoteId | null;
    titleUpdate: NotesBackspaceTitleUpdate | null;
  }
): OptimisticBackspaceGesture {
  return {
    ...gesture,
    removedNodeIds: [...gesture.removedNodeIds, input.nodeId],
    focusNodeId: input.focusNodeId,
    titleUpdate: input.titleUpdate
  };
}

function sameNumbers(
  left: readonly number[],
  right: readonly number[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function finalizeOptimisticOutlineRows(
  rows: readonly FlattenedOutlineRow[]
): readonly FlattenedOutlineRow[] {
  const guideMetadata = deriveOutlineGuideMetadata(rows);
  let changed = false;
  const finalizedRows = rows.map((row, index) => {
    const guides = guideMetadata[index];
    if (
      row.visibleDescendantEndId === guides.visibleDescendantEndId &&
      sameNumbers(row.ancestorGuideDepths, guides.ancestorGuideDepths)
    ) {
      return row;
    }
    changed = true;
    return { ...row, ...guides };
  });
  return changed ? finalizedRows : rows;
}

export function projectOptimisticBackspaceGesture(
  rows: readonly FlattenedOutlineRow[],
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  gesture: OptimisticBackspaceGesture | null,
  resolveNode: (id: NoteId) => NoteNode | undefined = (id) => nodesById[id]
): OptimisticOutlineProjection {
  if (gesture === null) {
    return { rows, nodeOverrides: new Map() };
  }

  const removedNodeIds = new Set(gesture.removedNodeIds);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const survivingParentById = new Map<NoteId, NoteId | null>();
  const nodeOverrides = new Map<NoteId, NoteNode>();
  const survivingParent = (parentId: NoteId | null): NoteId | null => {
    if (parentId === null || !removedNodeIds.has(parentId)) return parentId;
    const remembered = survivingParentById.get(parentId);
    if (remembered !== undefined) return remembered;
    const parent =
      rowsById.get(parentId)?.parentId ?? resolveNode(parentId)?.parentId ?? null;
    const survivor = survivingParent(parent);
    survivingParentById.set(parentId, survivor);
    return survivor;
  };
  const projectedRows = rows.flatMap((row) => {
    if (removedNodeIds.has(row.id)) return [];
    const ancestorIds = row.ancestorIds.filter(
      (id) => !removedNodeIds.has(id)
    );
    const parentId = survivingParent(row.parentId);
    const removedAncestorCount = row.ancestorIds.length - ancestorIds.length;
    if (removedAncestorCount === 0 && parentId === row.parentId) return [row];
    return [{
      ...row,
      parentId,
      depth: row.depth - removedAncestorCount,
      ancestorIds
    }];
  });

  if (gesture.titleUpdate !== null) {
    const survivor = resolveNode(gesture.titleUpdate.id);
    if (survivor) {
      nodeOverrides.set(gesture.titleUpdate.id, {
        ...survivor,
        title: gesture.titleUpdate.title
      });
    }
  }

  if (projectedRows.length === rows.length && nodeOverrides.size === 0) {
    return { rows, nodeOverrides };
  }

  return {
    rows: finalizeOptimisticOutlineRows(projectedRows),
    nodeOverrides
  };
}
