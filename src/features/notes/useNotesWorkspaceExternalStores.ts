import { useCallback, useRef, useSyncExternalStore } from "react";
import type {
  NoteId,
  NotesStore,
  NotesStoreError
} from "../../domain/notes";
import {
  isNotesDataDeletionInProgress,
  subscribeToNotesDataDeletion
} from "./notesDataDeletionRegistry";
import type { NotesDraftEngine } from "./notesDraftEngine";
import type { NotesNodeDraft } from "./notesWorkspaceTypes";

const EMPTY_DRAFTS: Readonly<Record<NoteId, NotesNodeDraft>> = {};

export function useNotesDraftExternalStore(
  draftEngineRef: { readonly current: NotesDraftEngine | null }
) {
  const draftsListeners = useRef(new Set<() => void>());
  const writeErrorListeners = useRef(new Set<() => void>());
  const subscribeDrafts = useCallback((listener: () => void) => {
    draftsListeners.current.add(listener);
    return () => draftsListeners.current.delete(listener);
  }, []);
  const subscribeWriteError = useCallback((listener: () => void) => {
    writeErrorListeners.current.add(listener);
    return () => writeErrorListeners.current.delete(listener);
  }, []);
  const draftsByNodeId = useSyncExternalStore(
    subscribeDrafts,
    () => draftEngineRef.current?.getDraftsSnapshot() ?? EMPTY_DRAFTS
  );
  const currentWriteError = useSyncExternalStore(
    subscribeWriteError,
    (): NotesStoreError | null =>
      draftEngineRef.current?.getWriteErrorSnapshot() ?? null
  );
  const notifyDraftsListeners = useCallback(() => {
    for (const listener of draftsListeners.current) listener();
  }, []);
  const notifyWriteErrorListeners = useCallback(() => {
    for (const listener of writeErrorListeners.current) listener();
  }, []);
  return {
    draftsByNodeId,
    currentWriteError,
    notifyDraftsListeners,
    notifyWriteErrorListeners
  };
}

export function useNotesDataDeletionExternalStore(
  repository: NotesStore,
  vaultRoot: string
): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeToNotesDataDeletion(repository, vaultRoot, listener),
    [repository, vaultRoot]
  );
  const snapshot = useCallback(
    () => isNotesDataDeletionInProgress(repository, vaultRoot),
    [repository, vaultRoot]
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
