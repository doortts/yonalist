import {
  isNotesHistoryResetResult,
  isNotesHistoryState,
  parseNotesError,
  type NoteId,
  type NotesHistoryState,
  type NotesHistoryStatus,
  type NotesStore,
  type NotesWorkspace,
  type NotesWorkspaceScope
} from "../../domain/notes";
import {
  createNotesHistorySession,
  notesExpansionSnapshotPool,
  type NotesHistoryFocusField,
  type NotesHistorySession,
  type NotesHistorySnapshot
} from "./notesHistory";
import type { ImageNodeInsertionAnchor } from "./imageNodeInsertion";
import {
  normalizeWorkspace,
  type NormalizedNotesWorkspace as PresentationWorkspace,
  type NotesWorkspaceDelta
} from "./notesWorkspaceReducer";
import { canonicalizeTagFilters, scopeKey } from "./notesWorkspaceScope";

export type NotesWorkspaceUiUpdate = Partial<{
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  pendingFocusField: NotesHistoryFocusField | null;
}>;

export type NotesWorkspaceQueueResult =
  | {
      kind: "authoritative";
      workspace: NotesWorkspace;
      uiUpdate?: NotesWorkspaceUiUpdate;
      historyStatus?: NotesHistoryStatus;
      historyVersion?: number;
      suppressSynchronization?: boolean;
      scopeAgnostic?: boolean;
      broadcastScope?: NotesWorkspaceScope;
      clearLocalExpansionSubtreeId?: NoteId;
      committedHistoryEntryIds?: readonly string[];
      invalidatesTagSummaries?: boolean;
      // Scope-consistent incremental delta forwarded to the reducer (and, via
      // synchronization, to same-scope sibling sessions) so the normalized
      // store is patched instead of fully re-normalized. Only ever set for the
      // active scope; see directMutationResult/runCompoundQueueWork.
      delta?: NotesWorkspaceDelta;
    }
  | { kind: "skipped" }
  | {
      kind: "failure";
      error: string;
      workspace?: NotesWorkspace;
      uiUpdate?: NotesWorkspaceUiUpdate;
      historyStatus?: NotesHistoryStatus;
      historyVersion?: number;
      scopeAgnostic?: boolean;
      broadcastScope?: NotesWorkspaceScope;
      clearLocalExpansionSubtreeId?: NoteId;
      committedHistoryEntryIds?: readonly string[];
      invalidatesTagSummaries?: boolean;
    };

export type NotesWorkspaceQueueSettlement = NotesWorkspaceQueueResult;

// The settlement verdict a caller gets back from enqueue/enqueueStructural.
// - "committed": the work ran and produced an authoritative workspace.
// - "skipped":   the work never ran (dropped draft-flush barrier, stale/closed
//                session, canceled item) or returned `{ kind: "skipped" }`.
// - "failed":    the work threw or returned `{ kind: "failure" }`.
export type NotesWorkspaceCommandOutcome = "committed" | "skipped" | "failed";

function settlementOutcome(
  result: NotesWorkspaceQueueSettlement
): NotesWorkspaceCommandOutcome {
  switch (result.kind) {
    case "authoritative":
      return "committed";
    case "failure":
      return "failed";
    default:
      return "skipped";
  }
}

export interface NotesWorkspaceQueueContext {
  repository: NotesStore;
  vaultRoot: string;
  confirmedWorkspace: NotesWorkspace;
  readonly sourceScope: NotesWorkspaceScope;
  readonly history?: NotesHistorySession;
}

export type NotesWorkspaceQueueWork = (
  context: NotesWorkspaceQueueContext
) => Promise<NotesWorkspaceQueueResult> | NotesWorkspaceQueueResult;

export type NotesPendingSelectionPolicy = "clear" | "preserve";

export type NotesWorkspaceCoordinatorEvent =
  | { type: "pending"; selectionPolicy: NotesPendingSelectionPolicy }
  | {
      type: "synchronized";
      result: NotesWorkspaceQueueSettlement;
      hasPendingWork: boolean;
      sourceScope: NotesWorkspaceScope | null;
    }
  | {
      type: "settled";
      result: NotesWorkspaceQueueSettlement;
      hasPendingWork: boolean;
    };

export interface OpenNotesWorkspaceSessionOptions {
  repository: NotesStore;
  vaultRoot: string;
  onEvent(event: NotesWorkspaceCoordinatorEvent): void;
  beforeStructural?: (cutoff: number) => Promise<boolean>;
  captureDraftCutoff?: () => number;
  afterStructural?: (cutoff: number) => void;
  isCurrent?: () => boolean;
  getScope?: () => NotesWorkspaceScope;
  presentation: "writable" | "background";
  captureHistoryLocation?: () => NotesHistorySnapshot;
  applyHistoryLocation?: (
    workspace: PresentationWorkspace,
    snapshot: NotesHistorySnapshot
  ) => boolean;
}

export interface NotesNavigationPresentationLease {
  setDestination(
    workspace: PresentationWorkspace,
    after: NotesHistorySnapshot
  ): void;
  commit(): readonly string[];
  cancel(): void;
}

export interface NotesWorkspaceCoordinatorSession {
  readonly activation: Promise<void>;
  readonly history: NotesHistorySession;
  reserveImageImportInsertion?(
    anchor: ImageNodeInsertionAnchor
  ): NotesWorkspaceImageImportReservation;
  enqueue(
    work: NotesWorkspaceQueueWork,
    options?: { silent?: boolean; observer?: boolean }
  ): Promise<NotesWorkspaceCommandOutcome>;
  enqueueStructural(
    work: NotesWorkspaceQueueWork,
    options?: {
      selectionPolicy?: NotesPendingSelectionPolicy;
      retainAfterClose?: boolean;
      requireAllBarriers?: boolean;
    }
  ): Promise<NotesWorkspaceCommandOutcome>;
  close(): void;
  ownerToken(): number;
  isCurrentOwner(token: number): boolean;
  reserveAdmittedNavigation(
    before: NotesHistorySnapshot
  ): NotesNavigationPresentationLease;
  settleAuthoritativePresentation(
    workspace: PresentationWorkspace,
    snapshot: NotesHistorySnapshot
  ): void;
  queueHistoryCleanup(entryIds: readonly string[]): void;
  drainHistoryCleanup(): Promise<void>;
  recoverHistoryMismatch(
    state: NotesHistoryState,
    reload: () => Promise<{
      workspace: PresentationWorkspace;
      snapshot: NotesHistorySnapshot;
    }>
  ): Promise<{
    workspace: PresentationWorkspace;
    snapshot: NotesHistorySnapshot;
  } | null>;
  resetHistory(
    historyEpoch: string,
    presentation: {
      workspace: PresentationWorkspace;
      snapshot: NotesHistorySnapshot;
    }
  ): void;
}

