import type { NoteId, NoteNode } from "../../domain/notes";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";

export interface FlattenedOutlineRow {
  id: NoteId;
  parentId: NoteId | null;
  depth: number;
  isCollapsed: boolean;
  ancestorIds: NoteId[];
  ancestorGuideDepths: number[];
  visibleDescendantEndId: NoteId | null;
}

export interface OutlineGuideMetadata {
  ancestorGuideDepths: number[];
  visibleDescendantEndId: NoteId | null;
}

export function deriveOutlineGuideMetadata(
  rows: readonly Pick<FlattenedOutlineRow, "id" | "depth" | "ancestorIds">[]
): OutlineGuideMetadata[] {
  const metadata = rows.map<OutlineGuideMetadata>((row) => ({
    ancestorGuideDepths: row.ancestorIds.map((_, depth) => depth),
    visibleDescendantEndId: null
  }));
  const openRowIndexes: number[] = [];

  const closeGuide = (rowIndex: number, descendantEndIndex: number) => {
    if (descendantEndIndex > rowIndex) {
      metadata[rowIndex].visibleDescendantEndId = rows[descendantEndIndex].id;
    }
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    while (openRowIndexes.length > row.depth) {
      closeGuide(openRowIndexes.pop()!, index - 1);
    }
    openRowIndexes[row.depth] = index;
    openRowIndexes.length = row.depth + 1;
  }

  while (openRowIndexes.length > 0) {
    closeGuide(openRowIndexes.pop()!, rows.length - 1);
  }

  return metadata;
}

export function flattenVisibleOutlineRows(
  workspace: NormalizedNotesWorkspace,
  zoomRootId: NoteId | null,
  locallyExpandedNodeIds: ReadonlySet<NoteId> = new Set()
): FlattenedOutlineRow[] {
  const rows: Omit<
    FlattenedOutlineRow,
    "ancestorGuideDepths" | "visibleDescendantEndId"
  >[] = [];
  const visited = new Set<NoteId>();

  const visit = (nodeId: NoteId, ancestorIds: NoteId[]) => {
    if (visited.has(nodeId)) {
      return;
    }
    const node = workspace.nodesById[nodeId];
    if (!node) {
      return;
    }
    visited.add(nodeId);
    const isCollapsed =
      node.isCollapsed && !locallyExpandedNodeIds.has(node.id);
    rows.push({
      id: node.id,
      parentId: node.parentId,
      depth: ancestorIds.length,
      isCollapsed,
      ancestorIds
    });
    if (isCollapsed) {
      return;
    }
    for (const childId of workspace.childIdsByParent[nodeId] ?? []) {
      visit(childId, [...ancestorIds, nodeId]);
    }
  };

  if (zoomRootId !== null) {
    visit(zoomRootId, []);
  } else {
    for (const rootId of workspace.rootIds) {
      visit(rootId, []);
    }
  }

  const guideMetadata = deriveOutlineGuideMetadata(rows);
  return rows.map((row, index) => ({ ...row, ...guideMetadata[index] }));
}

export function deriveOutlineBodyRows(
  rows: readonly FlattenedOutlineRow[],
  zoomRootId: NoteId | null
): FlattenedOutlineRow[] {
  if (zoomRootId === null) {
    return [...rows];
  }
  if (rows[0]?.id !== zoomRootId) {
    return [];
  }

  const bodyRows = rows.slice(1).map<FlattenedOutlineRow>((row) => ({
    id: row.id,
    parentId: row.parentId,
    depth: row.depth - 1,
    isCollapsed: row.isCollapsed,
    ancestorIds: row.ancestorIds.slice(1),
    ancestorGuideDepths: [],
    visibleDescendantEndId: null
  }));
  const guideMetadata = deriveOutlineGuideMetadata(bodyRows);

  return bodyRows.map((row, index) => ({
    ...row,
    ...guideMetadata[index]
  }));
}

export function visibleNodeIds(
  workspace: NormalizedNotesWorkspace,
  zoomRootId: NoteId | null
): NoteId[] {
  return flattenVisibleOutlineRows(workspace, zoomRootId).map((row) => row.id);
}

export function parentTrail(
  workspace: NormalizedNotesWorkspace,
  nodeId: NoteId
): NoteId[] {
  const trail: NoteId[] = [];
  const visited = new Set<NoteId>();
  let currentId: NoteId | null = nodeId;

  while (currentId !== null && !visited.has(currentId)) {
    const node: NoteNode | undefined = workspace.nodesById[currentId];
    if (!node) {
      break;
    }
    visited.add(currentId);
    trail.push(currentId);
    currentId = node.parentId;
  }

  return trail.reverse();
}
