import type { NoteId, NoteNode } from "../../domain/notes";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";

export interface FlattenedOutlineRow {
  id: NoteId;
  parentId: NoteId | null;
  depth: number;
  isCollapsed: boolean;
  ancestorIds: NoteId[];
}

export function flattenVisibleOutlineRows(
  workspace: NormalizedNotesWorkspace,
  zoomRootId: NoteId | null,
  locallyExpandedNodeIds: ReadonlySet<NoteId> = new Set()
): FlattenedOutlineRow[] {
  const rows: FlattenedOutlineRow[] = [];
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

  return rows;
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