/** The intentionally small coordinator surface consumed by the draft engine. */
export type NotesDraftEngineCoordinatorSession = Pick<
  NotesWorkspaceCoordinatorSession,
  "activation" | "history" | "enqueue" | "enqueueStructural" | "close"
>;

export interface NotesWorkspaceImageImportReservation {
  resolve(): ImageNodeInsertionAnchor;
  commit(tailId: NoteId): void;
  release(): void;
}

export interface NotesWorkspaceCoordinatorRegistry {
  openSession(
    options: OpenNotesWorkspaceSessionOptions
  ): NotesWorkspaceCoordinatorSession;
  hasCoordinator(repository: NotesStore, vaultRoot: string): boolean;
}

interface CoordinatorEntry {
  repository: NotesStore;
  vaultRoot: string;
  confirmedWorkspace: NotesWorkspace;
  history: NotesHistorySession;
  initialized: boolean;
  sessions: Set<SessionState>;
  queue: QueueItem[];
  running: QueueItem | null;
  pendingActivation: ActivationItem | null;
  structuralTail: Promise<void>;
  pendingStructuralBarriers: number;
  historyStatus: NotesHistoryStatus;
  historyVersion: number;
  imageImportSequences: Map<string, ImageImportSequence>;
  ownerToken: number;
  owner: SessionState | null;
  closing: Promise<void> | null;
  pendingNext: PendingCoordinatorGeneration | null;
  installed: boolean;
  historyRecovery: Promise<{
    workspace: PresentationWorkspace;
    snapshot: NotesHistorySnapshot;
  } | null> | null;
  historyBlocked: boolean;
  presentationBlocked: boolean;
  authoritativePresentation: {
    workspace: PresentationWorkspace;
    snapshot: NotesHistorySnapshot;
    pendingOwnerApply: boolean;
  } | null;
  pendingHistoryCleanupIds: Set<string>;
  leases: Set<NavigationLeaseState>;
}

interface PendingCoordinatorGeneration {
  entry: CoordinatorEntry;
}

interface NavigationLeaseState {
  readonly entry: CoordinatorEntry;
  readonly before: NotesHistorySnapshot;
  after: NotesHistorySnapshot | null;
  workspace: PresentationWorkspace | null;
  active: boolean;
}

interface ImageImportSequence {
  readonly anchor: ImageNodeInsertionAnchor;
  pendingReservations: number;
  committedTailId: NoteId | null;
}

interface SessionState {
  entry: CoordinatorEntry;
  active: boolean;
  pendingWork: number;
  activationItem: ActivationItem | null;
  onEvent: ((event: NotesWorkspaceCoordinatorEvent) => void) | null;
  beforeStructural: ((cutoff: number) => Promise<boolean>) | null;
  captureDraftCutoff: (() => number) | null;
  afterStructural: ((cutoff: number) => void) | null;
  isCurrent: (() => boolean) | null;
  getScope: (() => NotesWorkspaceScope) | null;
  closeCompletion: Promise<void>;
  resolveClose: () => void;
  confirmedWorkspace: NotesWorkspace;
  presentation: "writable" | "background";
  strictPresentation: boolean;
  captureHistoryLocation: (() => NotesHistorySnapshot) | null;
  applyHistoryLocation:
    | ((workspace: PresentationWorkspace, snapshot: NotesHistorySnapshot) => boolean)
    | null;
  activated: boolean;
  ownerToken: number;
}

interface QueueItemBase {
  entry: CoordinatorEntry;
  completion: Promise<NotesWorkspaceCommandOutcome>;
  resolveCompletion: ((outcome: NotesWorkspaceCommandOutcome) => void) | null;
  canceled: boolean;
}

const LEGACY_HISTORY_SESSION_ID = "00000000-0000-4000-8000-000000000000";

function imageImportAnchorKey(anchor: ImageNodeInsertionAnchor): string {
  return `${anchor.parentId ?? ""}\u0000${anchor.afterId ?? ""}`;
}

interface ActivationItem extends QueueItemBase {
  kind: "activation";
  sessions: Set<SessionState>;
}

interface CommandItem extends QueueItemBase {
  kind: "command";
  owner: SessionState | null;
  retainAfterOwnerClose: boolean;
  work: NotesWorkspaceQueueWork | null;
  sourceScope: NotesWorkspaceScope;
  // Silent work (draft autosave) stays out of the loading/pending accounting:
  // it neither drives the "pending" event nor the pendingWork counter, so
  // background saves do not toggle aria-busy or force a full-pane re-render.
  silent: boolean;
  observer: boolean;
  ownerToken: number;
}

type QueueItem = ActivationItem | CommandItem;

function errorMessage(cause: unknown): string {
  return parseNotesError(cause).message;
}

function snapshotWorkspaceScope(
  scope: NotesWorkspaceScope
): NotesWorkspaceScope {
  return scope.kind === "tags"
    ? { kind: "tags", tags: canonicalizeTagFilters(scope.tags) }
    : { ...scope };
}

function completionParts<T>(): {
  completion: Promise<T>;
  resolveCompletion: (value: T) => void;
} {
  let resolveCompletion!: (value: T) => void;
  const completion = new Promise<T>((resolve) => {
    resolveCompletion = resolve;
  });
  return { completion, resolveCompletion };
}

