import type {
  NoteAttachment,
  NoteAttachmentsByNodeId,
  NoteId,
  NoteNode,
  NotesWorkspace
} from "../../domain/notes";
import type { NotesHistoryFocusField } from "./notesHistory";

export interface NormalizedNotesWorkspace {
  nodesById: Record<NoteId, NoteNode>;
  childIdsByParent: Record<string, NoteId[]>;
  rootIds: NoteId[];
  attachmentsByNodeId: NoteAttachmentsByNodeId;
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  pendingFocusField: NotesHistoryFocusField | null;
  status: "loading" | "ready" | "error";
  error: string | null;
}

export type UiState = Pick<
  NormalizedNotesWorkspace,
  | "selectedId"
  | "zoomRootId"
  | "editingNoteId"
  | "pendingFocusId"
  | "pendingFocusField"
>;

/**
 * Multi-node selection anchor/head pair (plan Phase 4.1). The selection is the
 * inclusive range between `anchorId` and `headId` computed against the visible
 * outline row ordering — see {@link selectionRangeIds}. Storing only the two
 * endpoints (rather than the materialized id set) keeps the range live: it is
 * re-derived against the current visible rows whenever those change.
 *
 * Selection is deliberately NOT a field of {@link NormalizedNotesWorkspace}. The
 * memoized outline rows (Phase 2.2) read the workspace projection off the state
 * context but never read selection, so keeping selection in its own reducer
 * (owned by the workspace hook, exposed through the high-volatility drafts
 * slice) means a shift+arrow extension re-renders only the pane and the rows
 * whose membership actually flipped — the state-context object the rows
 * subscribe to is untouched. It is also settle-agnostic: background draft
 * autosaves re-normalize the workspace but never disturb the selection reducer,
 * so a live range survives an autosave that happens to land mid-selection.
 */
export interface NotesSelection {
  anchorId: NoteId;
  headId: NoteId;
}

export type NotesSelectionAction =
  | { type: "setSelectionAnchor"; anchorId: NoteId }
  | { type: "extendSelectionTo"; headId: NoteId }
  | { type: "clearSelection" };

/**
 * The selection reducer. `setSelectionAnchor` starts a single-node selection at
 * `anchorId`; `extendSelectionTo` moves the head while pinning the anchor (or
 * degenerates to a single node when there is no live anchor); `clearSelection`
 * drops the selection. Returning the identical `null` reference for a clear of
 * an already-empty selection lets React bail out of the dispatch without a
 * re-render.
 */
export function notesSelectionReducer(
  state: NotesSelection | null,
  action: NotesSelectionAction
): NotesSelection | null {
  switch (action.type) {
    case "setSelectionAnchor":
      return { anchorId: action.anchorId, headId: action.anchorId };
    case "extendSelectionTo":
      return {
        anchorId: state ? state.anchorId : action.headId,
        headId: action.headId
      };
    case "clearSelection":
      return null;
  }
}

/**
 * Materialize the selected ids as the inclusive slice of `visibleNodeIds`
 * between the anchor and head (in either order). An empty selection, or one
 * whose endpoints are not both currently visible (e.g. a collapsed or filtered
 * row), yields an empty range rather than a partial guess.
 */
export function selectionRangeIds(
  selection: NotesSelection | null,
  visibleNodeIds: readonly NoteId[]
): NoteId[] {
  if (!selection) {
    return [];
  }
  const anchorIndex = visibleNodeIds.indexOf(selection.anchorId);
  const headIndex = visibleNodeIds.indexOf(selection.headId);
  if (anchorIndex < 0 || headIndex < 0) {
    return [];
  }
  const start = Math.min(anchorIndex, headIndex);
  const end = Math.max(anchorIndex, headIndex);
  return visibleNodeIds.slice(start, end + 1);
}

