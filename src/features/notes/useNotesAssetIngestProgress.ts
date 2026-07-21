import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { NoteId } from "../../domain/notes";
import { startAssetIngestProgressListener } from "../../services/assetIngestProgress";
import {
  applyAssetIngestProgress,
  getNodeIngestOverlay,
  subscribeNodeIngestOverlay,
  type NotesAssetIngestOverlay
} from "./notesAssetIngestProgressStore";

/** C4: subscribe to the ingest overlay for one node (null when idle). */
export function useNotesAssetIngestProgress(
  nodeId: NoteId
): NotesAssetIngestOverlay | null {
  const getSnapshot = useCallback(
    () => getNodeIngestOverlay(nodeId),
    [nodeId]
  );
  return useSyncExternalStore(
    subscribeNodeIngestOverlay,
    getSnapshot,
    getSnapshot
  );
}

/**
 * C4: mount the asset-ingest progress listener once (from the attachment
 * workflow) and route every progress event into the overlay store.
 */
export function useMountAssetIngestProgressListener(): void {
  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | null = null;
    void startAssetIngestProgressListener({
      onProgress: (progress) => applyAssetIngestProgress(progress)
    })
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        cleanup = unlisten;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      cleanup?.();
    };
  }, []);
}
