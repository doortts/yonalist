import type {
  NoteId,
  NoteNode,
  NoteTagFilter,
  NoteTagSummary,
  NotesWorkspace,
  NotesWorkspaceScope
} from "../../domain/notes";
import type { NotesWorkspaceUiUpdate } from "./notesWorkspaceCoordinator";
import {
  notesExpansionSnapshotPool,
  type NotesHistoryLocationSnapshot,
  type NotesHistorySnapshot
} from "./notesHistory";
import {
  normalizeWorkspace,
  type NormalizedNotesWorkspace
} from "./notesWorkspaceReducer";
import {
  canonicalizeTagFilters,
  noteTagFilterFromLegacyScope,
  sameScope,
  tagFilterKey
} from "./notesWorkspaceScope";
import type {
  NotesLibraryView,
  TagFilterOrigin
} from "./notesWorkspaceTypes";

export interface SearchNavigation {
  rootId: NoteId;
  expandedNodeIds: Set<NoteId>;
}

export interface ResolvedHistoryLocation {
  readonly workspace: NormalizedNotesWorkspace;
  /** A newly acquired snapshot owned by the caller until it is transferred. */
  readonly snapshot: NotesHistorySnapshot;
  readonly tagSummaries?: readonly NoteTagSummary[];
}

export interface NavigationOrigin {
  readonly workspace: NormalizedNotesWorkspace;
  readonly snapshot: NotesHistorySnapshot;
}

export type NavigationIntent = (
  origin: NavigationOrigin
) => Promise<ResolvedHistoryLocation | null>;

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function scopeForLibraryView(
  view: Exclude<NotesLibraryView, "tags">
): NotesWorkspaceScope {
  switch (view) {
    case "all":
      return { kind: "active" };
    case "starred":
      return { kind: "starred" };
    case "recent":
      return { kind: "recent" };
    case "archive":
      return { kind: "archive" };
    case "trash":
      return { kind: "trash" };
  }
}

export function cloneWorkspaceScope(
  scope: NotesWorkspaceScope
): NotesWorkspaceScope {
  return scope.kind === "tags"
    ? { kind: "tags", tags: canonicalizeTagFilters(scope.tags) }
    : { ...scope };
}

export function cloneOwnedHistorySnapshot(
  snapshot: NotesHistorySnapshot
): NotesHistorySnapshot {
  return {
    ...snapshot,
    scope: cloneWorkspaceScope(snapshot.scope),
    activeTagFilters: canonicalizeTagFilters(snapshot.activeTagFilters),
    expansion: notesExpansionSnapshotPool.acquire(snapshot.expansion.nodeIds),
    focus: snapshot.focus ? { ...snapshot.focus } : null,
    tagFilterOrigin: snapshot.tagFilterOrigin
      ? {
          ...snapshot.tagFilterOrigin,
          scope: cloneWorkspaceScope(snapshot.tagFilterOrigin.scope),
          activeTagFilters: canonicalizeTagFilters(
            snapshot.tagFilterOrigin.activeTagFilters
          ),
          expansion: notesExpansionSnapshotPool.acquire(
            snapshot.tagFilterOrigin.expansion.nodeIds
          ),
          focus: snapshot.tagFilterOrigin.focus
            ? { ...snapshot.tagFilterOrigin.focus }
            : null
        }
      : null
  };
}

export function releaseOwnedHistorySnapshot(
  snapshot: NotesHistorySnapshot
): void {
  notesExpansionSnapshotPool.release(snapshot.expansion);
  if (snapshot.tagFilterOrigin) {
    notesExpansionSnapshotPool.release(snapshot.tagFilterOrigin.expansion);
  }
}

