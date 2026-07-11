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

export interface NotesHistoryLocationSnapshot {
  scope: NotesWorkspaceScope;
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  locallyExpandedNodeIds: readonly NoteId[];
  focus: NotesHistoryFocus | null;
}

export interface NotesHistorySnapshot extends NotesHistoryLocationSnapshot {
  tagFilterOrigin?: NotesHistoryLocationSnapshot | null;
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

export interface NotesHistoryOwnerRegistry<Owner> {
  begin(entryId: string, owner: Owner): void;
  complete(entryId: string): void;
  discard(entryId: string): void;
  owner(entryId: string): Owner | undefined;
  isInFlight(entryId: string): boolean;
  size(): number;
}

export function createNotesHistoryOwnerRegistry<Owner>(
  maxCompleted = 200
): NotesHistoryOwnerRegistry<Owner> {
  const entries = new Map<string, { owner: Owner; inFlight: boolean }>();

  const trimCompleted = (): void => {
    let completedCount = [...entries.values()].filter(
      (entry) => !entry.inFlight
    ).length;
    for (const [entryId, entry] of entries) {
      if (completedCount <= Math.max(0, maxCompleted)) {
        break;
      }
      if (!entry.inFlight) {
        entries.delete(entryId);
        completedCount -= 1;
      }
    }
  };

  return {
    begin(entryId, owner) {
      entries.set(entryId, { owner, inFlight: true });
    },
    complete(entryId) {
      const entry = entries.get(entryId);
      if (entry) {
        entry.inFlight = false;
        trimCompleted();
      }
    },
    discard(entryId) {
      entries.delete(entryId);
    },
    owner(entryId) {
      return entries.get(entryId)?.owner;
    },
    isInFlight(entryId) {
      return entries.get(entryId)?.inFlight ?? false;
    },
    size() {
      return entries.size;
    }
  };
}

function cloneScope(scope: NotesWorkspaceScope): NotesWorkspaceScope {
  if (scope.kind === "tags") {
    return { kind: "tags", tags: scope.tags.map((tag) => ({ ...tag })) };
  }
  return { ...scope };
}

function cloneLocation(
  snapshot: NotesHistoryLocationSnapshot
): NotesHistoryLocationSnapshot {
  return {
    ...snapshot,
    scope: cloneScope(snapshot.scope),
    locallyExpandedNodeIds: [...snapshot.locallyExpandedNodeIds],
    focus: snapshot.focus ? { ...snapshot.focus } : null
  };
}

function cloneSnapshot(snapshot: NotesHistorySnapshot): NotesHistorySnapshot {
  return {
    ...cloneLocation(snapshot),
    ...(snapshot.tagFilterOrigin === undefined
      ? {}
      : {
          tagFilterOrigin: snapshot.tagFilterOrigin
            ? cloneLocation(snapshot.tagFilterOrigin)
            : null
        })
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
