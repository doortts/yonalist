import type { NoteId } from "../../domain/notes";
import type {
  NotesHistoryFocusField
} from "./notesHistory";
import type {
  NormalizedNotesWorkspace,
  NotesSelection
} from "./notesWorkspaceReducer";
import type {
  LiveNotesNavigation,
  NotesPendingPrimarySelection
} from "./notesWorkspaceTypes";

export type NotesPaneId = "primary" | "secondary";

export interface NotesPaneSessionState {
  readonly paneId: NotesPaneId;
  readonly selectedId: NoteId | null;
  readonly zoomRootId: NoteId | null;
  readonly editingNoteId: NoteId | null;
  readonly pendingFocusId: NoteId | null;
  readonly pendingFocusField: NotesHistoryFocusField | null;
  readonly pendingPrimarySelection: NotesPendingPrimarySelection | null;
  readonly locallyExpandedNodeIds: ReadonlySet<NoteId>;
  readonly selection: NotesSelection | null;
  readonly selectionRevision: number;
  readonly navigationVersion: number;
  readonly scrollAnchorId: NoteId | null;
  readonly scrollOffset: number;
}

export type NotesPaneSessionAction =
  | {
      readonly type: "setNavigation";
      readonly patch: Partial<LiveNotesNavigation>;
    }
  | {
      readonly type: "setExpansion";
      readonly nodeIds: ReadonlySet<NoteId>;
    }
  | {
      readonly type: "setSelection";
      readonly selection: NotesSelection | null;
    }
  | {
      readonly type: "setPendingPrimarySelection";
      readonly request: NotesPendingPrimarySelection | null;
    }
  | {
      readonly type: "setScroll";
      readonly anchorId: NoteId | null;
      readonly offset: number;
    };

export function createInitialNotesPaneSession(
  paneId: NotesPaneId
): NotesPaneSessionState {
  return {
    paneId,
    selectedId: null,
    zoomRootId: null,
    editingNoteId: null,
    pendingFocusId: null,
    pendingFocusField: null,
    pendingPrimarySelection: null,
    locallyExpandedNodeIds: new Set(),
    selection: null,
    selectionRevision: 0,
    navigationVersion: 0,
    scrollAnchorId: null,
    scrollOffset: 0
  };
}

function sameSet(
  left: ReadonlySet<NoteId>,
  right: ReadonlySet<NoteId>
): boolean {
  return (
    left.size === right.size &&
    [...left].every((nodeId) => right.has(nodeId))
  );
}

function sameSelection(
  left: NotesSelection | null,
  right: NotesSelection | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftIds = left.explicitNodeIds;
  const rightIds = right.explicitNodeIds;
  return (
    left.anchorId === right.anchorId &&
    left.headId === right.headId &&
    (leftIds === rightIds ||
      (leftIds !== undefined &&
        rightIds !== undefined &&
        leftIds.length === rightIds.length &&
        leftIds.every((nodeId, index) => nodeId === rightIds[index])))
  );
}

function normalizedSelection(
  selection: NotesSelection | null
): NotesSelection | null {
  if (!selection) return null;
  return {
    ...selection,
    ...(selection.explicitNodeIds
      ? { explicitNodeIds: Object.freeze([...selection.explicitNodeIds]) }
      : {})
  };
}

