import type { NoteId, NoteNode, NotesWorkspace } from "../../domain/notes";

export interface NormalizedNotesWorkspace {
  nodesById: Record<NoteId, NoteNode>;
  childIdsByParent: Record<string, NoteId[]>;
  rootIds: NoteId[];
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  status: "loading" | "ready" | "error";
  error: string | null;
}

type UiState = Pick<
  NormalizedNotesWorkspace,
  "selectedId" | "zoomRootId" | "editingNoteId" | "pendingFocusId"
>;

export type NotesWorkspaceReducerAction =
  | { type: "startWorkspaceLoad" }
  | { type: "setLoading" }
  | {
      type: "settleQueueWork";
      result:
        | {
            kind: "success";
            workspace: NotesWorkspace;
            uiUpdate?: Partial<UiState>;
          }
        | { kind: "failure"; error: string };
      hasPendingWork: boolean;
    }
  | ({ type: "setUiState" } & Partial<UiState>)
  | { type: "setZoomRoot"; zoomRootId: NoteId | null };

function compareNodes(left: NoteNode, right: NoteNode): number {
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
  return {
    selectedId: existingId(workspace, ui.selectedId),
    zoomRootId: existingId(workspace, ui.zoomRootId),
    editingNoteId: existingId(workspace, ui.editingNoteId),
    pendingFocusId: existingId(workspace, ui.pendingFocusId)
  };
}

export function normalizeWorkspace(workspace: NotesWorkspace): NormalizedNotesWorkspace {
  const nodesById = Object.create(null) as Record<NoteId, NoteNode>;
  const childIdsByParent = Object.create(null) as Record<string, NoteId[]>;
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

  return {
    nodesById,
    childIdsByParent,
    rootIds,
    selectedId: null,
    zoomRootId: null,
    editingNoteId: null,
    pendingFocusId: null,
    status: "ready",
    error: null
  };
}

export function notesWorkspaceReducer(
  state: NormalizedNotesWorkspace,
  action: NotesWorkspaceReducerAction
): NormalizedNotesWorkspace {
  switch (action.type) {
    case "settleQueueWork": {
      if (action.result.kind === "failure") {
        return {
          ...state,
          status: action.hasPendingWork ? "loading" : "error",
          error: action.result.error
        };
      }

      const workspace = normalizeWorkspace(action.result.workspace);
      const retainedUi = normalizedUiState(workspace, state);
      const uiUpdate = action.result.uiUpdate;
      return {
        ...workspace,
        ...normalizedUiState(workspace, {
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
              : uiUpdate.pendingFocusId
        }),
        status: action.hasPendingWork ? "loading" : "ready"
      };
    }
    case "startWorkspaceLoad":
      return {
        ...normalizeWorkspace({ nodes: [] }),
        status: "loading"
      };
    case "setLoading":
      return { ...state, status: "loading", error: null };
    case "setZoomRoot":
      return {
        ...state,
        zoomRootId: existingId(state, action.zoomRootId)
      };
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
            : action.pendingFocusId
      };
      return { ...state, ...normalizedUiState(state, ui) };
    }
  }
}
