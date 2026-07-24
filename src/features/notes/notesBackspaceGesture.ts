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
import type { OptimisticOutlineProjection } from "./notesKeyboardInsertion";

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
  gesture: OptimisticBackspaceGesture | null
): OptimisticOutlineProjection {
  if (gesture === null) {
    return { rows, nodeOverrides: new Map() };
  }

  const projectedRows = [...rows];
  const nodeOverrides = new Map<NoteId, NoteNode>();

  for (const removedNodeId of gesture.removedNodeIds) {
    const removedIndex = projectedRows.findIndex(
      (row) => row.id === removedNodeId
    );
    if (removedIndex < 0) continue;

    const removedRow = projectedRows[removedIndex];
    let descendantEndIndex = removedIndex + 1;
    while (
      descendantEndIndex < projectedRows.length &&
      projectedRows[descendantEndIndex].depth > removedRow.depth
    ) {
      descendantEndIndex += 1;
    }

    const liftedDescendants = projectedRows
      .slice(removedIndex + 1, descendantEndIndex)
      .map((row) => ({
        ...row,
        parentId:
          row.depth === removedRow.depth + 1 ? removedRow.parentId : row.parentId,
        depth: row.depth - 1,
        ancestorIds: row.ancestorIds.filter((id) => id !== removedNodeId)
      }));
    projectedRows.splice(
      removedIndex,
      descendantEndIndex - removedIndex,
      ...liftedDescendants
    );
  }

  if (gesture.titleUpdate !== null) {
    const survivor = nodesById[gesture.titleUpdate.id];
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
