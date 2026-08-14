import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { todoChildrenByParent } from "../outline/outlineModel";
import { bySiblingOrder } from "../outline/outlineSortKeys";

/**
 * notes-core's own completion cascade, mirrored so the browser preview settles
 * a Todo chain the way the desktop's server does: every Todo under the clicked
 * row takes the same state, and an ancestor Todo follows once nothing below it
 * is left open. Clearing one runs the other way -- an ancestor cannot stay
 * ticked while a row under it is open again.
 *
 * Rows already holding the target state are dropped, so a plain single-row
 * toggle still writes a single row.
 */
export function completionCascade(
  nodes: readonly NoteView[],
  id: string,
  completed: boolean
): readonly string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const todoChildren = todoChildrenByParent(nodes);
  const todoSubtree = (rootId: string): readonly NoteView[] => {
    const found: NoteView[] = [];
    // Seeded with the root so a parent cycle ends the walk instead of
    // recurring forever.
    const seen = new Set<string>([rootId]);
    const descend = (parentId: string) => {
      for (const child of todoChildren.get(parentId) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        found.push(child);
        descend(child.id);
      }
    };
    descend(rootId);
    return found;
  };
  const cascaded = new Set<string>([
    id, ...todoSubtree(id).map((below) => below.id)
  ]);
  let node = byId.get(id);
  while (node?.parentId) {
    const parent = byId.get(node.parentId);
    if (!parent || parent.deleted || parent.marker !== "todo") break;
    if (cascaded.has(parent.id)) break;
    // The whole branch, not the row below: an ancestor with a done child that
    // still carries an open grandchild is not settled.
    const settled = todoSubtree(parent.id).every(
      (below) => cascaded.has(below.id) || below.completed
    );
    if (completed && !settled) break;
    cascaded.add(parent.id);
    node = parent;
  }
  return [...cascaded].filter(
    (cascadedId) => byId.get(cascadedId)?.completed !== completed
  );
}

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
    .sort(bySiblingOrder);
}
