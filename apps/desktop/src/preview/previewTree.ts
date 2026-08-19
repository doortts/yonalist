import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { bySiblingOrder } from "../outline/outlineSortKeys";

/**
 * notes-core's own completion cascade, mirrored so the browser preview settles
 * a branch the way the desktop's server does: every row under the clicked one
 * takes the same state, and an ancestor row follows once nothing below it is
 * left open. Clearing one runs the other way -- an ancestor cannot stay ticked
 * while a row under it is open again. A marker decides nothing, and the climb
 * ends at the page, which is the surface the rows are written on.
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
  const children = new Map<string, NoteView[]>();
  for (const node of nodes) {
    if (!node.parentId || node.deleted) continue;
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node);
    else children.set(node.parentId, [node]);
  }
  const subtree = (rootId: string): readonly NoteView[] => {
    const found: NoteView[] = [];
    // Seeded with the root so a parent cycle ends the walk instead of
    // recurring forever.
    const seen = new Set<string>([rootId]);
    const descend = (parentId: string) => {
      for (const child of children.get(parentId) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        found.push(child);
        descend(child.id);
      }
    };
    descend(rootId);
    return found;
  };
  const cascaded = new Set<string>([id, ...subtree(id).map((below) => below.id)]);
  let node = byId.get(id);
  while (node?.parentId) {
    const parent = byId.get(node.parentId);
    if (!parent || parent.deleted || isPageRow(parent, byId)) break;
    if (cascaded.has(parent.id)) break;
    // The whole branch, not the row below: an ancestor with a done child that
    // still carries an open grandchild is not settled.
    const settled = subtree(parent.id).every(
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

/**
 * The one page and the rows directly under it, which the client draws as pages
 * of their own rather than as rows of an outline. A tick settles the rows
 * written on a page, never the page they are written on.
 */
function isPageRow(
  node: NoteView,
  byId: ReadonlyMap<string, NoteView>
): boolean {
  if (node.kind === "page") return true;
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  return parent?.kind === "page";
}

/**
 * The rows a command put somewhere new -- created there, moved there, brought
 * back from the trash there -- with the finished rows above them opened again:
 * an open row the branch above it never counted means the rows over it cannot go
 * on saying they are finished. A row the same command brought along keeps what
 * the command said it was, so a pasted subtree arrives as it was cut. Mirrors
 * notes-core's own pass, which runs after every command.
 */
export function reopenOverPlacedRows(
  before: readonly NoteView[],
  after: readonly NoteView[]
): readonly string[] {
  const beforeById = new Map(before.map((node) => [node.id, node]));
  const afterById = new Map(after.map((node) => [node.id, node]));
  const reopened = new Set<string>();
  const placed = after.filter((node) => {
    if (node.deleted || node.completed) return false;
    const previous = beforeById.get(node.id);
    return !previous || previous.deleted || previous.parentId !== node.parentId;
  });
  for (const node of placed) {
    // Seeded with the placed row so a parent cycle ends the walk.
    const seen = new Set<string>([node.id]);
    let current = node;
    while (current.parentId) {
      const parent = afterById.get(current.parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      if (parent.deleted || isPageRow(parent, afterById)) break;
      if (parent.completed && beforeById.has(parent.id)) reopened.add(parent.id);
      current = parent;
    }
  }
  return [...reopened];
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