export type NotesWorkspaceReducerAction =
  | { type: "startWorkspaceLoad" }
  | { type: "setLoading" }
  | {
      type: "settleQueueWork";
      result:
        | {
            kind: "authoritative";
            workspace: NotesWorkspace;
            uiUpdate?: Partial<UiState>;
            /**
             * Scope-consistent incremental delta. When present, the store is
             * patched from it instead of re-normalizing the full workspace. The
             * projection layer only attaches this for the active scope (see
             * {@link settleWorkspaceStore}); every other settle path leaves it
             * absent so the full workspace stays authoritative.
             */
            delta?: NotesWorkspaceDelta;
          }
        | { kind: "skipped" }
        | {
            kind: "failure";
            error: string;
            workspace?: NotesWorkspace;
            uiUpdate?: Partial<UiState>;
          };
      hasPendingWork: boolean;
    }
  | ({ type: "setUiState" } & Partial<UiState>)
  | { type: "focusNode"; nodeId: NoteId }
  | { type: "acknowledgePendingFocus"; nodeId: NoteId }
  | { type: "setZoomRoot"; zoomRootId: NoteId | null };

function compareNodes(left: NoteNode, right: NoteNode): number {
  return left.sortKey - right.sortKey || left.id.localeCompare(right.id);
}

function compareAttachments(left: NoteAttachment, right: NoteAttachment): number {
  return left.sortKey - right.sortKey || left.id.localeCompare(right.id);
}

function existingId(
  workspace: NormalizedNotesWorkspace,
  id: NoteId | null
): NoteId | null {
  return id !== null && workspace.nodesById[id] ? id : null;
}

function normalizedUiState(
  workspace: NormalizedNotesWorkspace,
  ui: UiState
): UiState {
  const pendingFocusId = existingId(workspace, ui.pendingFocusId);
  return {
    selectedId: existingId(workspace, ui.selectedId),
    zoomRootId: existingId(workspace, ui.zoomRootId),
    editingNoteId: existingId(workspace, ui.editingNoteId),
    pendingFocusId,
    pendingFocusField:
      pendingFocusId === null ? null : (ui.pendingFocusField ?? "title")
  };
}

/**
 * The single UI-state reconciler. Given the authoritative workspace, the
 * current navigation, and an optional update, it drops ids that no longer
 * exist, applies the update field-by-field (undefined = retain), and normalizes
 * the pending-focus pairing. The reducer settles navigation through this on
 * every mutation; the hook reuses it (via {@link reconcileUiState}) to compute
 * the "after" snapshot for history, so both agree on exactly one settled shape.
 */
export function settledUiState(
  workspace: NormalizedNotesWorkspace,
  current: UiState,
  uiUpdate?: Partial<UiState>
): UiState {
  const retainedUi = normalizedUiState(workspace, current);
  return normalizedUiState(workspace, {
    selectedId:
      uiUpdate?.selectedId === undefined
        ? retainedUi.selectedId
        : uiUpdate.selectedId,
    zoomRootId:
      uiUpdate?.zoomRootId === undefined
        ? retainedUi.zoomRootId
        : uiUpdate.zoomRootId,
    editingNoteId:
      uiUpdate?.editingNoteId === undefined
        ? retainedUi.editingNoteId
        : uiUpdate.editingNoteId,
    pendingFocusId:
      uiUpdate?.pendingFocusId === undefined
        ? retainedUi.pendingFocusId
        : uiUpdate.pendingFocusId,
    pendingFocusField:
      uiUpdate?.pendingFocusField === undefined
        ? retainedUi.pendingFocusField
        : uiUpdate.pendingFocusField
  });
}

/**
 * {@link settledUiState} against a not-yet-normalized workspace. The hook holds
 * navigation results as raw {@link NotesWorkspace}s (mutation projections), so
 * this normalizes then delegates — one reconciler, two entry points.
 */
export function reconcileUiState(
  workspace: NotesWorkspace,
  current: UiState,
  uiUpdate?: Partial<UiState>
): UiState {
  return settledUiState(normalizeWorkspace(workspace), current, uiUpdate);
}

export function normalizeWorkspace(workspace: NotesWorkspace): NormalizedNotesWorkspace {
  const nodesById = Object.create(null) as Record<NoteId, NoteNode>;
  const childIdsByParent = Object.create(null) as Record<string, NoteId[]>;
  const attachmentsByNodeId = Object.create(null) as NoteAttachmentsByNodeId;
  const rootIds: NoteId[] = [];

  for (const node of workspace.nodes) {
    nodesById[node.id] = node;
  }

  for (const node of Object.values(nodesById).sort(compareNodes)) {
    if (node.parentId === null) {
      rootIds.push(node.id);
      continue;
    }
    (childIdsByParent[node.parentId] ??= []).push(node.id);
  }

  for (const [nodeId, attachments] of Object.entries(
    workspace.attachmentsByNodeId ?? {}
  )) {
    attachmentsByNodeId[nodeId] = [...attachments];
  }

  return {
    nodesById,
    childIdsByParent,
    rootIds,
    attachmentsByNodeId,
    selectedId: null,
    zoomRootId: null,
    editingNoteId: null,
    pendingFocusId: null,
    pendingFocusField: null,
    status: "ready",
    error: null
  };
}

