import {
  isRetryableNotesErrorCode,
  parseNotesError
} from "../../domain/notes";
import type {
  NoteId,
  NoteNode,
  NotesHistoryContext,
  NotesStore,
  NotesStoreError,
  NotesWorkspace,
  NotesWorkspaceScope
} from "../../domain/notes";
import type { NotesWriteQueue } from "../../services/notesWriteQueue";
import type {
  NotesDraftEngineCoordinatorSession,
  NotesWorkspaceQueueContext,
  NotesWorkspaceQueueResult
} from "./notesWorkspaceCoordinator";
import type {
  NotesHistoryFocus,
  NotesHistoryFocusField
} from "./notesHistory";
import type { NotesNodeDraft } from "./useNotesWorkspace";
import type { NotesImageAtomFlushAdapter } from "./notesImageAtomEditorRegistry";

/**
 * A draft write that failed to persist. Retained per node so the write-failure
 * ledger can surface {@link NotesWorkspaceSessionRecord.writeError} and so the
 * engine can retry the exact captured snapshot.
 */
export interface FailedDraftWrite {
  attemptId: string;
  patch: Pick<NoteNode, "title" | "note" | "imageOffsetUtf16">;
  revision: number;
  focus: NotesHistoryFocus;
  error: NotesStoreError;
}

/**
 * One immutable attempt to persist a node draft. Attempts are reserved by a
 * stable key so a retry and a fresh keystroke never double-write the same
 * revision.
 */
export interface DraftWriteAttempt {
  readonly attemptId: string;
  readonly nodeId: NoteId;
  readonly draft: Readonly<NotesNodeDraft>;
  readonly focus: Readonly<NotesHistoryFocus>;
  readonly historyContext: NotesHistoryContext | null;
  readonly standaloneHistoryEntry: boolean;
}

/**
 * Shutdown-recovery bookkeeping shared across hook remounts. Lives in the
 * engine's module-level {@link recoveryRegistry} so a StrictMode unmount can
 * hand its unflushed drafts to the next mount of the same vault.
 */
export interface NotesWorkspaceRecoveryEntry {
  status: "pending" | "failed";
  drafts: Map<NoteId, NotesNodeDraft>;
  failedWritesByNodeId: Map<NoteId, FailedDraftWrite>;
  subscribers: Set<(entry: NotesWorkspaceRecoveryEntry) => void>;
}

/**
 * The per-session bookkeeping the draft engine owns. Created once per opened
 * coordinator session; the engine mutates it in place and publishes snapshots
 * of {@link drafts}/{@link writeError} to its subscribers.
 */
export interface NotesWorkspaceSessionRecord {
  repository: NotesStore;
  vaultRoot: string;
  session: NotesDraftEngineCoordinatorSession;
  writeQueue: NotesWriteQueue;
  drafts: Map<NoteId, NotesNodeDraft>;
  pendingDebounceByNodeId: Map<NoteId, number>;
  inFlightDraftByNodeId: Map<NoteId, number>;
  retryWriteByNodeId: Map<NoteId, DraftWriteAttempt>;
  deferredFieldAttempts: DraftWriteAttempt[];
  draftAttemptReservations: Map<string, Promise<boolean>>;
  draftHistoryContextByNodeId: Map<NoteId, NotesHistoryContext>;
  draftHistoryFocusByNodeId: Map<NoteId, NotesHistoryFocus>;
  nextDraftRevision: number;
  nextDraftAttemptId: number;
  structuralIntents: Array<{
    cutoff: number;
    initialCutoff: number;
    historyContexts: Set<NotesHistoryContext>;
  }>;
  failedWritesByNodeId: Map<NoteId, FailedDraftWrite>;
  writeError: NotesStoreError | null;
  recoveryEntry: NotesWorkspaceRecoveryEntry | null;
  imageAtomFlushAdapters: Map<symbol, NotesImageAtomFlushAdapter>;
  closing: boolean;
  closeCompletion: Promise<void> | null;
}

/**
 * Collaborators the engine calls back into. The hook still owns the history
 * owner registry, live navigation, active scope, and the reducer-facing write
 * mutation, so the engine reaches those through this host rather than importing
 * React state. Keeping the surface explicit is what lets the engine run
 * framework-free under plain listeners and fake timers.
 */
export interface NotesDraftEngineHost {
  beginTextEntry(
    record: NotesWorkspaceSessionRecord,
    nodeId: NoteId,
    focus: NotesHistoryFocus
  ): NotesHistoryContext | null;
  beginStandaloneTextEntry(
    record: NotesWorkspaceSessionRecord,
    nodeId: NoteId,
    focus: NotesHistoryFocus
  ): NotesHistoryContext | null;
  completeHistoryOwner(entryId: string): void;
  discardHistoryEntry(context: NotesHistoryContext | null | undefined): void;
  /**
   * Runs the actual `updateNode` write plus its scoped projection and history
   * bookkeeping. Kept in the hook because it consumes the active scope, the
   * history owner registry, and the shared projection helpers; the engine only
   * orchestrates the queue/reservation/settle machinery around it.
   */
  persistDraftMutation(
    context: NotesWorkspaceQueueContext,
    attempt: DraftWriteAttempt
  ): Promise<NotesWorkspaceQueueResult>;
  /** Mirrors the live-navigation edit made when a node's draft changes. */
  setDraftEditingNavigation(
    nodeId: NoteId,
    field: NotesHistoryFocusField
  ): void;
  /** The record the hook currently treats as active. */
  currentRecord(): NotesWorkspaceSessionRecord | null;
  /** The coordinator session the hook currently treats as active. */
  currentSession(): NotesDraftEngineCoordinatorSession | null;
  isDeletingNotesData(): boolean;
  /** Fan out to drafts subscribers (keystroke volatility only). */
  onDraftsChanged(): void;
  /** Fan out to write-error subscribers (failure-ledger volatility only). */
  onWriteErrorChanged(): void;
  /** Surfaces composition interruption through the existing Notes bottom bar. */
  onCompositionInterrupted?(): void;
}

