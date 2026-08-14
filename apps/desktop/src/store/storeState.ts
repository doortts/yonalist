import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { ViewportPage } from "../../../../packages/contracts/generated/ViewportPage";
import type { NotesState } from "../notesState";
import {
  mergeViewport, orderOutline, todoChildrenByParent
} from "../outline/outlineModel";
import { confirmedNote, confirmedText, ROOT_ID } from "./storeSupport";

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

/**
 * Ticking a Todo settles the whole chain it heads: every Todo under it takes
 * the same state, and an ancestor Todo follows once nothing below it is left
 * open. Clearing one runs the other way -- an ancestor cannot stay ticked
 * while a row under it is open again.
 *
 * Rows already holding the target state are dropped, so a plain single-row
 * toggle still travels as a single-row write.
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

export function changesOutlineStructure(
  previous: NoteView | undefined,
  changed: NoteView
): boolean {
  // The root row is the one node no outline ever draws: it is the surface
  // every other row hangs from, not a row itself.
  if (!previous) return changed.id !== ROOT_ID && !changed.deleted;
  return previous.parentId !== changed.parentId ||
    previous.sortKey !== changed.sortKey ||
    previous.kind !== changed.kind ||
    previous.marker !== changed.marker ||
    previous.collapsed !== changed.collapsed ||
    previous.completed !== changed.completed ||
    previous.starred !== changed.starred ||
    previous.deleted !== changed.deleted;
}

export function receiptState(
  state: NotesState,
  receipt: MutationReceipt
): {
  readonly patch: Partial<NotesState>;
  readonly removedDraftIds: readonly string[];
  readonly changedNodeIds: readonly string[];
  readonly outlineChanged: boolean;
} {
  const previousById = new Map(state.nodes.map((node) => [node.id, node]));
  const changedById = new Map(receipt.changedNodes.map((node) => [node.id, node]));
  const removed = new Set(receipt.deletedIds);
  const nodes = state.nodes
    .map((node) => changedById.get(node.id) ?? node)
    .filter((node) => !removed.has(node.id) && !node.deleted);
  const known = new Set(nodes.map((node) => node.id));
  let pending = receipt.changedNodes.filter((node) =>
    node.id !== ROOT_ID && !node.deleted && !known.has(node.id));
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

  // A page is nothing but a live child of the root: a bullet outdented onto
  // Home joins the list, one indented under another row leaves it.
  const pagesById = new Map(state.pages.map((page) => [page.id, page]));
  for (const node of receipt.changedNodes) {
    if (node.parentId === ROOT_ID && !node.deleted) {
      pagesById.set(node.id, {
        id: node.id,
        title: node.text,
        sortKey: node.sortKey
      });
    } else pagesById.delete(node.id);
  }
  for (const id of receipt.deletedIds) pagesById.delete(id);
  const pages = [...pagesById.values()].sort((left, right) =>
    left.sortKey - right.sortKey || left.id.localeCompare(right.id));

  // The page's own node stays out of `nodes` -- the outline guards, the body
  // rendering and the drag all read that absence -- so it is reconciled here.
  const changedPageNode = state.activePageId === null
    ? undefined
    : changedById.get(state.activePageId);
  const pageNode = state.activePageId !== null && removed.has(state.activePageId)
    ? null
    : changedPageNode
      ? (changedPageNode.deleted ? null : changedPageNode)
      : state.pageNode;

  const removedDraftIds = [
    ...receipt.deletedIds,
    ...receipt.changedNodes.filter((node) => node.deleted).map((node) => node.id)
  ];
  // A draft equal to the text on either side of the receipt is one the user
  // has not touched since it was committed, so the receipt -- an undo above
  // all -- outranks it. A draft that matches neither is typing still in
  // flight; dropping that would throw the work away.
  const staleDraft = (
    draft: string | undefined,
    committed: string,
    previous: string | undefined
  ): boolean =>
    draft !== undefined && (draft === committed || draft === previous);
  const staleTextIds = receipt.changedNodes.filter((node) => staleDraft(
    state.drafts[node.id], node.text, confirmedText(state, node.id)
  )).map((node) => node.id);
  const staleNoteIds = receipt.changedNodes.filter((node) => staleDraft(
    state.noteDrafts[node.id], node.note, confirmedNote(state, node.id)
  )).map((node) => node.id);
  const drafts = omitKeys(state.drafts, [...removedDraftIds, ...staleTextIds]);
  const noteDrafts = omitKeys(
    state.noteDrafts,
    [...removedDraftIds, ...staleNoteIds]
  );
  const changedNodeIds = [
    ...new Set([
      ...receipt.changedNodes.map((node) => node.id),
      ...receipt.deletedIds
    ])
  ];
  const outlineChanged = receipt.deletedIds.some((id) =>
    id !== ROOT_ID
  ) || receipt.changedNodes.some((node) =>
    changesOutlineStructure(previousById.get(node.id), node)
  );
  return {
    patch: {
      revision: receipt.revision,
      nodes: orderOutline(nodes, state.activePageId),
      pageNode,
      pages,
      drafts,
      noteDrafts,
      canUndo: receipt.history.canUndo,
      canRedo: receipt.history.canRedo,
      undoDepth: receipt.history.undoDepth,
      redoDepth: receipt.history.redoDepth
    },
    removedDraftIds,
    changedNodeIds,
    outlineChanged
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
    pageNode: viewport.pageNode ?? (append ? state.pageNode : null),
    beforeCursor: append ? state.beforeCursor : viewport.beforeCursor,
    afterCursor: viewport.afterCursor,
    error: null
  };
}
