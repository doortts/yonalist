import type {
  NoteId,
  NotesHistoryContext,
  NotesWorkspaceScope
} from "../../domain/notes";

export type NotesHistoryFocusField = "title" | "note";

export interface NotesHistoryFocus {
  nodeId: NoteId;
  field: NotesHistoryFocusField;
}

export interface NotesHistorySnapshot {
  scope: NotesWorkspaceScope;
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  locallyExpandedNodeIds: readonly NoteId[];
  focus: NotesHistoryFocus | null;
}

export type NotesHistoryReplayDirection = "undo" | "redo";

interface NotesHistorySnapshotPair {
  before: NotesHistorySnapshot | null;
  after: NotesHistorySnapshot | null;
  completed: boolean;
}

export interface CreateNotesHistorySessionOptions {
  createId?: () => string;
  maxSnapshots?: number;
}

export interface NotesHistorySession {
  readonly sessionId: string;
  beginTextBurst(nodeId: NoteId, before: NotesHistorySnapshot): NotesHistoryContext;
  closeTextBurst(entryId?: string): void;
  beginStructuralEntry(
    commandKind: string,
    before: NotesHistorySnapshot
  ): NotesHistoryContext;
  rememberAfter(entryId: string, after: NotesHistorySnapshot): void;
  discard(entryId: string): void;
  snapshotCount(): number;
  snapshotForReplay(
    entryId: string | null,
    direction: NotesHistoryReplayDirection
  ): NotesHistorySnapshot | null;
  clearSnapshots(): void;
}

function cloneScope(scope: NotesWorkspaceScope): NotesWorkspaceScope {
  if (scope.kind === "tags") {
    return { kind: "tags", tags: scope.tags.map((tag) => ({ ...tag })) };
  }
  return { ...scope };
}

function cloneSnapshot(snapshot: NotesHistorySnapshot): NotesHistorySnapshot {
  return {
    ...snapshot,
    scope: cloneScope(snapshot.scope),
    locallyExpandedNodeIds: [...snapshot.locallyExpandedNodeIds],
    focus: snapshot.focus ? { ...snapshot.focus } : null
  };
}

export function createNotesHistorySession({
  createId = () => globalThis.crypto.randomUUID(),
  maxSnapshots = 100
}: CreateNotesHistorySessionOptions = {}): NotesHistorySession {
  const sessionId = createId();
  const snapshots = new Map<string, NotesHistorySnapshotPair>();
  let textBurst: { nodeId: NoteId; context: NotesHistoryContext } | null = null;

  const rememberBefore = (
    entryId: string,
    before: NotesHistorySnapshot
  ): void => {
    snapshots.set(entryId, {
      before: cloneSnapshot(before),
      after: null,
      completed: false
    });
  };

  const context = (entryId: string, commandKind: string): NotesHistoryContext => ({
    sessionId,
    entryId,
    commandKind
  });

  return {
    sessionId,
    beginTextBurst(nodeId, before) {
      if (textBurst?.nodeId === nodeId) {
        return textBurst.context;
      }
      textBurst = {
        nodeId,
        context: context(createId(), "text")
      };
      rememberBefore(textBurst.context.entryId, before);
      return textBurst.context;
    },
    closeTextBurst(entryId) {
      if (entryId === undefined || textBurst?.context.entryId === entryId) {
        textBurst = null;
      }
    },
    beginStructuralEntry(commandKind, before) {
      textBurst = null;
      const structural = context(createId(), commandKind);
      rememberBefore(structural.entryId, before);
      return structural;
    },
    rememberAfter(entryId, after) {
      const pair = snapshots.get(entryId);
      if (pair) {
        pair.after = cloneSnapshot(after);
        pair.completed = true;
        let completedCount = [...snapshots.values()].filter(
          (snapshotPair) => snapshotPair.completed
        ).length;
        for (const [candidateId, candidate] of snapshots) {
          if (completedCount <= Math.max(0, maxSnapshots)) {
            break;
          }
          if (candidate.completed) {
            snapshots.delete(candidateId);
            completedCount -= 1;
          }
        }
      }
    },
    discard(entryId) {
      snapshots.delete(entryId);
      if (textBurst?.context.entryId === entryId) {
        textBurst = null;
      }
    },
    snapshotCount() {
      return snapshots.size;
    },
    snapshotForReplay(entryId, direction) {
      if (entryId === null) {
        return null;
      }
      const pair = snapshots.get(entryId);
      const snapshot = direction === "undo" ? pair?.before : pair?.after;
      return snapshot ? cloneSnapshot(snapshot) : null;
    },
    clearSnapshots() {
      textBurst = null;
      snapshots.clear();
    }
  };
}
