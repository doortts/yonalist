import type {
  CreateNoteNodeInput,
  MoveNoteNodeInput,
  NoteId,
  NoteSearchResult,
  NotesStore,
  NotesWorkspace,
  NotesWorkspaceScope,
  SplitNoteNodeInput,
  UpdateNoteNodeInput
} from "../domain/notes";

async function invokeNotes<T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    throw new Error("Notes requires Tauri desktop storage.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export function notesInitialize(vaultPath: string): Promise<void> {
  return invokeNotes<void>("notes_initialize", { vaultPath });
}

export function notesLoadWorkspace(
  vaultPath: string,
  scope: NotesWorkspaceScope
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_load_workspace", {
    vaultPath,
    scope
  });
}

export function notesCreateNode(
  vaultPath: string,
  input: CreateNoteNodeInput
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_create_node", { vaultPath, input });
}

export function notesUpdateNode(
  vaultPath: string,
  input: UpdateNoteNodeInput
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_update_node", { vaultPath, input });
}

export function notesSplitNode(
  vaultPath: string,
  input: SplitNoteNodeInput
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_split_node", { vaultPath, input });
}

export function notesMoveNode(
  vaultPath: string,
  input: MoveNoteNodeInput
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_move_node", { vaultPath, input });
}

function invokeNodeMutation(
  command: string,
  vaultPath: string,
  nodeId: NoteId
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>(command, { vaultPath, nodeId });
}

export function notesToggleComplete(
  vaultPath: string,
  nodeId: NoteId
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_toggle_complete", vaultPath, nodeId);
}

export function notesToggleCollapsed(
  vaultPath: string,
  nodeId: NoteId
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_toggle_collapsed", vaultPath, nodeId);
}

export function notesToggleStar(
  vaultPath: string,
  nodeId: NoteId
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_toggle_star", vaultPath, nodeId);
}

export function notesDuplicateNode(
  vaultPath: string,
  nodeId: NoteId
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_duplicate_node", vaultPath, nodeId);
}

export function notesRemoveEmptyNode(
  vaultPath: string,
  nodeId: NoteId
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_remove_empty_node", vaultPath, nodeId);
}

export function notesSoftDeleteNode(
  vaultPath: string,
  nodeId: NoteId
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_soft_delete_node", vaultPath, nodeId);
}

export function notesRestoreNode(
  vaultPath: string,
  nodeId: NoteId
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_restore_node", vaultPath, nodeId);
}

export function notesEmptyTrash(vaultPath: string): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_empty_trash", { vaultPath });
}

export function notesSearch(
  vaultPath: string,
  query: string
): Promise<NoteSearchResult[]> {
  return invokeNotes<NoteSearchResult[]>("notes_search", { vaultPath, query });
}

export function notesListTags(vaultPath: string): Promise<string[]> {
  return invokeNotes<string[]>("notes_list_tags", { vaultPath });
}

export function notesDeleteDatabase(vaultPath: string): Promise<void> {
  return invokeNotes<void>("notes_delete_database", { vaultPath });
}

type NotesDiscoveryMethod =
  | "toggleStar"
  | "search"
  | "listTags"
  | "deleteDatabase";

export const notesStore: NotesStore &
  Required<Pick<NotesStore, NotesDiscoveryMethod>> = {
  initialize: notesInitialize,
  loadWorkspace: notesLoadWorkspace,
  createNode: notesCreateNode,
  updateNode: notesUpdateNode,
  splitNode: notesSplitNode,
  moveNode: notesMoveNode,
  toggleComplete: notesToggleComplete,
  toggleCollapsed: notesToggleCollapsed,
  toggleStar: notesToggleStar,
  duplicateNode: notesDuplicateNode,
  removeEmptyNode: notesRemoveEmptyNode,
  softDeleteNode: notesSoftDeleteNode,
  restoreNode: notesRestoreNode,
  emptyTrash: notesEmptyTrash,
  search: notesSearch,
  listTags: notesListTags,
  deleteDatabase: notesDeleteDatabase
};
