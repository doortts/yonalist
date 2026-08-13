import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { bySiblingOrder } from "./outlineSortKeys";

export function mergeViewport(
  current: readonly NoteView[],
  incoming: readonly NoteView[]
): readonly NoteView[] {
  const incomingById = new Map(incoming.map((node) => [node.id, node]));
  const nodes = current.map((node) => incomingById.get(node.id) ?? node);
  const known = new Set(current.map((node) => node.id));
  for (const node of incoming) {
    if (!known.has(node.id)) nodes.push(node);
  }
  return nodes;
}

export function orderOutline(
  nodes: readonly NoteView[],
  pageId: string | null
): readonly NoteView[] {
  if (!pageId || nodes.length < 2) return nodes;
  const known = new Set(nodes.map((node) => node.id));
  const children = new Map<string, NoteView[]>();
  const roots: NoteView[] = [];
  for (const node of nodes) {
    const parentId = node.parentId;
    if (parentId === pageId || (parentId !== null && known.has(parentId))) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(node);
      children.set(parentId, siblings);
    } else {
      roots.push(node);
    }
  }
  for (const siblings of children.values()) {
    siblings.sort(bySiblingOrder);
  }
  const ordered: NoteView[] = [];
  const visited = new Set<string>();
  const visit = (node: NoteView): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    ordered.push(node);
    children.get(node.id)?.forEach(visit);
  };
  children.get(pageId)?.forEach(visit);
  roots.forEach(visit);
  nodes.forEach(visit);
  return ordered;
}

/**
 * Whether a row is somewhere a caret can actually sit. A picture row is
 * focusable -- arrow keys land on it deliberately -- but it renders a `div`,
 * not a textarea, so focus put there leaves the typist with a highlighted row
 * and nowhere to type. Anything choosing where the caret goes *after* a
 * mutation asks this first; navigation, which means to land on the picture,
 * does not.
 */
export function holdsCaret(node: NoteView | undefined): boolean {
  return node?.kind === "bullet";
}

export function outlineDepth(
  node: NoteView,
  nodes: readonly NoteView[],
  pageId: string
): number {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  let parentId = node.parentId;
  let depth = 0;
  const visited = new Set<string>();
  while (parentId && parentId !== pageId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return depth;
}