export interface NotesDraftEngineOptions {
  repository: NotesStore;
  vaultRoot: string;
  session: NotesDraftEngineCoordinatorSession;
  writeQueue: NotesWriteQueue;
  host: NotesDraftEngineHost;
}

function writeError(cause: unknown): NotesStoreError {
  const { code, message } = parseNotesError(cause);
  return Object.assign(new Error(message), {
    operation: "write" as const,
    code,
    retryable: isRetryableNotesErrorCode(code)
  });
}

function draftSnapshot(
  drafts: Map<NoteId, NotesNodeDraft>
): Record<NoteId, NotesNodeDraft> {
  return Object.fromEntries(drafts) as Record<NoteId, NotesNodeDraft>;
}

function cloneDrafts(
  drafts: Map<NoteId, NotesNodeDraft>
): Map<NoteId, NotesNodeDraft> {
  return new Map(
    [...drafts].map(([nodeId, draft]) => [nodeId, { ...draft }])
  );
}

function cloneFailedWrites(
  failedWrites: Map<NoteId, FailedDraftWrite>,
  drafts?: Map<NoteId, NotesNodeDraft>
): Map<NoteId, FailedDraftWrite> {
  return new Map(
    [...failedWrites]
      .filter(([nodeId]) => !drafts || drafts.has(nodeId))
      .map(([nodeId, failed]) => [
        nodeId,
        {
          ...failed,
          patch: { ...failed.patch },
          focus: { ...failed.focus }
        }
      ])
  );
}

function draftWriteAttempt(
  attemptId: string,
  nodeId: NoteId,
  draft: NotesNodeDraft,
  focus: NotesHistoryFocus,
  historyContext: NotesHistoryContext | null,
  standaloneHistoryEntry = false
): DraftWriteAttempt {
  return {
    attemptId,
    nodeId,
    draft: { ...draft },
    focus: { ...focus },
    historyContext,
    standaloneHistoryEntry
  };
}

export function newDraftWriteAttempt(
  record: NotesWorkspaceSessionRecord,
  nodeId: NoteId,
  draft: NotesNodeDraft,
  focus: NotesHistoryFocus,
  historyContext: NotesHistoryContext | null,
  standaloneHistoryEntry = false
): DraftWriteAttempt {
  return draftWriteAttempt(
    `attempt-${record.nextDraftAttemptId++}`,
    nodeId,
    draft,
    focus,
    historyContext,
    standaloneHistoryEntry
  );
}

function failedDraftAttempt(
  nodeId: NoteId,
  failed: FailedDraftWrite
): DraftWriteAttempt {
  return draftWriteAttempt(
    failed.attemptId,
    nodeId,
    {
      ...failed.patch,
      revision: failed.revision,
      status: "failed"
    },
    failed.focus,
    null,
    true
  );
}

function draftAttemptReservationKey(attempt: DraftWriteAttempt): string {
  return `${attempt.attemptId}:${attempt.nodeId}:${attempt.draft.revision}`;
}

function reserveDraftAttempt(
  record: NotesWorkspaceSessionRecord,
  attempt: DraftWriteAttempt,
  enqueue: () => Promise<boolean>
): Promise<boolean> {
  const key = draftAttemptReservationKey(attempt);
  const existing = record.draftAttemptReservations.get(key);
  if (existing) {
    return existing;
  }

  let resolveCompletion!: (value: boolean) => void;
  let rejectCompletion!: (cause: unknown) => void;
  const completion = new Promise<boolean>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  let released = false;
  const release = (settle: () => void): void => {
    if (released) {
      return;
    }
    released = true;
    if (record.draftAttemptReservations.get(key) === completion) {
      record.draftAttemptReservations.delete(key);
    }
    settle();
  };

  record.draftAttemptReservations.set(key, completion);
  try {
    void enqueue().then(
      (value) => release(() => resolveCompletion(value)),
      (cause) => release(() => rejectCompletion(cause))
    );
  } catch (cause) {
    release(() => rejectCompletion(cause));
  }
  return completion;
}

function retryDraftAttempt(
  record: NotesWorkspaceSessionRecord,
  nodeId: NoteId,
  cutoff = record.structuralIntents.at(0)?.cutoff
): DraftWriteAttempt | undefined {
  const failed = record.failedWritesByNodeId.get(nodeId);
  const current = record.retryWriteByNodeId.get(nodeId);
  if (
    failed &&
    ((cutoff !== undefined && failed.revision <= cutoff) ||
      !current ||
      current.draft.revision <= failed.revision)
  ) {
    return failedDraftAttempt(nodeId, failed);
  }
  return current;
}

function latestWriteError(
  failedWrites: Map<NoteId, FailedDraftWrite>
): NotesStoreError | null {
  return [...failedWrites.values()].at(-1)?.error ?? null;
}

