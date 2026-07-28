import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { ViewportPage } from "../../../packages/contracts/generated/ViewportPage";
import type { NotesState } from "./notesState";
import { mergeViewport, orderOutline } from "./outlineModel";

export function omitKeys<T>(
  record: Readonly<Record<string, T>>,
  ids: readonly string[]
): Record<string, T> {
  const next = { ...record };
  ids.forEach((id) => delete next[id]);
  return next;
}

export function subtreeIds(
  nodes: readonly NoteView[],
  rootIds: readonly string[]
): readonly string[] {
  const roots = new Set(rootIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    let currentId: string | null = node.id;
    const visited = new Set<string>();
    while (currentId && visited.add(currentId)) {
      if (roots.has(currentId)) return true;
      currentId = byId.get(currentId)?.parentId ?? null;
    }
    return false;
  }).map((node) => node.id);
}

export function receiptState(
  state: NotesState,
  receipt: MutationReceipt
): {
  readonly patch: Partial<NotesState>;
  readonly removedDraftIds: readonly string[];
} {
  const changedById = new Map(receipt.changedNodes.map((node) => [node.id, node]));
  const removed = new Set(receipt.deletedIds);
  const nodes = state.nodes
    .map((node) => changedById.get(node.id) ?? node)
    .filter((node) => !removed.has(node.id) && !node.deleted);
  const known = new Set(nodes.map((node) => node.id));
  let pending = receipt.changedNodes.filter((node) =>
    node.kind === "bullet" && !node.deleted && !known.has(node.id));
  while (pending.length > 0) {
    const remaining: NoteView[] = [];
    let attached = 0;
    for (const node of pending) {
      const belongsToActivePage = node.parentId === state.activePageId ||
        (node.parentId !== null && known.has(node.parentId));
      if (belongsToActivePage) {
        nodes.push(node);
        known.add(node.id);
        attached += 1;
      } else {
        remaining.push(node);
      }
    }
    if (attached === 0) break;
    pending = remaining;
  }

  const pagesById = new Map(state.pages.map((page) => [page.id, page]));
  for (const node of receipt.changedNodes) {
    if (node.kind !== "page") continue;
    if (node.deleted) pagesById.delete(node.id);
    else pagesById.set(node.id, { id: node.id, title: node.text });
  }
  for (const id of receipt.deletedIds) pagesById.delete(id);

  const removedDraftIds = [
    ...receipt.deletedIds,
    ...receipt.changedNodes.filter((node) => node.deleted).map((node) => node.id)
  ];
  const drafts = omitKeys(state.drafts, removedDraftIds);
  const noteDrafts = omitKeys(state.noteDrafts, removedDraftIds);
  return {
    patch: {
      revision: receipt.revision,
      nodes: orderOutline(nodes, state.activePageId),
      pages: [...pagesById.values()],
      drafts,
      noteDrafts,
      canUndo: receipt.history.canUndo,
      canRedo: receipt.history.canRedo,
      undoDepth: receipt.history.undoDepth,
      redoDepth: receipt.history.redoDepth
    },
    removedDraftIds
  };
}

export function viewportState(
  state: NotesState,
  viewport: ViewportPage,
  append: boolean
): Partial<NotesState> {
  return {
    status: "ready",
    activePageId: viewport.pageId,
    nodes: append ? mergeViewport(state.nodes, viewport.nodes) : viewport.nodes,
    beforeCursor: append ? state.beforeCursor : viewport.beforeCursor,
    afterCursor: viewport.afterCursor,
    error: null
  };
}
