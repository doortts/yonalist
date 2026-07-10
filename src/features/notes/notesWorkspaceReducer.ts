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
  | { type: "replaceWorkspace"; workspace: NotesWorkspace }
  | { type: "setLoading" }
  | { type: "setError"; error: string }
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
  const nodesById: Record<NoteId, NoteNode> = {};
  const childIdsByParent: Record<string, NoteId[]> = {};
  const rootIds: NoteId[] = [];

  for (const node of workspace.nodes) {
    nodesById[node.id] = node;
  }

  for (const node of [...workspace.nodes].sort(compareNodes)) {
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
    case "replaceWorkspace": {
      const workspace = normalizeWorkspace(action.workspace);
      return {
        ...workspace,
        ...normalizedUiState(workspace, state)
      };
    }
    case "setLoading":
      return { ...state, status: "loading", error: null };
    case "setError":
      return { ...state, status: "error", error: action.error };
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