/**
 * The scope-consistent incremental view of a single mutation, mirroring the
 * backend audit delta ({@link NotesMutationResult}) but already reconciled to
 * the store's scope by the projection layer:
 *
 * - `changedNodes` — nodes to upsert; each carries the authoritative
 *   `parentId`/`sortKey`, so sibling order is derived from the node itself.
 * - `removedNodeIds` — nodes to drop (hard-deleted rows plus any node that left
 *   the scope, e.g. a soft-deleted node in the active scope).
 * - `changedAttachments` — attachments to upsert; removals are never surfaced
 *   here (a removed attachment's node is either dropped via `removedNodeIds` or
 *   the whole settle falls back to full normalization).
 */
export interface NotesWorkspaceDelta {
  changedNodes: NoteNode[];
  removedNodeIds: NoteId[];
  changedAttachments: NoteAttachment[];
}

function cloneNullProtoRecord<T>(source: Record<string, T>): Record<string, T> {
  const clone = Object.create(null) as Record<string, T>;
  for (const key of Object.keys(source)) {
    clone[key] = source[key];
  }
  return clone;
}

/**
 * Patch a normalized store from a scope-consistent {@link NotesWorkspaceDelta},
 * touching only the affected nodes/parents/attachment lists instead of
 * re-normalizing (and re-sorting) the whole workspace. The result is shaped
 * exactly like {@link normalizeWorkspace}'s output (UI fields reset, status
 * "ready") so it is a drop-in replacement in the settle path.
 *
 * Sibling and attachment ordering is preserved by removing an entry from its
 * old position and re-inserting it at the sorted position derived from the
 * authoritative `sortKey`/`id` — identical to the total order
 * {@link normalizeWorkspace} produces. Untouched arrays are shared with the
 * prior store; touched arrays are cloned copy-on-write so the prior state stays
 * immutable.
 */
export function applyWorkspaceDelta(
  state: NormalizedNotesWorkspace,
  delta: NotesWorkspaceDelta
): NormalizedNotesWorkspace {
  const nodesById = cloneNullProtoRecord(state.nodesById);
  const childIdsByParent = cloneNullProtoRecord(state.childIdsByParent);
  const attachmentsByNodeId = cloneNullProtoRecord(state.attachmentsByNodeId);
  let rootIds = state.rootIds;
  let rootIdsCloned = false;
  const clonedChildKeys = new Set<string>();
  const clonedAttachmentKeys = new Set<string>();

  const rootList = (): NoteId[] => {
    if (!rootIdsCloned) {
      rootIds = [...rootIds];
      rootIdsCloned = true;
    }
    return rootIds;
  };
  const childListFor = (parentId: NoteId): NoteId[] => {
    if (!clonedChildKeys.has(parentId)) {
      childIdsByParent[parentId] = childIdsByParent[parentId]
        ? [...childIdsByParent[parentId]]
        : [];
      clonedChildKeys.add(parentId);
    }
    return childIdsByParent[parentId];
  };
  const attachmentListFor = (nodeId: NoteId): NoteAttachment[] => {
    if (!clonedAttachmentKeys.has(nodeId)) {
      attachmentsByNodeId[nodeId] = attachmentsByNodeId[nodeId]
        ? [...attachmentsByNodeId[nodeId]]
        : [];
      clonedAttachmentKeys.add(nodeId);
    }
    return attachmentsByNodeId[nodeId];
  };

  const detachFromParent = (node: NoteNode): void => {
    if (node.parentId === null) {
      const list = rootList();
      const index = list.indexOf(node.id);
      if (index >= 0) {
        list.splice(index, 1);
      }
      return;
    }
    if (!childIdsByParent[node.parentId]) {
      return;
    }
    const list = childListFor(node.parentId);
    const index = list.indexOf(node.id);
    if (index >= 0) {
      list.splice(index, 1);
    }
    if (list.length === 0) {
      delete childIdsByParent[node.parentId];
      clonedChildKeys.delete(node.parentId);
    }
  };

  const insertIntoSiblings = (node: NoteNode): void => {
    const list =
      node.parentId === null ? rootList() : childListFor(node.parentId);
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareNodes(nodesById[list[mid]], node) <= 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    list.splice(low, 0, node.id);
  };

  for (const node of delta.changedNodes) {
    const previous = nodesById[node.id];
    if (previous) {
      detachFromParent(previous);
    }
    nodesById[node.id] = node;
    insertIntoSiblings(node);
  }

  for (const removedId of delta.removedNodeIds) {
    const previous = nodesById[removedId];
    if (previous) {
      detachFromParent(previous);
    }
    delete nodesById[removedId];
    if (attachmentsByNodeId[removedId]) {
      delete attachmentsByNodeId[removedId];
      clonedAttachmentKeys.delete(removedId);
    }
  }

  for (const change of delta.changedAttachments) {
    if (!nodesById[change.nodeId]) {
      continue;
    }
    const list = attachmentListFor(change.nodeId);
    const existingIndex = list.findIndex(
      (candidate) => candidate.id === change.id
    );
    if (existingIndex >= 0) {
      list.splice(existingIndex, 1);
    }
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareAttachments(list[mid], change) <= 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    list.splice(low, 0, change);
  }

  return {
    nodesById,
    childIdsByParent,
    rootIds,
    attachmentsByNodeId,
    selectedId: null,
    zoomRootId: null,
    editingNoteId: null,
    pendingFocusId: null,
    pendingFocusField: null,
    status: "ready",
    error: null
  };
}