function notify(
  session: SessionState,
  event: NotesWorkspaceCoordinatorEvent
): void {
  if (!session.active || !session.onEvent) {
    return;
  }
  try {
    session.onEvent(event);
  } catch {
    // A consumer callback cannot be allowed to strand the serialization queue.
  }
}

function hasLiveActivationSession(item: ActivationItem): boolean {
  return [...item.sessions].some(
    (session) => session.active && item.entry.sessions.has(session)
  );
}

const HISTORY_REOPEN_INSTRUCTION =
  "Notes history is out of sync. Please close and reopen this Vault.";
const MAX_PENDING_HISTORY_CLEANUP_IDS = 100;

function retainHistorySnapshot(snapshot: NotesHistorySnapshot): void {
  const revisions = snapshot.tagFilterOrigin
    ? [snapshot.expansion, snapshot.tagFilterOrigin.expansion]
    : [snapshot.expansion];
  for (const revision of revisions) {
    // Revisions carry their originating pool record, so the shared pool can
    // retain snapshots captured by another presentation-owned pool.
    notesExpansionSnapshotPool.retain(revision);
  }
}

function releaseHistorySnapshot(snapshot: NotesHistorySnapshot): void {
  const revisions = snapshot.tagFilterOrigin
    ? [snapshot.expansion, snapshot.tagFilterOrigin.expansion]
    : [snapshot.expansion];
  for (const revision of revisions) {
    notesExpansionSnapshotPool.release(revision);
  }
}

function workspaceFromPresentation(
  workspace: PresentationWorkspace
): NotesWorkspace {
  return {
    nodes: Object.values(workspace.nodesById),
    attachmentsByNodeId: workspace.attachmentsByNodeId
  };
}

