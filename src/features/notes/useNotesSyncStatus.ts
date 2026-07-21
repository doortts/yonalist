import { useCallback, useSyncExternalStore } from "react";
import type { SyncStatus } from "../../services/notesSyncContract";
import {
  getNotesSyncStatus,
  subscribeNotesSyncStatus
} from "../../services/notesSyncStatusStore";

/** C3: subscribe to the latest sync status for a vault (null until published). */
export function useNotesSyncStatus(vaultRoot: string): SyncStatus | null {
  const getSnapshot = useCallback(
    () => getNotesSyncStatus(vaultRoot),
    [vaultRoot]
  );
  return useSyncExternalStore(subscribeNotesSyncStatus, getSnapshot, getSnapshot);
}

/**
 * A sync status warrants a visible badge only when something is wrong:
 * a quarantined topic, a recorded error, or a runtime that stopped running.
 */
export function notesSyncStatusNeedsAttention(
  status: SyncStatus | null
): status is SyncStatus {
  return (
    status !== null &&
    (status.quarantined.length > 0 ||
      status.lastError != null ||
      !status.running)
  );
}
