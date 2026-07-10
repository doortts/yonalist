import type { NoteId, NoteNode } from "../../domain/notes";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";

export function visibleNodeIds(
  workspace: NormalizedNotesWorkspace,
  zoomRootId: NoteId | null
): NoteId[] {
  const visible: NoteId[] = [];
  const visited = new Set<NoteId>();

  const visit = (nodeId: NoteId) => {
    if (visited.has(nodeId)) {
      return;
    }
    const node = workspace.nodesById[nodeId];
    if (!node) {
      return;
    }
    visited.add(nodeId);
    visible.push(nodeId);
    if (node.isCollapsed) {
      return;
    }
    for (const childId of workspace.childIdsByParent[nodeId] ?? []) {
      visit(childId);
    }
  };

  if (zoomRootId !== null) {
    visit(zoomRootId);
  } else {
    for (const rootId of workspace.rootIds) {
      visit(rootId);
    }
  }

  return visible;
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