/**
 * Recovery registry, keyed by repository then vault root. Private to this
 * module so only the engine can reach it, yet held at module scope on purpose:
 * that is what lets it survive a StrictMode unmount/remount handoff, which is
 * the entire point — the remounting engine reads the previous engine's failed
 * drafts back out of it. (Formerly a free module global in the hook.)
 */
const recoveryRegistry = new WeakMap<
  NotesStore,
  Map<string, NotesWorkspaceRecoveryEntry>
>();

function recoveryEntryFor(
  repository: NotesStore,
  vaultRoot: string
): NotesWorkspaceRecoveryEntry | null {
  return recoveryRegistry.get(repository)?.get(vaultRoot) ?? null;
}

function setRecoveryEntry(
  repository: NotesStore,
  vaultRoot: string,
  entry: NotesWorkspaceRecoveryEntry
): void {
  let entries = recoveryRegistry.get(repository);
  if (!entries) {
    entries = new Map();
    recoveryRegistry.set(repository, entries);
  }
  entries.set(vaultRoot, entry);
}

function deleteRecoveryEntry(
  repository: NotesStore,
  vaultRoot: string,
  entry: NotesWorkspaceRecoveryEntry
): void {
  const entries = recoveryRegistry.get(repository);
  if (entries?.get(vaultRoot) !== entry) {
    return;
  }
  entries.delete(vaultRoot);
  if (entries.size === 0) {
    recoveryRegistry.delete(repository);
  }
}

function subscribeToRecovery(
  repository: NotesStore,
  vaultRoot: string,
  subscriber: (entry: NotesWorkspaceRecoveryEntry) => void
): () => void {
  const entry = recoveryEntryFor(repository, vaultRoot);
  if (!entry) {
    return () => undefined;
  }
  if (entry.status === "failed") {
    subscriber(entry);
    return () => undefined;
  }
  entry.subscribers.add(subscriber);
  return () => entry.subscribers.delete(subscriber);
}

/**
 * Framework-free owner of the Notes draft pipeline: per-node revision counters,
 * debounced/queued persistence, retry, the write-failure ledger that feeds
 * `writeError`, and the shutdown-recovery handoff. It publishes drafts and
 * write-error snapshots through two independent listener sets so a keystroke
 * never notifies write-error subscribers and vice versa.
 */
export class NotesDraftEngine {
  readonly record: NotesWorkspaceSessionRecord;
  private readonly host: NotesDraftEngineHost;
  private draftsSnapshotCache: Record<NoteId, NotesNodeDraft>;
  private writeErrorSnapshotCache: NotesStoreError | null;
  private readonly recoveryUnsubscribe: () => void;

  constructor(options: NotesDraftEngineOptions) {
    const { repository, vaultRoot, session, writeQueue, host } = options;
    this.host = host;
    this.record = {
      repository,
      vaultRoot,
      session,
      writeQueue,
      drafts: new Map(),
      pendingDebounceByNodeId: new Map(),
      inFlightDraftByNodeId: new Map(),
      retryWriteByNodeId: new Map(),
      deferredFieldAttempts: [],
      draftAttemptReservations: new Map(),
      draftHistoryContextByNodeId: new Map(),
      draftHistoryFocusByNodeId: new Map(),
      nextDraftRevision: 1,
      nextDraftAttemptId: 1,
      structuralIntents: [],
      failedWritesByNodeId: new Map(),
      writeError: null,
      recoveryEntry: null,
      imageAtomFlushAdapters: new Map(),
      closing: false,
      closeCompletion: null
    };
    this.draftsSnapshotCache = draftSnapshot(this.record.drafts);
    this.writeErrorSnapshotCache = this.record.writeError;
    this.recoveryUnsubscribe = subscribeToRecovery(
      repository,
      vaultRoot,
      (entry) => this.handleRecoveryFailed(entry)
    );
  }

  // --- Subscription surface -------------------------------------------------

  getDraftsSnapshot(): Record<NoteId, NotesNodeDraft> {
    return this.draftsSnapshotCache;
  }

  getWriteErrorSnapshot(): NotesStoreError | null {
    return this.writeErrorSnapshotCache;
  }

  /**
   * Republish the current record. Drafts subscribers always hear a fresh
   * snapshot (a keystroke always changes the buffer identity, matching the
   * previous `setDraftsByNodeId` behaviour); write-error subscribers hear a
   * notification only when the ledger's surfaced error actually changes.
   */
  private publish(): void {
    if (
      this.record.closing ||
      this.host.currentRecord() !== this.record
    ) {
      return;
    }
    this.draftsSnapshotCache = draftSnapshot(this.record.drafts);
    this.host.onDraftsChanged();
    if (this.record.writeError !== this.writeErrorSnapshotCache) {
      this.writeErrorSnapshotCache = this.record.writeError;
      this.host.onWriteErrorChanged();
    }
  }

  dispose(): void {
    this.recoveryUnsubscribe();
    this.record.imageAtomFlushAdapters.clear();
  }

  registerImageAtomFlushAdapter(adapter: NotesImageAtomFlushAdapter): () => void {
    const adapters = this.record.imageAtomFlushAdapters;
    const registration = Symbol("image-atom-flush-adapter");
    adapters.set(registration, adapter);
    return () => {
      adapters.delete(registration);
    };
  }

