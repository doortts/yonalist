import type {
  NoteId,
  NoteTagFilter,
  NotesHistoryContext,
  NotesHistoryState,
  NotesWorkspaceScope
} from "../../domain/notes";
import type { NotesLibraryView } from "./useNotesWorkspace";

export type NotesHistoryFocusField = "title" | "note";

export interface NotesHistoryPrimarySelection {
  readonly anchorUtf16: number;
  readonly focusUtf16: number;
}

export interface NotesHistoryFocus {
  nodeId: NoteId;
  field: NotesHistoryFocusField;
  primarySelection?: NotesHistoryPrimarySelection;
}

export interface NotesExpansionRevision {
  readonly revision: number;
  readonly nodeIds: readonly NoteId[];
}

export interface NotesExpansionSnapshotPool {
  acquire(nodeIds: readonly NoteId[]): NotesExpansionRevision;
  retain(value: NotesExpansionRevision): void;
  release(value: NotesExpansionRevision): void;
  size(): number;
}

interface ExpansionRecord {
  readonly key: string;
  readonly value: NotesExpansionRevision;
  readonly owner: Map<string, ExpansionRecord>;
  references: number;
}

const expansionRecords = new WeakMap<NotesExpansionRevision, ExpansionRecord>();
let nextExpansionRevision = 1;

function expansionKey(nodeIds: readonly NoteId[]): {
  key: string;
  nodeIds: readonly NoteId[];
} {
  const normalized = Object.freeze([...new Set(nodeIds)].sort());
  return { key: normalized.join("\u0000"), nodeIds: normalized };
}

export function createNotesExpansionSnapshotPool(): NotesExpansionSnapshotPool {
  const records = new Map<string, ExpansionRecord>();
  return {
    acquire(nodeIds) {
      const normalized = expansionKey(nodeIds);
      const existing = records.get(normalized.key);
      if (existing) {
        existing.references += 1;
        return existing.value;
      }
      const value = Object.freeze({
        revision: nextExpansionRevision++,
        nodeIds: normalized.nodeIds
      });
      const record: ExpansionRecord = {
        key: normalized.key,
        value,
        owner: records,
        references: 1
      };
      records.set(record.key, record);
      expansionRecords.set(value, record);
      return value;
    },
    retain(value) {
      const record = expansionRecords.get(value);
      if (!record || record.references === 0) {
        throw new Error("Notes expansion revision is no longer retained.");
      }
      record.references += 1;
    },
    release(value) {
      const record = expansionRecords.get(value);
      if (!record || record.references === 0) {
        return;
      }
      record.references -= 1;
      if (
        record.references === 0 &&
        record.owner.get(record.key) === record
      ) {
        record.owner.delete(record.key);
      }
    },
    size() {
      return records.size;
    }
  };
}

export const notesExpansionSnapshotPool =
  createNotesExpansionSnapshotPool();

export interface NotesHistoryLocationSnapshot {
  scope: NotesWorkspaceScope;
  libraryView: NotesLibraryView;
  activeTagFilters: readonly NoteTagFilter[];
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  expansion: NotesExpansionRevision;
  focus: NotesHistoryFocus | null;
}

export interface NotesHistorySnapshot extends NotesHistoryLocationSnapshot {
  tagFilterOrigin?: NotesHistoryLocationSnapshot | null;
}

export type NotesHistoryReplayDirection = "undo" | "redo";

export type NotesSessionHistoryEntry =
  | {
      kind: "mutation";
      entryId: string;
      before: NotesHistorySnapshot;
      after: NotesHistorySnapshot;
    }
  | {
      kind: "navigation";
      before: NotesHistorySnapshot;
      after: NotesHistorySnapshot;
    };

interface PendingMutation {
  readonly context: NotesHistoryContext;
  readonly before: NotesHistorySnapshot;
  readonly text: boolean;
  committed: boolean;
}

export interface CreateNotesHistorySessionOptions {
  createId?: () => string;
  maxEntries?: number;
  expansionPool?: NotesExpansionSnapshotPool;
  /** Compatibility alias for pre-timeline callers. */
  maxSnapshots?: number;
}

