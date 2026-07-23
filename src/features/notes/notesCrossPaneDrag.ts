import type { NoteId } from "../../domain/notes";
import {
  deriveOutlineDropPreview,
  projectOutlineDropAtBoundary
} from "./outlineDrag";
import type { OutlineDropPreview, OutlineDropProjection } from "./outlineDrag";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";
import type { FlattenedOutlineRow } from "./outlineTree";

export interface CrossPaneOrdinaryDropInput {
  readonly activeId: NoteId;
  readonly sourceRootIds?: readonly NoteId[];
  readonly beforeId: NoteId | null;
  readonly horizontalOffset: number;
  readonly rows: readonly FlattenedOutlineRow[];
  readonly workspace: NormalizedNotesWorkspace;
  readonly zoomRootId: NoteId | null;
  readonly indentPx: number;
}

export interface CrossPaneOrdinaryDropProjection {
  readonly input: OutlineDropProjection;
  readonly preview: OutlineDropPreview;
}

export function projectCrossPaneOrdinaryDrop({
  activeId,
  sourceRootIds = [activeId],
  beforeId,
  horizontalOffset,
  rows,
  workspace,
  zoomRootId,
  indentPx
}: CrossPaneOrdinaryDropInput): CrossPaneOrdinaryDropProjection | null {
  const sourceRoots = new Set(sourceRootIds);
  const projectedActiveId = sourceRoots.has(activeId)
    ? activeId
    : sourceRootIds[0];
  if (!projectedActiveId || !workspace.nodesById[activeId]) return null;
  for (const sourceId of sourceRoots) {
    if (!workspace.nodesById[sourceId] || sourceId === zoomRootId) return null;
    for (
      let ancestorId = zoomRootId;
      ancestorId !== null;
      ancestorId = workspace.nodesById[ancestorId]?.parentId ?? null
    ) {
      if (ancestorId === sourceId) return null;
    }
  }
  const activeRowIndex = rows.findIndex((row) => row.id === projectedActiveId);
  const activeVisible = activeRowIndex >= 0;
  const destinationRows = rows.filter(
    (row) =>
      !sourceRoots.has(row.id) &&
      !row.ancestorIds.some((ancestorId) => sourceRoots.has(ancestorId))
  );
  if (
    beforeId !== null &&
    !destinationRows.some((row) => row.id === beforeId)
  ) {
    return null;
  }
  const activeRow = activeVisible ? rows[activeRowIndex] : null;
  const parentId = activeRow?.parentId ?? zoomRootId;
  const depth = activeRow?.depth ?? (zoomRootId === null ? 0 : 1);
  const syntheticRow: FlattenedOutlineRow = {
    id: projectedActiveId,
    parentId,
    depth,
    isCollapsed: false,
    ancestorIds:
      activeRow?.ancestorIds ?? (zoomRootId === null ? [] : [zoomRootId]),
    ancestorGuideDepths: [],
    visibleDescendantEndId: null
  };
  const retainedSourceIds = activeVisible
    ? new Set([projectedActiveId])
    : new Set();
  const rootIds = workspace.rootIds.filter(
    (nodeId) => !sourceRoots.has(nodeId) || retainedSourceIds.has(nodeId)
  );
  const childIdsByParent = Object.fromEntries(
    Object.entries(workspace.childIdsByParent).map(([nodeId, childIds]) => [
      nodeId,
      childIds.filter(
        (childId) =>
          !sourceRoots.has(childId) || retainedSourceIds.has(childId)
      )
    ])
  );
  if (!activeVisible && zoomRootId === null) {
    rootIds.push(...sourceRoots);
  } else if (!activeVisible && zoomRootId !== null) {
    childIdsByParent[zoomRootId] = [
      ...(childIdsByParent[zoomRootId] ?? []),
      ...sourceRoots
    ];
  }
  const projectedRows = [...destinationRows];
  const syntheticIndex = activeVisible
    ? rows
        .slice(0, activeRowIndex)
        .filter(
          (row) =>
            !sourceRoots.has(row.id) &&
            !row.ancestorIds.some((ancestorId) => sourceRoots.has(ancestorId))
        ).length
    : projectedRows.length;
  projectedRows.splice(syntheticIndex, 0, syntheticRow);
  const result = projectOutlineDropAtBoundary(
    projectedActiveId,
    beforeId,
    horizontalOffset,
    projectedRows,
    { rootIds, childIdsByParent, zoomRootId },
    indentPx
  );
  if (!result || (activeVisible && result.noOp)) return null;
  const preview = deriveOutlineDropPreview(
    projectedActiveId,
    projectedRows,
    result.projection
  );
  return preview ? { input: result.projection, preview } : null;
}
