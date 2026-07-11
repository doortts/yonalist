import { isNoteSearchResult } from "../domain/notes";
import type {
  CreateNoteNodeInput,
  MoveNoteNodeInput,
  NoteId,
  NoteSearchResult,
  NoteTagSummary,
  NotesHistoryContext,
  NotesHistoryReplayResult,
  NotesHistoryStatus,
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
  input: CreateNoteNodeInput,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_create_node", { vaultPath, input, historyContext });
}

export function notesUpdateNode(
  vaultPath: string,
  input: UpdateNoteNodeInput,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_update_node", { vaultPath, input, historyContext });
}

export function notesSplitNode(
  vaultPath: string,
  input: SplitNoteNodeInput,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_split_node", { vaultPath, input, historyContext });
}

export function notesMoveNode(
  vaultPath: string,
  input: MoveNoteNodeInput,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_move_node", { vaultPath, input, historyContext });
}

function invokeNodeMutation(
  command: string,
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>(command, { vaultPath, nodeId, historyContext });
}

export function notesToggleComplete(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_toggle_complete", vaultPath, nodeId, historyContext);
}

export function notesToggleCollapsed(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_toggle_collapsed", vaultPath, nodeId, historyContext);
}

export function notesToggleStar(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_toggle_star", vaultPath, nodeId, historyContext);
}

export function notesDuplicateNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_duplicate_node", vaultPath, nodeId, historyContext);
}

export function notesRemoveEmptyNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_remove_empty_node", vaultPath, nodeId, historyContext);
}

export function notesSoftDeleteNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_soft_delete_node", vaultPath, nodeId, historyContext);
}

export function notesRestoreNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_restore_node", vaultPath, nodeId, historyContext);
}

export function notesArchiveNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_archive_node", vaultPath, nodeId, historyContext);
}

export function notesUnarchiveNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesWorkspace> {
  return invokeNodeMutation("notes_unarchive_node", vaultPath, nodeId, historyContext);
}

export function notesUndo(
  vaultPath: string,
  sessionId: string,
  scope: NotesWorkspaceScope
): Promise<NotesHistoryReplayResult> {
  return invokeNotes<NotesHistoryReplayResult>("notes_undo", { vaultPath, sessionId, scope });
}

export function notesRedo(
  vaultPath: string,
  sessionId: string,
  scope: NotesWorkspaceScope
): Promise<NotesHistoryReplayResult> {
  return invokeNotes<NotesHistoryReplayResult>("notes_redo", { vaultPath, sessionId, scope });
}

export function notesHistoryStatus(
  vaultPath: string,
  sessionId: string
): Promise<NotesHistoryStatus> {
  return invokeNotes<NotesHistoryStatus>("notes_history_status", { vaultPath, sessionId });
}

export function notesClearHistory(
  vaultPath: string,
  sessionId: string
): Promise<NotesHistoryStatus> {
  return invokeNotes<NotesHistoryStatus>("notes_clear_history", { vaultPath, sessionId });
}

export function notesEmptyTrash(vaultPath: string): Promise<NotesWorkspace> {
  return invokeNotes<NotesWorkspace>("notes_empty_trash", { vaultPath });
}

export async function notesSearch(
  vaultPath: string,
  query: string
): Promise<NoteSearchResult[]> {
  const results = await invokeNotes<unknown>("notes_search", { vaultPath, query });
  if (!Array.isArray(results) || !results.every(isNoteSearchResult)) {
    throw new Error("Notes search returned an invalid result.");
  }
  return results;
}

export function notesListTags(vaultPath: string): Promise<string[]> {
  return invokeNotes<string[]>("notes_list_tags", { vaultPath });
}

export function notesListTagsWithCounts(
  vaultPath: string
): Promise<NoteTagSummary[]> {
  return invokeNotes<NoteTagSummary[]>("notes_list_tags_with_counts", { vaultPath });
}

export function notesDeleteDatabase(vaultPath: string): Promise<void> {
  return invokeNotes<void>("notes_delete_database", { vaultPath });
}

export const notesStore: NotesStore = {
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
  archiveNode: notesArchiveNode,
  unarchiveNode: notesUnarchiveNode,
  undo: notesUndo,
  redo: notesRedo,
  historyStatus: notesHistoryStatus,
  clearHistory: notesClearHistory,
  emptyTrash: notesEmptyTrash,
  search: notesSearch,
  listTags: notesListTags,
  listTagsWithCounts: notesListTagsWithCounts,
  deleteDatabase: notesDeleteDatabase
};