export interface NotesHistorySession {
  readonly sessionId: string;
  readonly historyEpoch: string;
  bindInitialization(state: NotesHistoryState): void;
  canUndo(): boolean;
  canRedo(): boolean;
  beginTextBurst(
    nodeId: NoteId,
    before: NotesHistorySnapshot
  ): NotesHistoryContext;
  closeTextBurst(entryId?: string): void;
  beginStructuralEntry(
    commandKind: string,
    before: NotesHistorySnapshot
  ): NotesHistoryContext;
  acceptMutationResult(
    entryId: string,
    after: NotesHistorySnapshot,
    state: NotesHistoryState
  ): { accepted: boolean; unreachableEntryIds: readonly string[] };
  rememberAcceptedMutationState(entryId: string, state: NotesHistoryState): void;
  takeAcceptedMutationState(entryId: string): NotesHistoryState | undefined;
  appendNavigation(
    before: NotesHistorySnapshot,
    after: NotesHistorySnapshot
  ): readonly string[];
  discard(entryId: string): void;
  next(direction: NotesHistoryReplayDirection): NotesSessionHistoryEntry | null;
  commitReplay(direction: NotesHistoryReplayDirection): void;
  accepts(state: NotesHistoryState): boolean;
  acceptReplayResult(
    state: NotesHistoryState,
    direction: NotesHistoryReplayDirection,
    entryId: string
  ): boolean;
  acceptPreparedNavigation(
    state: NotesHistoryState,
    invalidatedRedoIds: readonly string[]
  ): boolean;
  unreachableRedoMutationIds(): readonly string[];
  reset(historyEpoch: string): void;
  /** Compatibility surface retained for current draft/performance callers. */
  rememberAfter(entryId: string, after: NotesHistorySnapshot): void;
  snapshotCount(): number;
  snapshotForReplay(
    entryId: string | null,
    direction: NotesHistoryReplayDirection
  ): NotesHistorySnapshot | null;
  clearSnapshots(): void;
}

// Command contexts retain their identity until settlement. Associating the
// returned backend state with that identity keeps it session-local and lets
// garbage collection clean up a closed command without a global entry map.
const historySessionByContext = new WeakMap<
  NotesHistoryContext,
  NotesHistorySession
>();