// Transition-safety gate (plan Phase 3.4 risk table): in dev builds every
// delta-applied settle is re-derived from the full workspace payload and
// deep-compared, falling back to the full result on divergence. Production
// trusts the delta. The flag is module-level so tests can force-enable it
// regardless of the build's `import.meta.env.DEV`.
function readDevFlag(): boolean {
  const meta = import.meta as unknown as { env?: { DEV?: boolean } };
  return meta.env?.DEV === true;
}

let deltaVerificationEnabled = readDevFlag();

export function setNotesDeltaVerificationEnabled(enabled: boolean): void {
  deltaVerificationEnabled = enabled;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => valuesEqual(item, right[index]));
  }
  if (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    if (leftKeys.length !== Object.keys(rightRecord).length) {
      return false;
    }
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        valuesEqual(leftRecord[key], rightRecord[key])
    );
  }
  return false;
}

export interface NormalizedStoreDiff {
  rootIdsDiffer: boolean;
  nodeIdsOnlyInDelta: NoteId[];
  nodeIdsOnlyInFull: NoteId[];
  nodesWithDifferentValues: NoteId[];
  parentsWithDifferentChildren: string[];
  nodesWithDifferentAttachments: NoteId[];
}

function diffNormalizedStores(
  patched: NormalizedNotesWorkspace,
  full: NormalizedNotesWorkspace
): NormalizedStoreDiff | null {
  const nodeIdsOnlyInDelta = Object.keys(patched.nodesById).filter(
    (id) => !(id in full.nodesById)
  );
  const nodeIdsOnlyInFull = Object.keys(full.nodesById).filter(
    (id) => !(id in patched.nodesById)
  );
  const nodesWithDifferentValues = Object.keys(patched.nodesById).filter(
    (id) => id in full.nodesById && !valuesEqual(patched.nodesById[id], full.nodesById[id])
  );
  const parentKeys = new Set([
    ...Object.keys(patched.childIdsByParent),
    ...Object.keys(full.childIdsByParent)
  ]);
  const parentsWithDifferentChildren = [...parentKeys].filter(
    (parentId) =>
      !valuesEqual(
        patched.childIdsByParent[parentId],
        full.childIdsByParent[parentId]
      )
  );
  const attachmentKeys = new Set([
    ...Object.keys(patched.attachmentsByNodeId),
    ...Object.keys(full.attachmentsByNodeId)
  ]);
  const nodesWithDifferentAttachments = [...attachmentKeys].filter(
    (nodeId) =>
      !valuesEqual(
        patched.attachmentsByNodeId[nodeId],
        full.attachmentsByNodeId[nodeId]
      )
  );
  const rootIdsDiffer = !valuesEqual(patched.rootIds, full.rootIds);

  if (
    !rootIdsDiffer &&
    nodeIdsOnlyInDelta.length === 0 &&
    nodeIdsOnlyInFull.length === 0 &&
    nodesWithDifferentValues.length === 0 &&
    parentsWithDifferentChildren.length === 0 &&
    nodesWithDifferentAttachments.length === 0
  ) {
    return null;
  }
  return {
    rootIdsDiffer,
    nodeIdsOnlyInDelta,
    nodeIdsOnlyInFull,
    nodesWithDifferentValues,
    parentsWithDifferentChildren,
    nodesWithDifferentAttachments
  };
}