export function createNotesWorkspaceCoordinatorRegistry(): NotesWorkspaceCoordinatorRegistry {
  const entries = new WeakMap<NotesStore, Map<string, CoordinatorEntry>>();

  const notifyReopenInstruction = (
    entry: CoordinatorEntry,
    preferred?: SessionState | null
  ): void => {
    const target =
      preferred?.active && preferred.presentation === "writable"
        ? preferred
        : [...entry.sessions].find(
            (session) => session.active && session.presentation === "writable"
          ) ?? null;
    if (!target) return;
    notify(target, {
      type: "settled",
      result: { kind: "failure", error: HISTORY_REOPEN_INSTRUCTION },
      hasPendingWork: target.pendingWork > 0
    });
  };

  const replaceAuthoritativePresentation = (
    entry: CoordinatorEntry,
    workspace: PresentationWorkspace,
    snapshot: NotesHistorySnapshot,
    retainNew: boolean,
    pendingOwnerApply = true
  ): void => {
    if (retainNew) retainHistorySnapshot(snapshot);
    const previous = entry.authoritativePresentation;
    entry.authoritativePresentation = {
      workspace,
      snapshot,
      pendingOwnerApply
    };
    if (previous) releaseHistorySnapshot(previous.snapshot);
  };

  const applyPresentationTo = (
    entry: CoordinatorEntry,
    candidate: SessionState
  ): boolean => {
    const presentation = entry.authoritativePresentation;
    if (!presentation) return true;
    if (!candidate.applyHistoryLocation) {
      return !candidate.strictPresentation;
    }
    try {
      return candidate.applyHistoryLocation(
        presentation.workspace,
        presentation.snapshot
      );
    } catch {
      return false;
    }
  };

  const confirmAppliedPresentation = (
    entry: CoordinatorEntry,
    candidate: SessionState
  ): void => {
    const presentation = entry.authoritativePresentation;
    if (presentation) {
      candidate.confirmedWorkspace = workspaceFromPresentation(
        presentation.workspace
      );
    }
  };

  const transferOwner = (
    entry: CoordinatorEntry,
    candidate: SessionState
  ): boolean => {
    if (
      !candidate.active ||
      !candidate.activated ||
      candidate.presentation !== "writable"
    ) {
      return false;
    }
    if (!applyPresentationTo(entry, candidate)) {
      entry.owner = null;
      entry.ownerToken += 1;
      candidate.ownerToken = 0;
      entry.presentationBlocked = true;
      if (entry.authoritativePresentation) {
        entry.authoritativePresentation.pendingOwnerApply = true;
      }
      notifyReopenInstruction(entry, candidate);
      return false;
    }
    confirmAppliedPresentation(entry, candidate);
    entry.ownerToken += 1;
    entry.owner = candidate;
    candidate.ownerToken = entry.ownerToken;
    entry.presentationBlocked = false;
    if (entry.authoritativePresentation) {
      entry.authoritativePresentation.pendingOwnerApply = false;
    }
    return true;
  };

  const cancelNavigationLease = (lease: NavigationLeaseState): void => {
    if (!lease.active) return;
    lease.active = false;
    lease.entry.leases.delete(lease);
    releaseHistorySnapshot(lease.before);
    if (lease.after) releaseHistorySnapshot(lease.after);
    lease.after = null;
    lease.workspace = null;
  };

  const drainHistoryCleanup = async (entry: CoordinatorEntry): Promise<void> => {
    if (entry.pendingHistoryCleanupIds.size === 0) return;
    const entryIds = [...entry.pendingHistoryCleanupIds];
    const state = await entry.repository.pruneHistoryEntries(entry.vaultRoot, {
      sessionId: entry.history.sessionId,
      historyEpoch: entry.history.historyEpoch,
      entryIds
    });
    if (!isNotesHistoryState(state) || !entry.history.accepts(state)) {
      entry.historyBlocked = true;
      throw new Error("Notes history cleanup returned an inconsistent state.");
    }
    for (const entryId of entryIds) {
      entry.pendingHistoryCleanupIds.delete(entryId);
    }
  };

  const resetEntryHistory = (
    entry: CoordinatorEntry,
    nextHistoryEpoch: string,
    presentation: {
      workspace: PresentationWorkspace;
      snapshot: NotesHistorySnapshot;
    }
  ): void => {
    // The replacement snapshot already owns a ref. Install it before releasing
    // any old timeline/canonical/lease owner that may share the same revision.
    const previous = entry.authoritativePresentation;
    entry.authoritativePresentation = {
      ...presentation,
      pendingOwnerApply: true
    };
    entry.history.reset(nextHistoryEpoch);
    for (const lease of [...entry.leases]) cancelNavigationLease(lease);
    if (previous) releaseHistorySnapshot(previous.snapshot);
    entry.pendingHistoryCleanupIds.clear();
    entry.historyBlocked = false;
    entry.presentationBlocked = true;
    const candidate = entry.owner;
    if (candidate && applyPresentationTo(entry, candidate)) {
      confirmAppliedPresentation(entry, candidate);
      entry.presentationBlocked = false;
      entry.authoritativePresentation.pendingOwnerApply = false;
    } else {
      entry.owner = null;
      entry.ownerToken += 1;
      notifyReopenInstruction(entry, candidate);
    }
  };

  const maybeDeleteEntry = (entry: CoordinatorEntry): void => {
    if (
      entry.sessions.size > 0 ||
      entry.running !== null ||
      entry.queue.length > 0 ||
      entry.pendingStructuralBarriers > 0 ||
      entry.historyRecovery !== null ||
      entry.closing !== null ||
      !entry.installed
    ) {
      return;
    }

    const repositoryEntries = entries.get(entry.repository);
    if (repositoryEntries?.get(entry.vaultRoot) !== entry) {
      return;
    }
    if (!entry.initialized) {
      repositoryEntries.delete(entry.vaultRoot);
      if (repositoryEntries.size === 0) entries.delete(entry.repository);
      return;
    }

    entry.owner = null;
    entry.ownerToken += 1;
    for (const lease of [...entry.leases]) cancelNavigationLease(lease);
    const previousPresentation = entry.authoritativePresentation;
    entry.authoritativePresentation = null;
    if (previousPresentation) {
      releaseHistorySnapshot(previousPresentation.snapshot);
    }
    entry.closing = (async () => {
      await Promise.resolve();
      try {
        await drainHistoryCleanup(entry);
      } catch {
        // Final close remains the guaranteed cleanup fallback.
      }
      try {
        await entry.repository.closeHistorySession(entry.vaultRoot, {
          sessionId: entry.history.sessionId,
          historyEpoch: entry.history.historyEpoch
        });
      } catch {
        // Close errors cannot strand the registry generation.
      } finally {
        entry.history.clearSnapshots();
        const currentEntries = entries.get(entry.repository);
        if (currentEntries?.get(entry.vaultRoot) === entry) {
          const pending = entry.pendingNext?.entry ?? null;
          if (pending) {
            pending.installed = true;
            currentEntries.set(entry.vaultRoot, pending);
            pump(pending);
            maybeDeleteEntry(pending);
          } else {
            currentEntries.delete(entry.vaultRoot);
            if (currentEntries.size === 0) entries.delete(entry.repository);
          }
        }
      }
    })();
  };

  const finishCompletion = (
    item: QueueItem,
    outcome: NotesWorkspaceCommandOutcome
  ): void => {
    const resolve = item.resolveCompletion;
    item.resolveCompletion = null;
    resolve?.(outcome);
  };

  const cancelItem = (item: QueueItem): void => {
    item.canceled = true;
    if (item.kind === "activation") {
      item.sessions.clear();
      if (item.entry.pendingActivation === item) {
        item.entry.pendingActivation = null;
      }
    } else {
      item.owner = null;
      item.work = null;
    }
    // A canceled item never ran, so its caller learns the command was dropped.
    finishCompletion(item, "skipped");
  };

  const reserveImageImportInsertion = (
    entry: CoordinatorEntry,
    anchor: ImageNodeInsertionAnchor
  ): NotesWorkspaceImageImportReservation => {
    const key = imageImportAnchorKey(anchor);
    let sequence = entry.imageImportSequences.get(key);
    if (!sequence) {
      sequence = {
        anchor,
        pendingReservations: 0,
        committedTailId: null
      };
      entry.imageImportSequences.set(key, sequence);
    }
    sequence.pendingReservations += 1;
    let released = false;

    return {
      resolve(): ImageNodeInsertionAnchor {
        if (released || sequence!.committedTailId === null) {
          return anchor;
        }
        return {
          parentId: sequence!.anchor.parentId,
          afterId: sequence!.committedTailId
        };
      },
      commit(tailId: NoteId): void {
        if (
          released ||
          entry.imageImportSequences.get(key) !== sequence
        ) {
          return;
        }
        sequence!.committedTailId = tailId;
      },
      release(): void {
        if (released) {
          return;
        }
        released = true;
        sequence!.pendingReservations = Math.max(
          0,
          sequence!.pendingReservations - 1
        );
        if (
          sequence!.pendingReservations === 0 &&
          entry.imageImportSequences.get(key) === sequence
        ) {
          entry.imageImportSequences.delete(key);
        }
      }
    };
  };

  const removeQueuedItem = (item: QueueItem): void => {
    const index = item.entry.queue.indexOf(item);
    if (index >= 0) {
      item.entry.queue.splice(index, 1);
    }
    cancelItem(item);
  };

  const settleItem = (
    item: QueueItem,
    result: NotesWorkspaceQueueSettlement
  ): void => {
    const entry = item.entry;
    if (entry.running !== item) {
      return;
    }
    entry.running = null;

    const authoritativeWorkspace =
      result.kind === "authoritative"
        ? result.workspace
        : result.kind === "failure"
          ? result.workspace
          : undefined;
    if (authoritativeWorkspace) {
      entry.confirmedWorkspace = authoritativeWorkspace;
    }

    if (item.kind === "activation") {
      if (entry.pendingActivation === item) {
        entry.pendingActivation = null;
      }
      for (const session of item.sessions) {
        if (session.activationItem === item) {
          session.activationItem = null;
        }
        if (!session.active) {
          continue;
        }
        session.activated = result.kind === "authoritative";
        if (authoritativeWorkspace) {
          session.confirmedWorkspace = authoritativeWorkspace;
        }
        if (
          authoritativeWorkspace &&
          session.presentation === "writable" &&
          session.activated
        ) {
          if (!entry.authoritativePresentation && session.captureHistoryLocation) {
            try {
              replaceAuthoritativePresentation(
                entry,
                normalizeWorkspace(authoritativeWorkspace),
                session.captureHistoryLocation(),
                false
              );
            } catch {
              entry.presentationBlocked = true;
              notifyReopenInstruction(entry, session);
            }
          }
          transferOwner(entry, session);
        }
        session.pendingWork = Math.max(0, session.pendingWork - 1);
        const presentation = entry.authoritativePresentation;
        // `transferOwner` applies the canonical location synchronously. Do
        // not immediately overwrite that callback state with activation's
        // raw active-workspace result for a newly activated owner.
        const presentationWorkspace =
          result.kind === "authoritative" &&
          entry.owner === session &&
          presentation &&
          !presentation.pendingOwnerApply
            ? workspaceFromPresentation(presentation.workspace)
            : null;
        if (presentationWorkspace) {
          session.confirmedWorkspace = presentationWorkspace;
        }
        const settledResult = presentationWorkspace
          ? { ...result, workspace: presentationWorkspace }
          : result;
        notify(session, {
          type: "settled",
          result: settledResult,
          hasPendingWork: session.pendingWork > 0
        });
      }
      item.sessions.clear();
    } else {
      const owner = item.owner;
      item.work = null;
      if (owner && authoritativeWorkspace) {
        owner.confirmedWorkspace = authoritativeWorkspace;
      }
      if (owner?.active) {
        if (!item.silent) {
          owner.pendingWork = Math.max(0, owner.pendingWork - 1);
        }
        notify(owner, {
          type: "settled",
          result,
          hasPendingWork: owner.pendingWork > 0
        });
      }
      if (
        authoritativeWorkspace &&
        !(result.kind === "authoritative" && result.suppressSynchronization)
      ) {
        const sourceScope =
          result.kind !== "skipped" && result.scopeAgnostic
            ? null
            : result.kind !== "skipped" && result.broadcastScope
              ? snapshotWorkspaceScope(result.broadcastScope)
              : owner?.active
                ? snapshotWorkspaceScope(
                    owner.getScope?.() ?? item.sourceScope
                  )
                : item.sourceScope;
        let synchronizedResult: NotesWorkspaceQueueSettlement;
        if (result.kind === "authoritative") {
          synchronizedResult = {
            kind: "authoritative",
            workspace: result.workspace,
            historyStatus: result.historyStatus,
            historyVersion: result.historyVersion,
            ...(result.delta ? { delta: result.delta } : {}),
            ...(result.clearLocalExpansionSubtreeId
              ? {
                  clearLocalExpansionSubtreeId:
                    result.clearLocalExpansionSubtreeId
                }
              : {}),
            ...(result.committedHistoryEntryIds
              ? {
                  committedHistoryEntryIds: result.committedHistoryEntryIds
                }
              : {}),
            ...(result.invalidatesTagSummaries
              ? { invalidatesTagSummaries: true }
              : {})
          };
        } else if (result.kind === "failure") {
          const {
            uiUpdate: _ownerUiUpdate,
            broadcastScope: _broadcastScope,
            ...synchronizedFailure
          } = result;
          synchronizedResult = synchronizedFailure;
        } else {
          synchronizedResult = result;
        }
        for (const session of entry.sessions) {
          if (session !== owner) {
            if (
              sourceScope !== null &&
              session.getScope &&
              scopeKey(session.getScope()) === scopeKey(sourceScope)
            ) {
              session.confirmedWorkspace = authoritativeWorkspace;
            }
            notify(session, {
              type: "synchronized",
              result: synchronizedResult,
              hasPendingWork: session.pendingWork > 0,
              sourceScope
            });
          }
        }
      }
      item.owner = null;
    }

    finishCompletion(item, settlementOutcome(result));
    pump(entry);
  };

  const executeItem = async (item: QueueItem): Promise<void> => {
    let result: NotesWorkspaceQueueSettlement;
    try {
      if (item.kind === "activation") {
        if (!item.entry.initialized) {
          let initialization: Promise<NotesHistoryState>;
          try {
            initialization = item.entry.repository.initialize(
              item.entry.vaultRoot,
              { sessionId: item.entry.history.sessionId }
            );
          } catch (cause) {
            await Promise.resolve();
            throw cause;
          }
          const initialState = await initialization;
          if (!isNotesHistoryState(initialState)) {
            throw new Error(
              "Notes initialization returned an invalid history state."
            );
          }
          item.entry.history.bindInitialization(initialState);
          item.entry.historyStatus = initialState;
          item.entry.initialized = true;
        }
        if (!hasLiveActivationSession(item)) {
          result = { kind: "skipped" };
        } else {
          const workspace = await item.entry.repository.loadWorkspace(
            item.entry.vaultRoot,
            { kind: "active" }
          );
          result = {
            kind: "authoritative",
            workspace,
            historyStatus: item.entry.historyStatus
          };
        }
      } else {
        const work = item.work;
        if (!work) {
          result = { kind: "skipped" };
        } else if (item.entry.historyBlocked || item.entry.presentationBlocked) {
          result = { kind: "failure", error: HISTORY_REOPEN_INSTRUCTION };
        } else {
          if (item.entry.pendingHistoryCleanupIds.size > 0) {
            await drainHistoryCleanup(item.entry);
          }
          result = await work({
            repository: item.entry.repository,
            vaultRoot: item.entry.vaultRoot,
            confirmedWorkspace:
              item.owner?.confirmedWorkspace ?? item.entry.confirmedWorkspace,
            sourceScope: snapshotWorkspaceScope(item.sourceScope),
            history: item.entry.history
          });
        }
      }
      if (
        result.kind === "authoritative" ||
        (result.kind === "failure" && result.workspace)
      ) {
        let status = result.historyStatus;
        if (!status && item.entry.repository.historyStatus) {
          try {
            status = await item.entry.repository.historyStatus(
              item.entry.vaultRoot,
              item.entry.history.sessionId
            );
          } catch {
            // Workspace authority remains valid when status discovery fails.
          }
        }
        if (status) {
          item.entry.historyStatus = status;
          item.entry.historyVersion += 1;
          result = {
            ...result,
            historyStatus: status,
            historyVersion: item.entry.historyVersion
          };
        }
      }
    } catch (cause) {
      result = { kind: "failure", error: errorMessage(cause) };
    }
    settleItem(item, result);
  };

  function pump(entry: CoordinatorEntry): void {
    if (entry.running) {
      return;
    }

    while (entry.queue.length > 0) {
      const item = entry.queue.shift()!;
      if (item.canceled) {
        continue;
      }
      if (
        (item.kind === "activation" && !hasLiveActivationSession(item)) ||
        (item.kind === "command" &&
          !item.owner?.active &&
          !item.retainAfterOwnerClose)
      ) {
        cancelItem(item);
        continue;
      }
      if (
        item.kind === "command" &&
        !item.retainAfterOwnerClose &&
        !item.observer &&
        !item.silent
      ) {
        const owner = item.owner;
        if (!owner || owner.presentation !== "writable") {
          cancelItem(item);
          continue;
        }
        if (
          item.ownerToken === 0 &&
          owner.activated &&
          entry.owner === owner
        ) {
          item.ownerToken = owner.ownerToken;
        }
        if (
          item.ownerToken === 0 ||
          entry.owner !== owner ||
          item.ownerToken !== entry.ownerToken
        ) {
          cancelItem(item);
          continue;
        }
      }

      entry.running = item;
      void executeItem(item);
      return;
    }

    maybeDeleteEntry(entry);
  }

  const createEntry = (
    repository: NotesStore,
    vaultRoot: string,
    installed: boolean
  ): CoordinatorEntry => ({
    repository,
    vaultRoot,
    confirmedWorkspace: { nodes: [] },
    history: createNotesHistorySession(
      typeof repository.undo === "function" &&
        typeof repository.redo === "function"
        ? undefined
        : { createId: () => LEGACY_HISTORY_SESSION_ID }
    ),
    initialized: false,
    sessions: new Set(),
    queue: [],
    running: null,
    pendingActivation: null,
    structuralTail: Promise.resolve(),
    pendingStructuralBarriers: 0,
    historyStatus: {
      canUndo: false,
      canRedo: false,
      historyEpoch: "",
      nextUndoEntryId: null,
      nextRedoEntryId: null,
      prunedEntryIds: []
    },
    historyVersion: 0,
    imageImportSequences: new Map(),
    ownerToken: 0,
    owner: null,
    closing: null,
    pendingNext: null,
    installed,
    historyRecovery: null,
    historyBlocked: false,
    presentationBlocked: false,
    authoritativePresentation: null,
    pendingHistoryCleanupIds: new Set(),
    leases: new Set()
  });

  const getOrCreateEntry = (
    repository: NotesStore,
    vaultRoot: string
  ): CoordinatorEntry => {
    let repositoryEntries = entries.get(repository);
    if (!repositoryEntries) {
      repositoryEntries = new Map();
      entries.set(repository, repositoryEntries);
    }

    let entry = repositoryEntries.get(vaultRoot);
    if (entry?.closing) {
      if (!entry.pendingNext) {
        entry.pendingNext = {
          entry: createEntry(repository, vaultRoot, false)
        };
      }
      return entry.pendingNext.entry;
    }
    if (!entry) {
      entry = createEntry(repository, vaultRoot, true);
      repositoryEntries.set(vaultRoot, entry);
    }
    return entry;
  };

  const closeSession = (session: SessionState): void => {
    if (!session.active) {
      return;
    }

    if (
      session.entry.owner === session &&
      session.captureHistoryLocation
    ) {
      try {
        replaceAuthoritativePresentation(
          session.entry,
          normalizeWorkspace(session.confirmedWorkspace),
          session.captureHistoryLocation(),
          false
        );
      } catch {
        session.entry.presentationBlocked = true;
      }
    }
    session.active = false;
    session.entry.sessions.delete(session);
    session.onEvent = null;
    session.beforeStructural = null;
    session.captureDraftCutoff = null;
    session.afterStructural = null;
    session.isCurrent = null;
    session.getScope = null;
    session.captureHistoryLocation = null;
    session.applyHistoryLocation = null;
    session.resolveClose();

    if (session.entry.owner === session) {
      session.entry.owner = null;
      session.entry.ownerToken += 1;
      const successor = [...session.entry.sessions].reverse().find(
        (candidate) =>
          candidate.active &&
          candidate.activated &&
          candidate.presentation === "writable"
      );
      if (successor) {
        transferOwner(session.entry, successor);
      } else if (session.entry.authoritativePresentation) {
        session.entry.presentationBlocked = true;
        session.entry.authoritativePresentation.pendingOwnerApply = true;
      }
    }

    const activation = session.activationItem;
    session.activationItem = null;
    if (activation) {
      activation.sessions.delete(session);
      if (
        activation.sessions.size === 0 &&
        session.entry.running !== activation
      ) {
        removeQueuedItem(activation);
      }
    }

    for (const item of [...session.entry.queue]) {
      if (
        item.kind === "command" &&
        item.owner === session &&
        !item.retainAfterOwnerClose
      ) {
        removeQueuedItem(item);
      }
    }

    session.pendingWork = 0;
    maybeDeleteEntry(session.entry);
  };

  return {
    openSession({
      repository,
      vaultRoot,
      onEvent,
      beforeStructural,
      captureDraftCutoff,
      afterStructural,
      isCurrent,
      getScope,
      presentation,
      captureHistoryLocation,
      applyHistoryLocation
    }: OpenNotesWorkspaceSessionOptions): NotesWorkspaceCoordinatorSession {
      const entry = getOrCreateEntry(repository, vaultRoot);
      const resolvedPresentation = presentation;
      const session: SessionState = {
        ...(() => {
          const close = completionParts<void>();
          return {
            closeCompletion: close.completion,
            resolveClose: close.resolveCompletion
          };
        })(),
        entry,
        active: true,
        pendingWork: 1,
        activationItem: null,
        onEvent,
        beforeStructural: beforeStructural ?? null,
        captureDraftCutoff: captureDraftCutoff ?? null,
        afterStructural: afterStructural ?? null,
        isCurrent: isCurrent ?? null,
        getScope: getScope ?? null,
        confirmedWorkspace: entry.confirmedWorkspace,
        presentation: resolvedPresentation,
        strictPresentation: true,
        captureHistoryLocation: captureHistoryLocation ?? null,
        applyHistoryLocation: applyHistoryLocation ?? null,
        activated: false,
        ownerToken: 0
      };
      entry.sessions.add(session);

      let activation = entry.pendingActivation;
      if (!activation) {
        const completion = completionParts<NotesWorkspaceCommandOutcome>();
        activation = {
          kind: "activation",
          entry,
          sessions: new Set(),
          canceled: false,
          ...completion
        };
        entry.pendingActivation = activation;
        entry.queue.push(activation);
      }
      activation.sessions.add(session);
      session.activationItem = activation;
      if (entry.installed) pump(entry);

      // Activation callers only await readiness, not the settlement verdict.
      const activationCompletion = activation.completion.then(() => undefined);
      const enqueueCommand = (
        work: NotesWorkspaceQueueWork,
        silent = false,
        selectionPolicy: NotesPendingSelectionPolicy = "clear",
        retainAfterOwnerClose = false,
        observer = false
      ): Promise<NotesWorkspaceCommandOutcome> => {
        if (!session.active && !retainAfterOwnerClose) {
          return Promise.resolve("skipped");
        }
        if (session.presentation === "background") {
          return Promise.resolve("skipped");
        }
        if (!retainAfterOwnerClose && !observer && entry.historyBlocked) {
          return Promise.resolve("failed");
        }
        if (!retainAfterOwnerClose && !observer && session.activated) {
          if (entry.presentationBlocked) {
            return Promise.resolve(
              transferOwner(entry, session) ? "skipped" : "failed"
            );
          }
          if (!silent && entry.owner !== session) {
            return Promise.resolve("skipped");
          }
        }
        const completion = completionParts<NotesWorkspaceCommandOutcome>();
        const item: CommandItem = {
          kind: "command",
          entry,
          owner: session,
          retainAfterOwnerClose,
          work,
          sourceScope: snapshotWorkspaceScope(
            session.getScope?.() ?? { kind: "active" }
          ),
          silent,
          observer,
          ownerToken: observer || silent ? 0 : session.ownerToken,
          canceled: false,
          ...completion
        };
        // Silent (draft autosave) work must not surface as loading: skip the
        // pendingWork bump and the "pending" event so aria-busy stays put. Its
        // settlement still emits a "settled" event so the authoritative
        // workspace is ingested.
        if (!silent) {
          session.pendingWork += 1;
        }
        entry.queue.push(item);
        if (!silent) {
          notify(session, { type: "pending", selectionPolicy });
        }
        pump(entry);
        return item.completion;
      };
      return {
        activation: activationCompletion,
        history: entry.history,
        reserveImageImportInsertion(
          anchor: ImageNodeInsertionAnchor
        ): NotesWorkspaceImageImportReservation {
          return reserveImageImportInsertion(entry, anchor);
        },
        enqueue(
          work: NotesWorkspaceQueueWork,
          options?: { silent?: boolean; observer?: boolean }
        ): Promise<NotesWorkspaceCommandOutcome> {
          return enqueueCommand(
            work,
            options?.silent ?? false,
            "clear",
            false,
            options?.observer ?? false
          );
        },
        enqueueStructural(
          work: NotesWorkspaceQueueWork,
          options?: {
            selectionPolicy?: NotesPendingSelectionPolicy;
            retainAfterClose?: boolean;
            requireAllBarriers?: boolean;
          }
        ): Promise<NotesWorkspaceCommandOutcome> {
          if (session.presentation === "background") {
            return Promise.resolve("skipped");
          }
          const retainAfterClose = options?.retainAfterClose === true;
          const requireAllBarriers = options?.requireAllBarriers === true;
          const participants = [...entry.sessions]
            .filter((participant) => participant.active)
            .map((participant) => {
              const cutoff = participant.captureDraftCutoff?.() ?? 0;
              const capturedBarrier = participant.beforeStructural;
              const capturedFinalizer = participant.afterStructural;
              const capturedIsCurrent = participant.isCurrent;
              let finalized = false;
              return {
                participant,
                cutoff,
                beforeStructural: capturedBarrier,
                isCurrent: capturedIsCurrent,
                finalize(): void {
                  if (finalized) {
                    return;
                  }
                  finalized = true;
                  try {
                    capturedFinalizer?.(cutoff);
                  } catch {
                    // Finalization cannot be allowed to strand the structural queue.
                  }
                }
              };
            });
          const finalizeParticipants = (): void => {
            for (const intent of participants) {
              intent.finalize();
            }
          };
          entry.pendingStructuralBarriers += 1;
          const runStructuralIntent =
            async (): Promise<NotesWorkspaceCommandOutcome> => {
              try {
                if (!session.active && !retainAfterClose) {
                  return "skipped";
                }
                for (const intent of participants) {
                  const participant = intent.participant;
                  if (!participant.active && !requireAllBarriers) {
                    continue;
                  }
                  if (
                    intent.beforeStructural &&
                    !(await intent.beforeStructural(intent.cutoff))
                  ) {
                    if (
                      requireAllBarriers ||
                      (participant.active &&
                        (intent.isCurrent?.() ?? true))
                    ) {
                      // The draft-flush barrier failed for a still-current
                      // participant: drop the structural command rather than
                      // commit it over an unsaved draft.
                      return "skipped";
                    }
                  }
                }
                const structural = enqueueCommand(
                  work,
                  false,
                  options?.selectionPolicy ?? "clear",
                  retainAfterClose
                );
                finalizeParticipants();
                return await structural;
              } finally {
                finalizeParticipants();
              }
            };
          const completion =
            entry.pendingStructuralBarriers === 1
              ? runStructuralIntent()
              : entry.structuralTail.then(runStructuralIntent);
          entry.structuralTail = completion
            .then(
              () => undefined,
              () => undefined
            )
            .finally(() => {
              entry.pendingStructuralBarriers = Math.max(
                0,
                entry.pendingStructuralBarriers - 1
              );
              maybeDeleteEntry(entry);
            });
          if (retainAfterClose) {
            return completion;
          }
          // If the session closes before the structural intent settles, the
          // command was effectively dropped for this caller.
          return Promise.race([
            completion,
            session.closeCompletion.then(
              (): NotesWorkspaceCommandOutcome => "skipped"
            )
          ]);
        },
        ownerToken(): number {
          return entry.owner === session ? session.ownerToken : 0;
        },
        isCurrentOwner(token: number): boolean {
          return (
            token !== 0 &&
            session.active &&
            entry.owner === session &&
            entry.ownerToken === token &&
            session.ownerToken === token
          );
        },
        reserveAdmittedNavigation(
          before: NotesHistorySnapshot
        ): NotesNavigationPresentationLease {
          if (
            session.presentation !== "writable" ||
            !session.active ||
            entry.owner !== session ||
            entry.ownerToken !== session.ownerToken ||
            entry.historyBlocked ||
            entry.presentationBlocked
          ) {
            return {
              setDestination() {},
              commit: () => [],
              cancel() {}
            };
          }
          retainHistorySnapshot(before);
          const state: NavigationLeaseState = {
            entry,
            before,
            after: null,
            workspace: null,
            active: true
          };
          entry.leases.add(state);
          return {
            setDestination(workspace, after) {
              if (!state.active) return;
              retainHistorySnapshot(after);
              if (state.after) releaseHistorySnapshot(state.after);
              state.workspace = workspace;
              state.after = after;
            },
            commit(): readonly string[] {
              if (!state.active || !state.after || !state.workspace) {
                cancelNavigationLease(state);
                return [];
              }
              const destination = state.after;
              const destinationWorkspace = state.workspace;
              // One additional owner belongs to canonical presentation; the
              // lease's two refs transfer to the timeline append below.
              retainHistorySnapshot(destination);
              state.active = false;
              entry.leases.delete(state);
              const cleanupIds = entry.history.appendNavigation(
                state.before,
                destination
              );
              replaceAuthoritativePresentation(
                entry,
                destinationWorkspace,
                destination,
                false
              );
              const candidate = entry.owner;
              if (!candidate || !applyPresentationTo(entry, candidate)) {
                entry.owner = null;
                entry.ownerToken += 1;
                entry.presentationBlocked = true;
                entry.authoritativePresentation!.pendingOwnerApply = true;
                notifyReopenInstruction(entry, candidate);
                if (candidate?.active) {
                  queueMicrotask(() => {
                    if (entry.presentationBlocked && candidate.active) {
                      transferOwner(entry, candidate);
                    }
                  });
                }
              } else {
                confirmAppliedPresentation(entry, candidate);
                entry.presentationBlocked = false;
                entry.authoritativePresentation!.pendingOwnerApply = false;
              }
              return cleanupIds;
            },
            cancel() {
              cancelNavigationLease(state);
            }
          };
        },
        settleAuthoritativePresentation(workspace, snapshot): void {
          replaceAuthoritativePresentation(entry, workspace, snapshot, true);
          const candidate = entry.owner;
          const applied = candidate
            ? candidate === session
              ? true
              : applyPresentationTo(entry, candidate)
            : false;
          if (!candidate || !applied) {
            entry.owner = null;
            entry.ownerToken += 1;
            entry.presentationBlocked = true;
            entry.authoritativePresentation!.pendingOwnerApply = true;
            notifyReopenInstruction(entry, candidate);
          } else {
            confirmAppliedPresentation(entry, candidate);
            entry.presentationBlocked = false;
            entry.authoritativePresentation!.pendingOwnerApply = false;
          }
        },
        queueHistoryCleanup(entryIds): void {
          for (const entryId of entryIds) {
            if (
              entry.pendingHistoryCleanupIds.size >=
              MAX_PENDING_HISTORY_CLEANUP_IDS
            ) {
              break;
            }
            entry.pendingHistoryCleanupIds.add(entryId);
          }
        },
        drainHistoryCleanup(): Promise<void> {
          return drainHistoryCleanup(entry);
        },
        recoverHistoryMismatch(_state, reload) {
          if (entry.historyRecovery) return entry.historyRecovery;
          entry.historyBlocked = true;
          const recovery = (async () => {
            // Install the single-flight promise before any synchronous
            // unavailable/throwing status path can reach `finally`.
            await Promise.resolve();
            try {
              if (!entry.repository.historyStatus) {
                throw new Error("Notes history status is unavailable.");
              }
              const status = await entry.repository.historyStatus(
                entry.vaultRoot,
                entry.history.sessionId
              );
              if (!isNotesHistoryState(status)) {
                throw new Error("Notes history status is invalid.");
              }
              const reset = await entry.repository.clearHistory(entry.vaultRoot, {
                sessionId: entry.history.sessionId,
                historyEpoch: status.historyEpoch
              });
              if (!isNotesHistoryResetResult(reset)) {
                throw new Error("Notes history reset was not acknowledged.");
              }
              const presentation = await reload();
              resetEntryHistory(entry, reset.historyEpoch, presentation);
              entry.historyStatus = reset;
              entry.historyVersion += 1;
              entry.historyBlocked = false;
              return presentation;
            } catch {
              entry.historyBlocked = true;
              notifyReopenInstruction(entry, session);
              return null;
            } finally {
              entry.historyRecovery = null;
              maybeDeleteEntry(entry);
            }
          })();
          entry.historyRecovery = recovery;
          return recovery;
        },
        resetHistory(historyEpoch, presentation): void {
          resetEntryHistory(entry, historyEpoch, presentation);
        },
        close(): void {
          closeSession(session);
        }
      };
    },

    hasCoordinator(repository: NotesStore, vaultRoot: string): boolean {
      return entries.get(repository)?.has(vaultRoot) ?? false;
    }
  };
}

export const notesWorkspaceCoordinatorRegistry =
  createNotesWorkspaceCoordinatorRegistry();