export function rememberAcceptedHistoryState(
  context: NotesHistoryContext | null | undefined,
  state: NotesHistoryState
): void {
  if (!context) return;
  historySessionByContext
    .get(context)
    ?.rememberAcceptedMutationState(context.entryId, state);
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

function canonicalTags(tags: readonly NoteTagFilter[]): readonly NoteTagFilter[] {
  const byKey = new Map<string, NoteTagFilter>();
  for (const tag of tags) {
    byKey.set(`${tag.prefix}\u0000${tag.normalizedTag}`, { ...tag });
  }
  return Object.freeze(
    [...byKey.values()].sort(
      (left, right) =>
        left.prefix.localeCompare(right.prefix) ||
        left.normalizedTag.localeCompare(right.normalizedTag)
    )
  );
}

function cloneScope(scope: NotesWorkspaceScope): NotesWorkspaceScope {
  if (scope.kind === "tags") {
    return { kind: "tags", tags: [...canonicalTags(scope.tags)] };
  }
  return { ...scope };
}

function cloneLocation(
  snapshot: NotesHistoryLocationSnapshot
): NotesHistoryLocationSnapshot {
  return {
    scope: cloneScope(snapshot.scope),
    libraryView: snapshot.libraryView,
    activeTagFilters: canonicalTags(snapshot.activeTagFilters),
    selectedId: snapshot.selectedId,
    zoomRootId: snapshot.zoomRootId,
    expansion: snapshot.expansion,
    focus: snapshot.focus
      ? {
          ...snapshot.focus,
          ...(snapshot.focus.primarySelection
            ? { primarySelection: { ...snapshot.focus.primarySelection } }
            : {})
        }
      : null
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

function snapshotRevisions(
  snapshot: NotesHistorySnapshot
): readonly NotesExpansionRevision[] {
  return snapshot.tagFilterOrigin
    ? [snapshot.expansion, snapshot.tagFilterOrigin.expansion]
    : [snapshot.expansion];
}

function entryMutationId(entry: NotesSessionHistoryEntry): string | null {
  return entry.kind === "mutation" ? entry.entryId : null;
}

function nearestMutationIds(
  entries: readonly NotesSessionHistoryEntry[],
  cursor: number
): { undo: string | null; redo: string | null } {
  let undo: string | null = null;
  for (let index = cursor - 1; index >= 0; index -= 1) {
    undo = entryMutationId(entries[index]!);
    if (undo !== null) break;
  }
  let redo: string | null = null;
  for (let index = cursor; index < entries.length; index += 1) {
    redo = entryMutationId(entries[index]!);
    if (redo !== null) break;
  }
  return { undo, redo };
}

function stateMatches(
  state: NotesHistoryState,
  historyEpoch: string,
  entries: readonly NotesSessionHistoryEntry[],
  cursor: number
): boolean {
  if (state.historyEpoch !== historyEpoch) return false;
  const nearest = nearestMutationIds(entries, cursor);
  return (
    nearest.undo === state.nextUndoEntryId &&
    nearest.redo === state.nextRedoEntryId
  );
}

function pruneProjection(
  source: readonly NotesSessionHistoryEntry[],
  sourceCursor: number,
  prunedEntryIds: ReadonlySet<string>
): {
  entries: NotesSessionHistoryEntry[];
  cursor: number;
  removed: NotesSessionHistoryEntry[];
} {
  let entries = [...source];
  let cursor = sourceCursor;
  const removed: NotesSessionHistoryEntry[] = [];
  while (true) {
    const index = entries.findIndex(
      (entry) => entry.kind === "mutation" && prunedEntryIds.has(entry.entryId)
    );
    if (index < 0) break;
    if (index < cursor) {
      const prefix = entries.splice(0, index + 1);
      removed.push(...prefix);
      cursor = Math.max(0, cursor - prefix.length);
    } else {
      removed.push(...entries.splice(index));
    }
  }
  return { entries, cursor, removed };
}

export function createNotesHistorySession({
  createId = () => globalThis.crypto.randomUUID(),
  maxEntries,
  maxSnapshots,
  expansionPool = notesExpansionSnapshotPool
}: CreateNotesHistorySessionOptions = {}): NotesHistorySession {
  const sessionId = createId();
  const limit = Math.max(0, maxEntries ?? maxSnapshots ?? 100);
  let historyEpoch: string | null = null;
  let timeline: NotesSessionHistoryEntry[] = [];
  let cursor = 0;
  const pending = new Map<string, PendingMutation>();
  const acceptedMutationStates = new Map<string, NotesHistoryState>();
  let preparedRedoIds: ReadonlySet<string> | null = null;
  let textBurst: {
    nodeId: NoteId;
    field: NotesHistoryFocusField;
    entryId: string;
  } | null = null;

  const requireHistoryEpoch = (): string => {
    if (historyEpoch === null) {
      throw new Error("Notes history session is not initialized.");
    }
    return historyEpoch;
  };

  const retainSnapshot = (snapshot: NotesHistorySnapshot): void => {
    for (const revision of snapshotRevisions(snapshot)) {
      expansionPool.retain(revision);
    }
  };

  const releaseSnapshot = (snapshot: NotesHistorySnapshot): void => {
    for (const revision of snapshotRevisions(snapshot)) {
      expansionPool.release(revision);
    }
  };

  const releaseEntry = (entry: NotesSessionHistoryEntry): void => {
    releaseSnapshot(entry.before);
    releaseSnapshot(entry.after);
  };

  const releaseAll = (): void => {
    for (const entry of timeline) releaseEntry(entry);
    for (const mutation of pending.values()) {
      if (!mutation.committed) releaseSnapshot(mutation.before);
    }
    timeline = [];
    cursor = 0;
    pending.clear();
    acceptedMutationStates.clear();
    preparedRedoIds = null;
    textBurst = null;
  };

  const ownedSnapshot = (value: NotesHistorySnapshot): NotesHistorySnapshot =>
    cloneSnapshot(value);

  const context = (entryId: string, commandKind: string): NotesHistoryContext => {
    const value: NotesHistoryContext = {
      sessionId,
      historyEpoch: requireHistoryEpoch(),
      entryId,
      commandKind
    };
    historySessionByContext.set(value, session);
    return value;
  };

  const removedCleanupIds = (
    removed: readonly NotesSessionHistoryEntry[],
    alreadyPruned: ReadonlySet<string>
  ): string[] => {
    const ids: string[] = [];
    for (const entry of removed) {
      if (
        entry.kind === "mutation" &&
        !alreadyPruned.has(entry.entryId) &&
        !ids.includes(entry.entryId)
      ) {
        ids.push(entry.entryId);
      }
    }
    return ids;
  };

  const appendNavigation = (
    beforeValue: NotesHistorySnapshot,
    afterValue: NotesHistorySnapshot
  ): readonly string[] => {
    requireHistoryEpoch();
    closeTextBurst();
    const before = ownedSnapshot(beforeValue);
    const after = ownedSnapshot(afterValue);
    const removed = timeline.slice(cursor);
    let projected = timeline.slice(0, cursor);
    projected.push({ kind: "navigation", before, after });
    let nextCursor = projected.length;
    if (projected.length > limit) {
      const overflow = projected.length - limit;
      removed.push(...projected.splice(0, overflow));
      nextCursor -= overflow;
    }
    const alreadyPruned = preparedRedoIds ?? new Set<string>();
    preparedRedoIds = null;
    timeline = projected;
    cursor = nextCursor;
    for (const entry of removed) releaseEntry(entry);
    return removedCleanupIds(removed, alreadyPruned);
  };

  const clearTimeline = (): void => {
    releaseAll();
  };

  const closeTextBurst = (entryId?: string): void => {
    if (entryId !== undefined && textBurst?.entryId !== entryId) {
      return;
    }
    const closedEntryId = textBurst?.entryId;
    textBurst = null;
    if (closedEntryId && pending.get(closedEntryId)?.committed) {
      pending.delete(closedEntryId);
    }
  };

  const session: NotesHistorySession = {
    sessionId,
    get historyEpoch() {
      return requireHistoryEpoch();
    },
    bindInitialization(state) {
      if (historyEpoch !== null && historyEpoch !== state.historyEpoch) {
        clearTimeline();
      }
      historyEpoch = state.historyEpoch;
    },
    canUndo() {
      return cursor > 0;
    },
    canRedo() {
      return cursor < timeline.length;
    },
    beginTextBurst(nodeId, beforeValue) {
      const epoch = requireHistoryEpoch();
      const field =
        beforeValue.focus?.nodeId === nodeId ? beforeValue.focus.field : "title";
      if (textBurst?.nodeId === nodeId && textBurst.field === field) {
        releaseSnapshot(beforeValue);
        return pending.get(textBurst.entryId)!.context;
      }
      closeTextBurst();
      const entryId = createId();
      const value = ownedSnapshot(beforeValue);
      const mutation: PendingMutation = {
        context: { sessionId, historyEpoch: epoch, entryId, commandKind: "text" },
        before: value,
        text: true,
        committed: false
      };
      historySessionByContext.set(mutation.context, session);
      pending.set(entryId, mutation);
      textBurst = { nodeId, field, entryId };
      return mutation.context;
    },
    closeTextBurst(entryId) {
      closeTextBurst(entryId);
    },
    beginStructuralEntry(commandKind, beforeValue) {
      closeTextBurst();
      const entryId = createId();
      const mutation: PendingMutation = {
        context: context(entryId, commandKind),
        before: ownedSnapshot(beforeValue),
        text: false,
        committed: false
      };
      pending.set(entryId, mutation);
      return mutation.context;
    },
    acceptMutationResult(entryId, afterValue, state) {
      const epoch = requireHistoryEpoch();
      const mutation = pending.get(entryId);
      const after = ownedSnapshot(afterValue);
      if (!mutation || mutation.context.historyEpoch !== epoch) {
        releaseSnapshot(after);
        return { accepted: false, unreachableEntryIds: [] };
      }

      const backendPruned = new Set(state.prunedEntryIds);
      let projected = [...timeline];
      let projectedCursor = cursor;
      const removed = projected.slice(projectedCursor);
      projected = projected.slice(0, projectedCursor);
      let replaced: Extract<NotesSessionHistoryEntry, { kind: "mutation" }> | null =
        null;
      if (mutation.committed) {
        const index = projected.findIndex(
          (entry) => entry.kind === "mutation" && entry.entryId === entryId
        );
        if (index < 0) {
          releaseSnapshot(after);
          return { accepted: false, unreachableEntryIds: [] };
        }
        replaced = projected[index] as Extract<
          NotesSessionHistoryEntry,
          { kind: "mutation" }
        >;
        projected[index] = {
          kind: "mutation",
          entryId,
          before: replaced.before,
          after
        };
      } else {
        projected.push({
          kind: "mutation",
          entryId,
          before: mutation.before,
          after
        });
        projectedCursor = projected.length;
      }

      if (projected.length > limit) {
        const overflow = projected.length - limit;
        removed.push(...projected.splice(0, overflow));
        projectedCursor = Math.max(0, projectedCursor - overflow);
      }
      const pruned = pruneProjection(projected, projectedCursor, backendPruned);
      removed.push(...pruned.removed);
      if (!stateMatches(state, epoch, pruned.entries, pruned.cursor)) {
        releaseSnapshot(after);
        return { accepted: false, unreachableEntryIds: [] };
      }

      timeline = pruned.entries;
      cursor = pruned.cursor;
      preparedRedoIds = null;
      if (replaced) {
        releaseSnapshot(replaced.after);
      }
      for (const entry of removed) {
        if (entry !== replaced) releaseEntry(entry);
      }
      mutation.committed = true;
      if (!mutation.text || textBurst?.entryId !== entryId) {
        pending.delete(entryId);
      }
      return {
        accepted: true,
        unreachableEntryIds: removedCleanupIds(removed, backendPruned)
      };
    },
    rememberAcceptedMutationState(entryId, state) {
      acceptedMutationStates.set(entryId, state);
    },
    takeAcceptedMutationState(entryId) {
      const state = acceptedMutationStates.get(entryId);
      acceptedMutationStates.delete(entryId);
      return state;
    },
    appendNavigation,
    discard(entryId) {
      const mutation = pending.get(entryId);
      if (mutation && !mutation.committed) {
        releaseSnapshot(mutation.before);
      }
      pending.delete(entryId);
      acceptedMutationStates.delete(entryId);
      if (textBurst?.entryId === entryId) textBurst = null;
    },
    next(direction) {
      const entry =
        direction === "undo" ? timeline[cursor - 1] : timeline[cursor];
      return entry ?? null;
    },
    commitReplay(direction) {
      const candidate = session.next(direction);
      if (!candidate || candidate.kind !== "navigation") return;
      cursor += direction === "undo" ? -1 : 1;
    },
    accepts(state) {
      return stateMatches(state, requireHistoryEpoch(), timeline, cursor);
    },
    acceptReplayResult(state, direction, entryId) {
      const epoch = requireHistoryEpoch();
      const candidate = session.next(direction);
      if (
        !candidate ||
        candidate.kind !== "mutation" ||
        candidate.entryId !== entryId
      ) {
        return false;
      }
      const projectedCursor = cursor + (direction === "undo" ? -1 : 1);
      const backendPruned = new Set(state.prunedEntryIds);
      const projected = pruneProjection(timeline, projectedCursor, backendPruned);
      if (!stateMatches(state, epoch, projected.entries, projected.cursor)) {
        return false;
      }
      timeline = projected.entries;
      cursor = projected.cursor;
      for (const entry of projected.removed) releaseEntry(entry);
      return true;
    },
    acceptPreparedNavigation(state, invalidatedRedoIds) {
      const epoch = requireHistoryEpoch();
      if (state.historyEpoch !== epoch) return false;
      const expected = session.unreachableRedoMutationIds();
      if (
        expected.length !== invalidatedRedoIds.length ||
        expected.some((entryId, index) => entryId !== invalidatedRedoIds[index])
      ) {
        return false;
      }
      const invalidatedRedoIdSet = new Set(invalidatedRedoIds);
      const backendPrunedKeptIds = new Set(
        state.prunedEntryIds.filter(
          (entryId) => !invalidatedRedoIdSet.has(entryId)
        )
      );
      // Preparing a new navigation invalidates every local redo entry, but the
      // actual append owns its truncation and releases. Validate against that
      // post-truncation shape while committing only backend pruning from the
      // retained side of the local timeline.
      const projected = pruneProjection(
        timeline.slice(0, cursor),
        cursor,
        backendPrunedKeptIds
      );
      if (!stateMatches(state, epoch, projected.entries, projected.cursor)) {
        return false;
      }
      timeline = [...projected.entries, ...timeline.slice(cursor)];
      cursor = projected.cursor;
      for (const entry of projected.removed) releaseEntry(entry);
      preparedRedoIds = invalidatedRedoIdSet;
      return true;
    },
    unreachableRedoMutationIds() {
      return timeline
        .slice(cursor)
        .flatMap((entry) => (entry.kind === "mutation" ? [entry.entryId] : []));
    },
    reset(nextHistoryEpoch) {
      clearTimeline();
      historyEpoch = nextHistoryEpoch;
    },
    rememberAfter(entryId, after) {
      const mutation = pending.get(entryId);
      if (!mutation) {
        releaseSnapshot(after);
        return;
      }
      const projected = [...timeline.slice(0, cursor)];
      const nextAfter = ownedSnapshot(after);
      const existingIndex = projected.findIndex(
        (entry) => entry.kind === "mutation" && entry.entryId === entryId
      );
      let replaced: Extract<
        NotesSessionHistoryEntry,
        { kind: "mutation" }
      > | null = null;
      let replacement: Extract<
        NotesSessionHistoryEntry,
        { kind: "mutation" }
      > | null = null;
      if (existingIndex >= 0) {
        replaced = projected[existingIndex] as Extract<
          NotesSessionHistoryEntry,
          { kind: "mutation" }
        >;
        replacement = { ...replaced, after: nextAfter };
        projected[existingIndex] = replacement;
      } else {
        projected.push({
          kind: "mutation",
          entryId,
          before: mutation.before,
          after: nextAfter
        });
        mutation.committed = true;
      }
      let overflowed: NotesSessionHistoryEntry[] = [];
      if (projected.length > limit) {
        overflowed = projected.splice(0, projected.length - limit);
      }
      const removed = timeline.filter((entry) => !projected.includes(entry));
      const replacementRetained =
        replacement !== null && projected.includes(replacement);
      timeline = projected;
      cursor = timeline.length;
      if (replaced && replacementRetained) {
        // The replacement still owns `before`; only its superseded `after`
        // revision is no longer reachable.
        releaseSnapshot(replaced.after);
      }
      for (const entry of removed) {
        if (entry === replaced && replacementRetained) continue;
        releaseEntry(entry);
      }
      for (const entry of overflowed) {
        if (entry === replacement && replaced) {
          // The removed original entry released the shared `before` above.
          releaseSnapshot(entry.after);
        } else if (!timeline.includes(entry) && !removed.includes(entry)) {
          releaseEntry(entry);
        }
      }
      if (!mutation.text || textBurst?.entryId !== entryId) {
        pending.delete(entryId);
      }
    },
    snapshotCount() {
      return timeline.length +
        [...pending.values()].filter((mutation) => !mutation.committed).length;
    },
    snapshotForReplay(entryId, direction) {
      if (entryId === null) return null;
      const entry = timeline.find(
        (candidate) =>
          candidate.kind === "mutation" && candidate.entryId === entryId
      );
      if (!entry || entry.kind !== "mutation") return null;
      return cloneSnapshot(direction === "undo" ? entry.before : entry.after);
    },
    clearSnapshots() {
      clearTimeline();
    }
  };

  return session;
}
