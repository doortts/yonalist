import { useCallback, useSyncExternalStore } from "react";
import type { NotesStore } from "./notesStore";
import type { NotesNodeSnapshot } from "./store/storeSubscriptions";

export function useNotesNode(
  store: NotesStore,
  nodeId: string
): NotesNodeSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeNode(nodeId, listener),
    [nodeId, store]
  );
  const getSnapshot = useCallback(
    () => store.getNodeSnapshot(nodeId),
    [nodeId, store]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
