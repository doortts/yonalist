import type { SyncStatus } from "./notesSyncContract";

// C3: a tiny per-vault observable store for the latest sync status. The runtime
// listener publishes here (no notesWorkspaceRuntime.ts edit / no budget bump),
// and the badge/dialog subscribe. Keyed by vaultRoot so a stale entry for a
// switched-away vault never leaks into another vault's UI.
type Listener = () => void;

const statuses = new Map<string, SyncStatus>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

export function publishNotesSyncStatus(
  vaultRoot: string,
  status: SyncStatus
): void {
  statuses.set(vaultRoot, status);
  notify();
}

export function clearNotesSyncStatus(vaultRoot: string): void {
  if (statuses.delete(vaultRoot)) {
    notify();
  }
}

export function getNotesSyncStatus(vaultRoot: string): SyncStatus | null {
  return statuses.get(vaultRoot) ?? null;
}

export function subscribeNotesSyncStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Test-only reset so module state does not bleed between cases.
export function resetNotesSyncStatusStore(): void {
  statuses.clear();
  listeners.clear();
}
