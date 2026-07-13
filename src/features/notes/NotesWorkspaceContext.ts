import { createContext, useContext } from "react";
import type {
  NotesActionsSlice,
  NotesDraftsSlice,
  NotesStateSlice,
  UseNotesWorkspaceResult
} from "./useNotesWorkspace";

/**
 * The workspace projection is partitioned across three contexts by update
 * volatility so consumers only re-render for the data they actually read:
 *
 * - {@link NotesStateContext}: low-volatility projection + navigation + status.
 * - {@link NotesDraftsContext}: high-volatility per-node draft buffer.
 * - {@link NotesActionsContext}: referentially stable action callbacks.
 *
 * The legacy {@link NotesWorkspaceContext} carries the merged shape and is kept
 * only as a fallback so existing tests can provide a single value. The narrow
 * hooks below read their dedicated context first and fall back to the merged
 * one; because the merged context is never provided in production, that fallback
 * read subscribes to a static default and never triggers a re-render.
 */
export const NotesStateContext = createContext<NotesStateSlice | null>(null);
export const NotesDraftsContext = createContext<NotesDraftsSlice | null>(null);
export const NotesActionsContext = createContext<NotesActionsSlice | null>(null);

export const NotesWorkspaceContext =
  createContext<UseNotesWorkspaceResult | null>(null);

function missing(): never {
  throw new Error(
    "Notes workspace context must be used within a Notes workspace provider."
  );
}

export function useNotesState(): NotesStateSlice {
  const narrow = useContext(NotesStateContext);
  const merged = useContext(NotesWorkspaceContext);
  if (narrow) {
    return narrow;
  }
  if (merged) {
    return merged;
  }
  return missing();
}

export function useNotesDrafts(): NotesDraftsSlice {
  const narrow = useContext(NotesDraftsContext);
  const merged = useContext(NotesWorkspaceContext);
  if (narrow) {
    return narrow;
  }
  if (merged) {
    return merged;
  }
  return missing();
}

export function useNotesActions(): NotesActionsSlice {
  const narrow = useContext(NotesActionsContext);
  const merged = useContext(NotesWorkspaceContext);
  if (narrow) {
    return narrow;
  }
  if (merged) {
    return merged;
  }
  return missing();
}