  private flushImageAtomEditors(nodeId?: NoteId): true | Promise<boolean> {
    const adapters = [...this.record.imageAtomFlushAdapters.values()].filter(
      (adapter) => nodeId === undefined || adapter.nodeId === nodeId
    );
    if (adapters.length === 0) return true;
    return (async () => {
      for (const adapter of adapters) {
        let result: "flushed" | "deferred" | "cancelled";
        try {
          result = await adapter.flush();
        } catch {
          result = "cancelled";
        }
        if (result === "cancelled") {
          this.host.onCompositionInterrupted?.();
          return false;
        }
      }
      return true;
    })();
  }

  // --- Recovery -------------------------------------------------------------

  private handleRecoveryFailed(entry: NotesWorkspaceRecoveryEntry): void {
    const record = this.record;
    const { repository, vaultRoot, session } = record;
    queueMicrotask(() => {
      if (
        entry.status !== "failed" ||
        recoveryEntryFor(repository, vaultRoot) !== entry ||
        record.closing ||
        this.host.currentRecord() !== record ||
        this.host.currentSession() !== session
      ) {
        return;
      }
      record.drafts = cloneDrafts(entry.drafts);
      record.failedWritesByNodeId = cloneFailedWrites(
        entry.failedWritesByNodeId,
        entry.drafts
      );
      record.nextDraftRevision = Math.max(
        record.nextDraftRevision,
        ...[...record.drafts.values()].map((draft) => draft.revision + 1)
      );
      record.writeError = latestWriteError(record.failedWritesByNodeId);
      record.recoveryEntry = entry;
      for (const [nodeId, draft] of record.drafts) {
        const failed = record.failedWritesByNodeId.get(nodeId);
        record.retryWriteByNodeId.set(
          nodeId,
          newDraftWriteAttempt(
            record,
            nodeId,
            draft,
            failed?.focus ?? { nodeId, field: "title" },
            null,
            true
          )
        );
      }
      this.publish();
    });
  }

  private beginShutdownRecovery(): NotesWorkspaceRecoveryEntry {
    const record = this.record;
    const existing = recoveryEntryFor(record.repository, record.vaultRoot);
    const entry: NotesWorkspaceRecoveryEntry = {
      status: "pending",
      drafts: cloneDrafts(record.drafts),
      failedWritesByNodeId: cloneFailedWrites(record.failedWritesByNodeId),
      subscribers: existing?.subscribers ?? new Set()
    };
    setRecoveryEntry(record.repository, record.vaultRoot, entry);
    record.recoveryEntry = entry;
    return entry;
  }

  private finishShutdownRecovery(entry: NotesWorkspaceRecoveryEntry): void {
    const record = this.record;
    if (record.drafts.size === 0) {
      deleteRecoveryEntry(record.repository, record.vaultRoot, entry);
      entry.subscribers.clear();
      record.recoveryEntry = null;
      return;
    }

    entry.status = "failed";
    entry.drafts = cloneDrafts(record.drafts);
    entry.failedWritesByNodeId = cloneFailedWrites(
      record.failedWritesByNodeId,
      record.drafts
    );
    for (const subscriber of entry.subscribers) {
      subscriber(entry);
    }
    entry.subscribers.clear();
  }

  private syncRecoveredDraft(nodeId: NoteId): void {
    const record = this.record;
    const entry = record.recoveryEntry;
    if (
      !entry ||
      entry.status !== "failed" ||
      recoveryEntryFor(record.repository, record.vaultRoot) !== entry ||
      !entry.drafts.has(nodeId)
    ) {
      return;
    }

    const draft = record.drafts.get(nodeId);
    const failed = record.failedWritesByNodeId.get(nodeId);
    if (draft) {
      entry.drafts.set(nodeId, { ...draft });
      if (failed) {
        entry.failedWritesByNodeId.set(nodeId, {
          ...failed,
          patch: { ...failed.patch }
        });
      }
      return;
    }

    entry.drafts.delete(nodeId);
    entry.failedWritesByNodeId.delete(nodeId);
    if (entry.drafts.size === 0) {
      deleteRecoveryEntry(record.repository, record.vaultRoot, entry);
      record.recoveryEntry = null;
    }
  }

  /**
   * Deletes any recovery entry for this engine's vault. Used when Notes data is
   * wiped so an unrelated remount cannot resurrect the discarded drafts.
   */
  clearRecovery(): void {
    const record = this.record;
    const entry = recoveryEntryFor(record.repository, record.vaultRoot);
    if (!entry) {
      return;
    }
    deleteRecoveryEntry(record.repository, record.vaultRoot, entry);
    entry.subscribers.clear();
    entry.drafts.clear();
    entry.failedWritesByNodeId.clear();
  }

  // --- Structural coordination hooks ---------------------------------------

  captureDraftCutoff(): number {
    const record = this.record;
    const cutoff = record.nextDraftRevision - 1;
    record.structuralIntents.push({
      cutoff,
      initialCutoff: cutoff,
      historyContexts: new Set(record.draftHistoryContextByNodeId.values())
    });
    record.draftHistoryContextByNodeId.clear();
    record.session.history.closeTextBurst();
    return cutoff;
  }