export function notesPaneSessionReducer(
  state: NotesPaneSessionState,
  action: NotesPaneSessionAction
): NotesPaneSessionState {
  switch (action.type) {
    case "setNavigation": {
      const next = {
        selectedId: action.patch.selectedId ?? state.selectedId,
        zoomRootId: action.patch.zoomRootId ?? state.zoomRootId,
        editingNoteId: action.patch.editingNoteId ?? state.editingNoteId,
        pendingFocusId:
          action.patch.pendingFocusId === undefined
            ? state.pendingFocusId
            : action.patch.pendingFocusId,
        pendingFocusField:
          action.patch.pendingFocusField === undefined
            ? state.pendingFocusField
            : action.patch.pendingFocusField
      };
      if (
        next.selectedId === state.selectedId &&
        next.zoomRootId === state.zoomRootId &&
        next.editingNoteId === state.editingNoteId &&
        next.pendingFocusId === state.pendingFocusId &&
        next.pendingFocusField === state.pendingFocusField
      ) {
        return state;
      }
      return {
        ...state,
        ...next,
        navigationVersion: state.navigationVersion + 1
      };
    }
    case "setExpansion": {
      if (sameSet(state.locallyExpandedNodeIds, action.nodeIds)) return state;
      return {
        ...state,
        locallyExpandedNodeIds: new Set(action.nodeIds),
        navigationVersion: state.navigationVersion + 1
      };
    }
    case "setSelection": {
      if (sameSelection(state.selection, action.selection)) return state;
      return {
        ...state,
        selection: normalizedSelection(action.selection),
        selectionRevision: state.selectionRevision + 1
      };
    }
    case "setPendingPrimarySelection": {
      if (state.pendingPrimarySelection === action.request) return state;
      return { ...state, pendingPrimarySelection: action.request };
    }
    case "setScroll": {
      const offset =
        Number.isFinite(action.offset) && action.offset > 0 ? action.offset : 0;
      if (
        state.scrollAnchorId === action.anchorId &&
        state.scrollOffset === offset
      ) {
        return state;
      }
      return {
        ...state,
        scrollAnchorId: action.anchorId,
        scrollOffset: offset
      };
    }
  }
}

export function reconcileNotesPaneSession(
  state: NotesPaneSessionState,
  workspace: NormalizedNotesWorkspace
): NotesPaneSessionState {
  const exists = (nodeId: NoteId | null): nodeId is NoteId =>
    nodeId !== null && workspace.nodesById[nodeId] !== undefined;
  const zoomRootId = exists(state.zoomRootId) ? state.zoomRootId : null;
  const selectedId = exists(state.selectedId) ? state.selectedId : null;
  const editingNoteId = exists(state.editingNoteId)
    ? state.editingNoteId
    : null;
  const pendingFocusId = exists(state.pendingFocusId)
    ? state.pendingFocusId
    : null;
  const pendingFocusField =
    pendingFocusId === null ? null : state.pendingFocusField;
  const expansion = new Set(
    [...state.locallyExpandedNodeIds].filter((nodeId) =>
      exists(nodeId)
    )
  );
  const scrollAnchorId = exists(state.scrollAnchorId)
    ? state.scrollAnchorId
    : null;
  const scrollOffset =
    scrollAnchorId === null ? 0 : state.scrollOffset;
  const selectionIds = state.selection
    ? [
        state.selection.anchorId,
        state.selection.headId,
        ...(state.selection.explicitNodeIds ?? [])
      ]
    : [];
  const selection = selectionIds.every((nodeId) => exists(nodeId))
    ? state.selection
    : null;
  const navigationChanged =
    zoomRootId !== state.zoomRootId ||
    selectedId !== state.selectedId ||
    editingNoteId !== state.editingNoteId ||
    pendingFocusId !== state.pendingFocusId ||
    pendingFocusField !== state.pendingFocusField ||
    !sameSet(expansion, state.locallyExpandedNodeIds);
  const selectionChanged = !sameSelection(selection, state.selection);
  if (
    !navigationChanged &&
    !selectionChanged &&
    scrollAnchorId === state.scrollAnchorId &&
    scrollOffset === state.scrollOffset
  ) {
    return state;
  }
  return {
    ...state,
    zoomRootId,
    selectedId,
    editingNoteId,
    pendingFocusId,
    pendingFocusField,
    pendingPrimarySelection:
      pendingFocusId === null ? null : state.pendingPrimarySelection,
    locallyExpandedNodeIds: expansion,
    selection,
    selectionRevision:
      state.selectionRevision + (selectionChanged ? 1 : 0),
    navigationVersion:
      state.navigationVersion + (navigationChanged ? 1 : 0),
    scrollAnchorId,
    scrollOffset
  };
}