/**
 * Compute the settled store for an authoritative result. With a
 * {@link NotesWorkspaceDelta} present the store is patched incrementally; with
 * the delta absent (initial load, scope change, non-active projection, or a
 * mutation whose delta cannot be trusted) the full workspace is normalized as
 * before. In dev the delta path is verified against a full normalization and
 * falls back — with a structured `console.error` — on any divergence.
 */
export function settleWorkspaceStore(
  state: NormalizedNotesWorkspace,
  workspace: NotesWorkspace,
  delta: NotesWorkspaceDelta | undefined
): NormalizedNotesWorkspace {
  if (!delta) {
    return normalizeWorkspace(workspace);
  }
  const patched = applyWorkspaceDelta(state, delta);
  if (!deltaVerificationEnabled) {
    return patched;
  }
  const full = normalizeWorkspace(workspace);
  const diff = diffNormalizedStores(patched, full);
  if (diff) {
    console.error(
      "Notes incremental mutation delta diverged from the full workspace payload; falling back to full normalization.",
      diff
    );
    return full;
  }
  return patched;
}

export function notesWorkspaceReducer(
  state: NormalizedNotesWorkspace,
  action: NotesWorkspaceReducerAction
): NormalizedNotesWorkspace {
  switch (action.type) {
    case "settleQueueWork": {
      if (action.result.kind === "failure") {
        if (action.result.workspace) {
          const workspace = normalizeWorkspace(action.result.workspace);
          return {
            ...workspace,
            ...settledUiState(workspace, state, action.result.uiUpdate),
            status: action.hasPendingWork ? "loading" : "error",
            error: action.result.error
          };
        }
        return {
          ...state,
          status: action.hasPendingWork ? "loading" : "error",
          error: action.result.error
        };
      }

      if (action.result.kind === "skipped") {
        return {
          ...state,
          status: action.hasPendingWork
            ? "loading"
            : state.error
              ? "error"
              : "ready"
        };
      }

      const workspace = settleWorkspaceStore(
        state,
        action.result.workspace,
        action.result.delta
      );
      return {
        ...workspace,
        ...settledUiState(workspace, state, action.result.uiUpdate),
        status: action.hasPendingWork ? "loading" : "ready"
      };
    }
    case "startWorkspaceLoad":
      return {
        ...normalizeWorkspace({ nodes: [] }),
        status: "loading"
      };
    case "setLoading":
      return { ...state, status: "loading" };
    case "setZoomRoot":
      return {
        ...state,
        zoomRootId: existingId(state, action.zoomRootId)
      };
    case "focusNode":
      return existingId(state, action.nodeId) === null
        ? state
        : {
            ...state,
            selectedId: action.nodeId,
            editingNoteId: action.nodeId,
            pendingFocusId: action.nodeId,
            pendingFocusField: "title"
          };
    case "acknowledgePendingFocus":
      return state.pendingFocusId === action.nodeId
        ? { ...state, pendingFocusId: null, pendingFocusField: null }
        : state;
    case "setUiState": {
      const ui: UiState = {
        selectedId:
          action.selectedId === undefined ? state.selectedId : action.selectedId,
        zoomRootId:
          action.zoomRootId === undefined ? state.zoomRootId : action.zoomRootId,
        editingNoteId:
          action.editingNoteId === undefined
            ? state.editingNoteId
            : action.editingNoteId,
        pendingFocusId:
          action.pendingFocusId === undefined
            ? state.pendingFocusId
            : action.pendingFocusId,
        pendingFocusField:
          action.pendingFocusField === undefined
            ? state.pendingFocusField
            : action.pendingFocusField
      };
      return { ...state, ...normalizedUiState(state, ui) };
    }
  }
}