  async flushDraftBarrier(cutoff: number): Promise<boolean> {
    const record = this.record;
    if (record.closing) {
      await (record.closeCompletion ?? Promise.resolve());
      return record.drafts.size === 0;
    }
    if (
      this.host.currentRecord() !== record ||
      this.host.currentSession() !== record.session
    ) {
      return record.drafts.size === 0;
    }
    const hasImageAtomEditors = record.imageAtomFlushAdapters.size > 0;
    const imageAtomFlush = this.flushImageAtomEditors();
    if (imageAtomFlush !== true) {
      if (!(await imageAtomFlush)) return false;
    }
    // A composition-end callback can create its final draft after the
    // structural command captured a cutoff. Only active image editors can do
    // that during this barrier; ordinary post-command typing remains outside
    // the structural history boundary.
    const effectiveCutoff = hasImageAtomEditors
      ? Math.max(cutoff, record.nextDraftRevision - 1)
      : cutoff;
    const intent = record.structuralIntents.find(
      (candidate) => candidate.cutoff === cutoff || candidate.initialCutoff === cutoff
    );
    if (intent) intent.cutoff = effectiveCutoff;
    const flushed = await this.flushDraftsThroughCutoff(effectiveCutoff);
    if (flushed) {
      return true;
    }
    if (record.closing) {
      await (record.closeCompletion ?? Promise.resolve());
    }
    if (
      record.closing ||
      this.host.currentRecord() !== record ||
      this.host.currentSession() !== record.session
    ) {
      return record.drafts.size === 0;
    }
    return false;
  }

  releaseDraftBarrier(cutoff: number): void {
    const record = this.record;
    const index = record.structuralIntents.findIndex(
      (intent) => intent.cutoff === cutoff || intent.initialCutoff === cutoff
    );
    if (index >= 0) {
      const [intent] = record.structuralIntents.splice(index, 1);
      for (const context of intent?.historyContexts ?? []) {
        this.host.discardHistoryEntry(context);
      }
    }
    if (record.closing) {
      for (const attempt of record.deferredFieldAttempts) {
        this.host.discardHistoryEntry(attempt.historyContext);
      }
      record.deferredFieldAttempts.length = 0;
      for (const context of record.draftHistoryContextByNodeId.values()) {
        this.host.discardHistoryEntry(context);
      }
      record.draftHistoryContextByNodeId.clear();
      record.draftHistoryFocusByNodeId.clear();
      record.session.history.closeTextBurst();
      return;
    }
    this.scheduleDeferredDrafts();
  }

  private scheduleDeferredDrafts(): void {
    const record = this.record;
    const nextCutoff = record.structuralIntents.at(0)?.cutoff;
    const retainedAttempts: DraftWriteAttempt[] = [];
    for (const attempt of record.deferredFieldAttempts) {
      if (nextCutoff !== undefined && attempt.draft.revision > nextCutoff) {
        retainedAttempts.push(attempt);
        continue;
      }
      void this.enqueueDraftAttempt(attempt).catch(() => undefined);
    }
    record.deferredFieldAttempts = retainedAttempts;
    for (const [nodeId] of record.drafts) {
      const attempt = retryDraftAttempt(record, nodeId, nextCutoff);
      if (
        !attempt ||
        (nextCutoff !== undefined && attempt.draft.revision > nextCutoff) ||
        record.pendingDebounceByNodeId.has(nodeId) ||
        record.inFlightDraftByNodeId.has(nodeId)
      ) {
        continue;
      }
      this.scheduleDraftWrite(attempt);
    }
  }

  // --- Shutdown -------------------------------------------------------------

  beginShutdown(): Promise<void> {
    const record = this.record;
    if (record.closeCompletion) {
      return record.closeCompletion;
    }
    const closeAfterImageFlush = (): Promise<void> => {
      record.closing = true;
      if (record.drafts.size === 0) {
        record.session.close();
        return Promise.resolve();
      }
      const recoveryEntry = this.beginShutdownRecovery();
      const cutoff = record.structuralIntents.at(0)?.cutoff;
      for (const [nodeId] of record.drafts) {
        if (
          record.pendingDebounceByNodeId.has(nodeId) ||
          record.inFlightDraftByNodeId.has(nodeId)
        ) {
          continue;
        }
        const attempt = retryDraftAttempt(record, nodeId, cutoff);
        if (
          attempt &&
          (cutoff === undefined || attempt.draft.revision <= cutoff)
        ) {
          void reserveDraftAttempt(record, attempt, () =>
            record.writeQueue.enqueue(() => this.persistDraft(attempt))
          ).catch(() => undefined);
        }
      }
      const finish = (): void => {
        this.finishShutdownRecovery(recoveryEntry);
        record.session.close();
      };
      return record.writeQueue.flush().then(finish, finish);
    };
    const imageAtomFlush = this.flushImageAtomEditors();
    if (imageAtomFlush === true) {
      // Preserve the established synchronous shutdown kick-off for ordinary
      // text-only sessions. This matters to same-turn remount handoff.
      record.closeCompletion = closeAfterImageFlush();
      return record.closeCompletion;
    }
    // A browser-owned composition may be the only copy of an image-primary
    // edit. Let its adapter settle before closing the draft record.
    record.closeCompletion = imageAtomFlush.then(
      closeAfterImageFlush,
      closeAfterImageFlush
    );
    return record.closeCompletion;
  }

  // --- Draft pipeline -------------------------------------------------------