export function sameHistoryLocation(
  left: NotesHistoryLocationSnapshot,
  right: NotesHistoryLocationSnapshot
): boolean {
  const sameIds = (a: readonly NoteId[], b: readonly NoteId[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  const leftTags = canonicalizeTagFilters(left.activeTagFilters);
  const rightTags = canonicalizeTagFilters(right.activeTagFilters);
  return (
    sameScope(left.scope, right.scope) &&
    left.libraryView === right.libraryView &&
    leftTags.length === rightTags.length &&
    leftTags.every(
      (filter, index) => tagFilterKey(filter) === tagFilterKey(rightTags[index]!)
    ) &&
    left.selectedId === right.selectedId &&
    left.zoomRootId === right.zoomRootId &&
    sameIds(left.expansion.nodeIds, right.expansion.nodeIds) &&
    left.focus?.nodeId === right.focus?.nodeId &&
    left.focus?.field === right.focus?.field
  );
}

export function sameHistorySnapshot(
  left: NotesHistorySnapshot,
  right: NotesHistorySnapshot
): boolean {
  if (!sameHistoryLocation(left, right)) return false;
  const leftOrigin = left.tagFilterOrigin ?? null;
  const rightOrigin = right.tagFilterOrigin ?? null;
  return leftOrigin === null || rightOrigin === null
    ? leftOrigin === rightOrigin
    : sameHistoryLocation(leftOrigin, rightOrigin);
}

export function freezeActiveAuthorityWorkspace(
  workspace: NotesWorkspace
): NormalizedNotesWorkspace {
  const nodes = workspace.nodes.map((node) => Object.freeze({ ...node }));
  const attachmentsByNodeId = Object.fromEntries(
    Object.entries(workspace.attachmentsByNodeId ?? {}).map(
      ([nodeId, attachments]) => [
        nodeId,
        attachments.map((item) => Object.freeze({ ...item }))
      ]
    )
  );
  const normalized = normalizeWorkspace({ nodes, attachmentsByNodeId });
  for (const childIds of Object.values(normalized.childIdsByParent)) {
    Object.freeze(childIds);
  }
  for (const attachments of Object.values(normalized.attachmentsByNodeId)) {
    Object.freeze(attachments);
  }
  Object.freeze(normalized.nodesById);
  Object.freeze(normalized.childIdsByParent);
  Object.freeze(normalized.rootIds);
  Object.freeze(normalized.attachmentsByNodeId);
  return Object.freeze(normalized);
}

export function libraryStateForScope(scope: NotesWorkspaceScope): {
  view: Exclude<NotesLibraryView, "tags"> | "tags";
  filters: readonly NoteTagFilter[];
} {
  switch (scope.kind) {
    case "active":
      return { view: "all", filters: [] };
    case "starred":
      return { view: "starred", filters: [] };
    case "recent":
      return { view: "recent", filters: [] };
    case "archive":
      return { view: "archive", filters: [] };
    case "trash":
      return { view: "trash", filters: [] };
    case "tag": {
      const filter = noteTagFilterFromLegacyScope(scope.tag);
      return { view: "tags", filters: filter ? [filter] : [] };
    }
    case "tags":
      return { view: "tags", filters: canonicalizeTagFilters(scope.tags) };
  }
}

export function restoredTagFilterNavigation(
  workspace: NotesWorkspace,
  origin: TagFilterOrigin
): { uiUpdate: NotesWorkspaceUiUpdate; expandedNodeIds: ReadonlySet<NoteId> } {
  const normalized = normalizeWorkspace(workspace);
  const existing = (nodeId: NoteId | null): NoteId | null | undefined =>
    nodeId === null
      ? null
      : normalized.nodesById[nodeId]
        ? nodeId
        : undefined;
  const fallbackId = normalized.rootIds[0] ?? null;
  const restoredZoomRootId = existing(origin.navigation.zoomRootId);
  const zoomRootId =
    restoredZoomRootId === undefined ? fallbackId : restoredZoomRootId;
  const restoredSelectedId = existing(origin.navigation.selectedId);
  const selectedId =
    restoredSelectedId === undefined
      ? zoomRootId ?? fallbackId
      : restoredSelectedId;
  const editingNoteId = existing(origin.navigation.editingNoteId) ?? null;
  const pendingFocusId = existing(origin.navigation.pendingFocusId) ?? null;
  return {
    uiUpdate: {
      selectedId,
      zoomRootId,
      editingNoteId,
      pendingFocusId,
      pendingFocusField:
        pendingFocusId === null ? null : origin.navigation.pendingFocusField
    },
    expandedNodeIds: new Set(
      [...origin.locallyExpandedNodeIds].filter((nodeId) =>
        Boolean(normalized.nodesById[nodeId])
      )
    )
  };
}

export function snapshotForTagFilterOrigin(
  origin: TagFilterOrigin
): NotesHistoryLocationSnapshot {
  return {
    scope: cloneWorkspaceScope(origin.scope),
    libraryView: origin.libraryView,
    activeTagFilters: [],
    selectedId: origin.navigation.selectedId,
    zoomRootId: origin.navigation.zoomRootId,
    expansion: notesExpansionSnapshotPool.acquire([
      ...origin.locallyExpandedNodeIds
    ]),
    focus: origin.navigation.editingNoteId
      ? {
          nodeId: origin.navigation.editingNoteId,
          field: origin.navigation.pendingFocusField ?? "title"
        }
      : null
  };
}

export function tagFilterOriginFromHistoryLocation(
  location: NotesHistoryLocationSnapshot
): TagFilterOrigin {
  const library = libraryStateForScope(location.scope);
  return {
    scope:
      library.view === "tags"
        ? { kind: "active" }
        : cloneWorkspaceScope(location.scope),
    libraryView: library.view === "tags" ? "all" : library.view,
    navigation: {
      selectedId: location.selectedId,
      zoomRootId: location.zoomRootId,
      editingNoteId: location.focus?.nodeId ?? null,
      pendingFocusId: location.focus?.nodeId ?? null,
      pendingFocusField: location.focus?.field ?? null
    },
    locallyExpandedNodeIds: new Set(location.expansion.nodeIds)
  };
}

export function searchNavigation(
  workspace: NotesWorkspace,
  nodeId: NoteId
): SearchNavigation | null {
  const normalized = normalizeWorkspace(workspace);
  if (!normalized.nodesById[nodeId]) return null;

  const trail: NoteId[] = [];
  const visited = new Set<NoteId>();
  let currentId: NoteId | null = nodeId;
  while (currentId !== null && !visited.has(currentId)) {
    const node: NoteNode | undefined = normalized.nodesById[currentId];
    if (!node) return null;
    visited.add(currentId);
    trail.push(currentId);
    currentId = node.parentId;
  }
  const orderedTrail = trail.reverse();
  const rootId = orderedTrail[0];
  if (!rootId) return null;
  return {
    rootId,
    expandedNodeIds: new Set(
      orderedTrail
        .slice(0, -1)
        .filter((id) => normalized.nodesById[id]?.isCollapsed)
    )
  };
}
