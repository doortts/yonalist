import type { NoteId } from "../../domain/notes";
import type { AssetIngestProgress } from "../../services/assetIngestProgress";

// C4: overlay state for an in-flight image ingest, keyed by the node the user
// uploaded to. Backend progress events carry a requestId, not a nodeId, so we
// attribute events to the single active ingest node the workflow declared with
// `beginNodeIngest`.
// ponytail: one active ingest at a time. Concurrent uploads to different nodes
// would need per-requestId routing (thread the requestId from the store call).
export interface NotesAssetIngestOverlay {
  readonly phase: AssetIngestProgress["phase"];
  readonly percent: number;
  // 1-based index of the file currently being ingested within the batch.
  readonly fileIndex: number;
  readonly fileCount: number;
}

type Listener = () => void;

const overlays = new Map<NoteId, NotesAssetIngestOverlay>();
const listeners = new Set<Listener>();
let activeNodeId: NoteId | null = null;

function notify(): void {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

function percentOf(progress: AssetIngestProgress): number {
  if (progress.bytesTotal <= 0) {
    return progress.phase === "done" ? 100 : 0;
  }
  const ratio = progress.bytesDone / progress.bytesTotal;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

export function beginNodeIngest(nodeId: NoteId, fileCount: number): void {
  activeNodeId = nodeId;
  overlays.set(nodeId, {
    phase: "hashing",
    percent: 0,
    fileIndex: 1,
    fileCount: Math.max(1, Math.trunc(fileCount) || 1)
  });
  notify();
}

export function applyAssetIngestProgress(progress: AssetIngestProgress): void {
  const nodeId = activeNodeId;
  if (nodeId === null) {
    return;
  }
  const current = overlays.get(nodeId);
  if (!current) {
    return;
  }
  if (progress.phase === "done") {
    // A file finished. Once the whole batch is done the overlay disappears
    // (a dedup hit is an immediate "done" and so is never shown for long).
    if (current.fileIndex >= current.fileCount) {
      overlays.delete(nodeId);
      if (activeNodeId === nodeId) {
        activeNodeId = null;
      }
      notify();
      return;
    }
    overlays.set(nodeId, {
      ...current,
      phase: "hashing",
      percent: 0,
      fileIndex: current.fileIndex + 1
    });
    notify();
    return;
  }
  overlays.set(nodeId, {
    ...current,
    phase: progress.phase,
    percent: percentOf(progress)
  });
  notify();
}

export function endNodeIngest(nodeId: NoteId): void {
  const removed = overlays.delete(nodeId);
  if (activeNodeId === nodeId) {
    activeNodeId = null;
  }
  if (removed) {
    notify();
  }
}

export function getNodeIngestOverlay(
  nodeId: NoteId
): NotesAssetIngestOverlay | null {
  return overlays.get(nodeId) ?? null;
}

export function subscribeNodeIngestOverlay(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Test-only reset.
export function resetNotesAssetIngestProgressStore(): void {
  overlays.clear();
  listeners.clear();
  activeNodeId = null;
}