  private settleDraftWrite(
    attempt: DraftWriteAttempt,
    result: NotesWorkspaceQueueResult,
    writeSucceeded: boolean
  ): boolean {
    const record = this.record;
    const { nodeId, draft, historyContext } = attempt;
    const latest = record.drafts.get(nodeId);
    if (result.kind === "failure" && !writeSucceeded) {
      this.host.discardHistoryEntry(historyContext);
      if (
        record.draftHistoryContextByNodeId.get(nodeId)?.entryId ===
        historyContext?.entryId
      ) {
        record.draftHistoryContextByNodeId.delete(nodeId);
      }
      if (latest?.revision === draft.revision) {
        record.drafts.set(nodeId, { ...latest, status: "failed" });
      }
      const failure = writeError(result.error);
      record.failedWritesByNodeId.set(nodeId, {
        attemptId: attempt.attemptId,
        patch: {
          title: draft.title,
          note: draft.note,
          imageOffsetUtf16: draft.imageOffsetUtf16
        },
        revision: draft.revision,
        focus: { ...attempt.focus },
        error: failure
      });
      record.writeError = failure;
      this.syncRecoveredDraft(nodeId);
      this.publish();
      return false;
    }

    if (result.kind === "skipped") {
      this.host.discardHistoryEntry(historyContext);
      if (latest?.revision === draft.revision) {
        record.drafts.delete(nodeId);
      }
      if (record.pendingDebounceByNodeId.get(nodeId) === draft.revision) {
        record.pendingDebounceByNodeId.delete(nodeId);
      }
    } else if (writeSucceeded && latest?.revision === draft.revision) {
      record.drafts.delete(nodeId);
    }
    const failed = record.failedWritesByNodeId.get(nodeId);
    if (
      (result.kind === "skipped" || writeSucceeded) &&
      failed &&
      failed.revision <= draft.revision
    ) {
      record.failedWritesByNodeId.delete(nodeId);
    }
    if (attempt.standaloneHistoryEntry && historyContext) {
      record.session.history.closeTextBurst(historyContext.entryId);
      if (writeSucceeded) {
        this.host.completeHistoryOwner(historyContext.entryId);
      } else {
        this.host.discardHistoryEntry(historyContext);
      }
    }
    const activeHistoryContext =
      record.draftHistoryContextByNodeId.get(nodeId);
    if (
      writeSucceeded &&
      historyContext &&
      activeHistoryContext?.entryId !== historyContext.entryId
    ) {
      record.session.history.closeTextBurst(historyContext.entryId);
      this.host.completeHistoryOwner(historyContext.entryId);
    }
    record.writeError = latestWriteError(record.failedWritesByNodeId);
    if (!record.drafts.has(nodeId)) {
      record.retryWriteByNodeId.delete(nodeId);
      const historyContext = record.draftHistoryContextByNodeId.get(nodeId);
      record.draftHistoryContextByNodeId.delete(nodeId);
      record.draftHistoryFocusByNodeId.delete(nodeId);
      record.session.history.closeTextBurst(historyContext?.entryId);
      if (historyContext) {
        this.host.completeHistoryOwner(historyContext.entryId);
      }
    }
    this.syncRecoveredDraft(nodeId);
    this.publish();
    return result.kind !== "failure" || writeSucceeded;
  }

  private async persistDraft(
    scheduledAttempt: DraftWriteAttempt
  ): Promise<boolean> {
    const record = this.record;
    const cutoff = record.structuralIntents.at(0)?.cutoff;
    if (cutoff !== undefined && scheduledAttempt.draft.revision > cutoff) {
      return false;
    }
    const attempt =
      scheduledAttempt.standaloneHistoryEntry &&
      !scheduledAttempt.historyContext
        ? {
            ...scheduledAttempt,
            historyContext: this.host.beginStandaloneTextEntry(
              record,
              scheduledAttempt.nodeId,
              scheduledAttempt.focus
            )
          }
        : scheduledAttempt;
    const { nodeId, draft } = attempt;
    const current = record.drafts.get(nodeId);
    if (current?.revision === draft.revision && current.status !== "pending") {
      record.drafts.set(nodeId, { ...current, status: "pending" });
      this.publish();
    }
    record.inFlightDraftByNodeId.set(nodeId, draft.revision);

    let result: NotesWorkspaceQueueResult | undefined;
    // Draft autosave is enqueued silently so it settles through the drafts
    // slice without toggling the global loading/aria-busy state. The settled
    // event still commits the authoritative workspace via settleQueueWork.
    await record.session.enqueue(
      async (context) => {
        result = await this.host.persistDraftMutation(context, attempt);
        return result;
      },
      { silent: true }
    );
    if (record.inFlightDraftByNodeId.get(nodeId) === draft.revision) {
      record.inFlightDraftByNodeId.delete(nodeId);
    }

    if (!result) {
      return false;
    }

    return this.settleDraftWrite(
      attempt,
      result,
      result.kind === "authoritative" ||
        (result.kind === "failure" && result.scopeAgnostic === true)
    );
  }

  private enqueueDraftAttempt(attempt: DraftWriteAttempt): Promise<boolean> {
    const record = this.record;
    return reserveDraftAttempt(record, attempt, () =>
      record.writeQueue.enqueue(() => this.persistDraft(attempt))
    );
  }

  private writeScheduledDraft(attempt: DraftWriteAttempt): Promise<boolean> {
    const record = this.record;
    const { nodeId, draft } = attempt;
    if (record.pendingDebounceByNodeId.get(nodeId) === draft.revision) {
      record.pendingDebounceByNodeId.delete(nodeId);
    }
    return this.persistDraft(attempt);
  }

