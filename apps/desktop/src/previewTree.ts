import type { NoteView } from "../../../packages/contracts/generated/NoteView";

export function previewDescendants(
  nodes: readonly NoteView[],
  id: string
): NoteView[] {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
    }
  }
  return nodes.filter((node) => ids.has(node.id));
}

export function previewVisibleSubtree(
  nodes: readonly NoteView[],
  id: string
): NoteView[] {
  const subtree: NoteView[] = [];
  const visit = (nodeId: string): void => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.deleted) return;
    subtree.push(node);
    previewSiblings(nodes, nodeId).forEach((child) => visit(child.id));
  };
  visit(id);
  return subtree;
}

export function previewSiblings(
  nodes: readonly NoteView[],
  parentId: string,
  excludeId?: string
): NoteView[] {
  return nodes
    .filter((node) =>
      node.parentId === parentId &&
      node.id !== excludeId &&
      !node.deleted
    )
    .sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id)
    );
}
