export interface NotesSelectionMutationAvailability {
  readonly deletingNotesData: boolean;
  readonly lifecycleReadOnly: boolean;
  readonly loading: boolean;
  readonly writeError: boolean;
}

export type NotesSelectionOperation =
  | "toggleComplete"
  | "complete"
  | "moveTo"
  | "moveUp"
  | "moveDown"
  | "indent"
  | "outdent"
  | "duplicate"
  | "tags"
  | "addTag"
  | "removeTag"
  | "copy"
  | "cut"
  | "delete"
  | "reorder"
  | "clear";

export function notesSelectionOperationDisabledReason(
  operation: NotesSelectionOperation,
  mutationDisabledReason: string | null
): string | null {
  return operation === "copy" || operation === "clear"
    ? null
    : mutationDisabledReason;
}

export function notesSelectionMutationDisabledReason({
  deletingNotesData,
  lifecycleReadOnly,
  loading,
  writeError
}: NotesSelectionMutationAvailability): string | null {
  if (deletingNotesData) {
    return "Yonalist data is being deleted.";
  }
  if (lifecycleReadOnly) {
    return "Selection actions are unavailable in Archive or Trash.";
  }
  if (loading) {
    return "Notes are updating.";
  }
  if (writeError) {
    return "Retry the failed save before changing notes.";
  }
  return null;
}