  private scheduleDraftWrite(attempt: DraftWriteAttempt): void {
    const record = this.record;
    const { nodeId, draft } = attempt;
    const cutoff = record.structuralIntents.at(0)?.cutoff;
    if (cutoff !== undefined && draft.revision > cutoff) {
      return;
    }
    record.pendingDebounceByNodeId.set(nodeId, draft.revision);
    void reserveDraftAttempt(record, attempt, () =>
      record.writeQueue.enqueueDebounced(nodeId, () =>
        this.writeScheduledDraft(attempt)
      )
    ).catch(() => undefined);
  }

  updateNodeDraft(
    nodeId: NoteId,
    patch: Pick<NoteNode, "title" | "note" | "imageOffsetUtf16">,
    field: NotesHistoryFocusField = "title"
  ): void {
    const record = this.record;
    if (
      record.closing ||
      this.host.currentRecord() !== record ||
      this.host.currentSession() !== record.session
    ) {
      return;
    }
    const previous = record.drafts.get(nodeId);
    const focus = { nodeId, field } satisfies NotesHistoryFocus;
    const previousFocus = record.draftHistoryFocusByNodeId.get(nodeId);
    if (previousFocus && previousFocus.field !== field) {
      const previousHistoryContext =
        record.draftHistoryContextByNodeId.get(nodeId);
      const previousAttempt = record.retryWriteByNodeId.get(nodeId);
      record.session.history.closeTextBurst(previousHistoryContext?.entryId);
      if (
        previousHistoryContext &&
        previousAttempt?.historyContext?.entryId ===
          previousHistoryContext.entryId &&
        record.pendingDebounceByNodeId.get(nodeId) ===
          previousAttempt.draft.revision
      ) {
        void record.writeQueue.flush(nodeId).catch(() => undefined);
      } else if (
        previousHistoryContext &&
        previousAttempt?.historyContext?.entryId ===
          previousHistoryContext.entryId
      ) {
        const reservationKey = draftAttemptReservationKey(previousAttempt);
        if (!record.draftAttemptReservations.has(reservationKey)) {
          const cutoff = record.structuralIntents.at(0)?.cutoff;
          if (cutoff !== undefined && previousAttempt.draft.revision > cutoff) {
            if (
              !record.deferredFieldAttempts.some(
                (attempt) => attempt.attemptId === previousAttempt.attemptId
              )
            ) {
              record.deferredFieldAttempts.push(previousAttempt);
            }
          } else {
            void this.enqueueDraftAttempt(previousAttempt).catch(
              () => undefined
            );
          }
        }
      } else {
        this.host.discardHistoryEntry(previousHistoryContext);
      }
      record.draftHistoryContextByNodeId.delete(nodeId);
    }
    this.host.setDraftEditingNavigation(nodeId, field);
    if (!previous || !record.draftHistoryContextByNodeId.has(nodeId)) {
      const historyContext = this.host.beginTextEntry(record, nodeId, focus);
      if (historyContext) {
        record.draftHistoryContextByNodeId.set(nodeId, historyContext);
      }
    }
    record.draftHistoryFocusByNodeId.set(nodeId, focus);
    const draft: NotesNodeDraft = {
      ...patch,
      revision: record.nextDraftRevision++,
      status: previous?.status === "failed" ? "failed" : "pending"
    };
    record.drafts.set(nodeId, draft);
    const scheduledHistoryContext =
      record.draftHistoryContextByNodeId.get(nodeId);
    const attempt = newDraftWriteAttempt(
      record,
      nodeId,
      draft,
      focus,
      scheduledHistoryContext ?? null
    );
    record.retryWriteByNodeId.set(nodeId, attempt);
    this.syncRecoveredDraft(nodeId);
    this.publish();
    const earliestCutoff = record.structuralIntents.at(0)?.cutoff;
    if (earliestCutoff === undefined || draft.revision <= earliestCutoff) {
      this.scheduleDraftWrite(attempt);
    }
  }

  async flushNodeDraft(nodeId: NoteId): Promise<boolean> {
    const record = this.record;
    if (
      record.closing ||
      this.host.currentRecord() !== record ||
      this.host.currentSession() !== record.session
    ) {
      return false;
    }
    const imageAtomFlush = this.flushImageAtomEditors(nodeId);
    if (imageAtomFlush !== true) {
      if (!(await imageAtomFlush)) return false;
    }
    const draft = record.drafts.get(nodeId);
    if (draft) {
      try {
        const cutoff = record.structuralIntents.at(0)?.cutoff;
        const attempt = retryDraftAttempt(record, nodeId, cutoff);
        if (
          attempt &&
          !record.pendingDebounceByNodeId.has(nodeId) &&
          !record.inFlightDraftByNodeId.has(nodeId)
        ) {
          if (cutoff !== undefined && attempt.draft.revision > cutoff) {
            return false;
          }
          await this.enqueueDraftAttempt(attempt);
        } else {
          await record.writeQueue.flush(nodeId);
        }
      } catch {
        return false;
      }
    }
    return (
      !record.closing &&
      this.host.currentRecord() === record &&
      this.host.currentSession() === record.session &&
      !record.drafts.has(nodeId)
    );
  }

