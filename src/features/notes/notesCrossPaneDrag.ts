import type { NoteId } from "../../domain/notes";
import {
  deriveOutlineDropPreview,
  projectOutlineDropAtBoundary,
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
  indentPx,
}: CrossPaneOrdinaryDropInput): CrossPaneOrdinaryDropProjection | null {
  const sourceRoots = new Set(sourceRootIds);
  if (!sourceRoots.has(activeId) || !workspace.nodesById[activeId]) return null;
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
  const destinationRows = rows.filter(
    (row) =>
      !sourceRoots.has(row.id) &&
      !row.ancestorIds.some((ancestorId) => sourceRoots.has(ancestorId)),
  );
  if (
    beforeId !== null &&
    !destinationRows.some((row) => row.id === beforeId)
  ) {
    return null;
  }
  const parentId = zoomRootId;
  const depth = zoomRootId === null ? 0 : 1;
  const syntheticRow: FlattenedOutlineRow = {
    id: activeId,
    parentId,
    depth,
    isCollapsed: false,
    ancestorIds: zoomRootId === null ? [] : [zoomRootId],
    ancestorGuideDepths: [],
    visibleDescendantEndId: null,
  };
  const rootIds = workspace.rootIds.filter(
    (nodeId) => !sourceRoots.has(nodeId),
  );
  const childIdsByParent = Object.fromEntries(
    Object.entries(workspace.childIdsByParent).map(([nodeId, childIds]) => [
      nodeId,
      childIds.filter((childId) => !sourceRoots.has(childId)),
    ]),
  );
  if (zoomRootId === null) {
    rootIds.push(...sourceRoots);
  } else {
    childIdsByParent[zoomRootId] = [
      ...(childIdsByParent[zoomRootId] ?? []),
      ...sourceRoots,
    ];
  }
  const projectedRows = [...destinationRows, syntheticRow];
  const result = projectOutlineDropAtBoundary(
    activeId,
    beforeId,
    horizontalOffset,
    projectedRows,
    { rootIds, childIdsByParent, zoomRootId },
    indentPx,
  );
  if (!result) return null;
  const preview = deriveOutlineDropPreview(
    activeId,
    projectedRows,
    result.projection,
  );
  return preview ? { input: result.projection, preview } : null;
}