  async retryFailedDraft(nodeId: NoteId): Promise<void> {
    if (this.host.isDeletingNotesData()) {
      return;
    }
    const record = this.record;
    const failed = record.failedWritesByNodeId.get(nodeId);
    if (
      !failed ||
      record.closing ||
      this.host.currentRecord() !== record ||
      this.host.currentSession() !== record.session
    ) {
      return;
    }
    if (!record.drafts.has(nodeId)) {
      record.failedWritesByNodeId.delete(nodeId);
      record.writeError = latestWriteError(record.failedWritesByNodeId);
      this.syncRecoveredDraft(nodeId);
      this.publish();
      return;
    }

    const cutoff = record.structuralIntents.at(0)?.cutoff;
    const attempt = retryDraftAttempt(record, nodeId, cutoff);
    if (!attempt) {
      return;
    }
    if (
      record.pendingDebounceByNodeId.get(nodeId) === attempt.draft.revision ||
      record.inFlightDraftByNodeId.get(nodeId) === attempt.draft.revision
    ) {
      await record.writeQueue.flush(nodeId);
      return;
    }
    if (cutoff !== undefined && attempt.draft.revision > cutoff) {
      return;
    }
    await this.enqueueDraftAttempt(attempt);
  }

  async retryLastFailedWrite(): Promise<void> {
    const nodeId = [...this.record.failedWritesByNodeId.keys()].at(-1);
    if (nodeId) {
      await this.retryFailedDraft(nodeId);
    }
  }

  async flushAllDrafts(): Promise<boolean> {
    const record = this.record;
    if (
      record.closing ||
      this.host.currentRecord() !== record ||
      this.host.currentSession() !== record.session
    ) {
      return false;
    }
    const imageAtomFlush = this.flushImageAtomEditors();
    if (imageAtomFlush !== true) {
      if (!(await imageAtomFlush)) return false;
    }
    while (true) {
      const cutoff = record.structuralIntents.at(0)?.cutoff;
      for (const [nodeId] of record.drafts) {
        if (
          record.pendingDebounceByNodeId.has(nodeId) ||
          record.inFlightDraftByNodeId.has(nodeId)
        ) {
          continue;
        }
        const attempt = retryDraftAttempt(record, nodeId, cutoff);
        if (
          attempt &&
          (cutoff === undefined || attempt.draft.revision <= cutoff)
        ) {
          void this.enqueueDraftAttempt(attempt).catch(() => undefined);
        }
      }
      await record.writeQueue.flush();
      if (
        record.closing ||
        this.host.currentRecord() !== record ||
        this.host.currentSession() !== record.session
      ) {
        return false;
      }
      if (record.drafts.size === 0) {
        record.session.history.closeTextBurst();
        return true;
      }
      const hasRetryableWork = [...record.drafts].some(([nodeId]) => {
        const attempt = retryDraftAttempt(record, nodeId, cutoff);
        return (
          attempt !== undefined &&
          (cutoff === undefined || attempt.draft.revision <= cutoff) &&
          (record.pendingDebounceByNodeId.has(nodeId) ||
            record.inFlightDraftByNodeId.has(nodeId) ||
            (!record.failedWritesByNodeId.has(nodeId) &&
              record.retryWriteByNodeId.has(nodeId)))
        );
      });
      if (!hasRetryableWork) {
        return false;
      }
    }
  }

  private async flushDraftsThroughCutoff(cutoff: number): Promise<boolean> {
    const record = this.record;
    while (true) {
      for (const [nodeId] of record.drafts) {
        if (
          record.pendingDebounceByNodeId.has(nodeId) ||
          record.inFlightDraftByNodeId.has(nodeId)
        ) {
          continue;
        }
        const attempt = retryDraftAttempt(record, nodeId, cutoff);
        if (attempt && attempt.draft.revision <= cutoff) {
          void this.enqueueDraftAttempt(attempt).catch(() => undefined);
        }
      }
      await record.writeQueue.flush();
      if (
        record.closing ||
        this.host.currentRecord() !== record ||
        this.host.currentSession() !== record.session
      ) {
        return false;
      }
      const remaining = [...record.drafts].filter(([nodeId, draft]) => {
        const failed = record.failedWritesByNodeId.get(nodeId);
        return (
          draft.revision <= cutoff ||
          (failed !== undefined && failed.revision <= cutoff)
        );
      });
      if (remaining.length === 0) {
        const intent = record.structuralIntents.find(
          (candidate) => candidate.cutoff === cutoff
        );
        for (const context of intent?.historyContexts ?? []) {
          this.host.completeHistoryOwner(context.entryId);
        }
        intent?.historyContexts.clear();
        return true;
      }
      const retryable = remaining.some(
        ([nodeId]) =>
          record.pendingDebounceByNodeId.has(nodeId) ||
          record.inFlightDraftByNodeId.has(nodeId)
      );
      if (!retryable) {
        return false;
      }
    }
  }

  // --- Data-deletion helpers ------------------------------------------------

  private clearDraftBookkeeping(): void {
    const record = this.record;
    record.drafts.clear();
    record.pendingDebounceByNodeId.clear();
    record.inFlightDraftByNodeId.clear();
    record.retryWriteByNodeId.clear();
    record.draftAttemptReservations.clear();
    record.draftHistoryContextByNodeId.clear();
    record.draftHistoryFocusByNodeId.clear();
    record.failedWritesByNodeId.clear();
    record.writeError = null;
  }

  /** Drops every pending draft without attempting to persist it. */
  discardPendingDrafts(): void {
    this.clearDraftBookkeeping();
    this.publish();
  }

  /**
   * Clears all draft bookkeeping and the recovery entry after the vault's data
   * has been deleted, then republishes the now-empty state.
   */
  resetAfterDataDeletion(): void {
    this.clearDraftBookkeeping();
    this.record.recoveryEntry = null;
    this.record.session.history.clearSnapshots();
    this.clearRecovery();
    this.publish();
  }
}
