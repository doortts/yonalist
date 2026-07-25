import {
  isNotesMutationOutcomeUnknown,
  isNotesHistoryResetResult,
  isNotesHistoryState,
  normalizeNotesWorkspace,
  parseNotesError,
  type NoteId,
  type NoteTagSummary,
  type NotesHistoryContext,
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
  type NotesHistoryPrimarySelection,
  type NotesHistorySession,
  type NotesHistorySnapshot
} from "./notesHistory";
import type { ImageNodeInsertionAnchor } from "./imageNodeInsertion";
import type { NotesPaneId } from "./notesPaneSession";
import {
  normalizeWorkspace,
  type NormalizedNotesWorkspace as PresentationWorkspace,
  type NotesWorkspaceDelta
} from "./notesWorkspaceReducer";
import { canonicalizeTagFilters, scopeKey } from "./notesWorkspaceScope";
import {
  classifyKeyboardInsertionPublication,
  createKeyboardInsertionRegistry,
  createOutlineVisibleSignature,
  type NotesProjectionPublicationOwner,
  type OptimisticInsertionFailure,
  type OptimisticInsertionSnapshot,
  type OptimisticKeyboardInsertion,
  type OptimisticKeyboardInsertionStatus,
  optimisticInsertionRecoveryText,
  type OutlinePanePublicationSnapshot,
  type PendingKeyboardInsertion
} from "./notesKeyboardInsertion";
import {
  flattenVisibleOutlineRows,
  type FlattenedOutlineRow
} from "./outlineTree";
import {
  appendBackspaceRemoval,
  type OptimisticBackspaceGesture
} from "./notesBackspaceGesture";
import type {
  NotesBackspaceDraftCommit,
  NotesBackspaceDraftLease,
  NotesKeyboardInsertionPreparation,
  NotesKeyboardInsertionRequest,
  NotesProjectionPublication
} from "./notesWorkspaceTypes";
import {
  recoverUnknownOutcome,
  type NotesUnknownOutcomeDecision,
  type NotesUnknownOutcomeExpectation,
  type NotesWriteAuthority
} from "./notesAuthorityRecovery";

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
      projectionScope?: NotesWorkspaceScope;
      projectionLocallyExpandedNodeIds?: ReadonlySet<NoteId>;
      clearLocalExpansionSubtreeId?: NoteId;
      committedHistoryEntryIds?: readonly string[];
      /**
       * Compatibility proof for repository test doubles that still return a
       * raw workspace instead of an atomic mutation receipt. Production
       * mutation receipts never populate this field.
       */
      nonAtomicHistoryEntryIds?: readonly string[];
      invalidatesTagSummaries?: boolean;
      tagSummaries?: readonly NoteTagSummary[];
      // Scope-consistent incremental delta forwarded to the reducer (and, via
      // synchronization, to same-scope sibling sessions) so the normalized
      // store is patched instead of fully re-normalized. Only ever set for the
      // active scope; see directMutationResult/runCompoundQueueWork.
      delta?: NotesWorkspaceDelta;
      projectionPublication?: NotesProjectionPublication;
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
      projectionPublication?: NotesProjectionPublication;
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

export interface NotesBackspaceGestureCommitInput {
  readonly gesture: OptimisticBackspaceGesture;
  readonly historyContext: NotesHistoryContext;
  readonly draftCommit: NotesBackspaceDraftCommit;
}

export type NotesBackspaceGestureQueueWork = (
  context: NotesWorkspaceQueueContext,
  input: NotesBackspaceGestureCommitInput
) => Promise<NotesWorkspaceQueueResult> | NotesWorkspaceQueueResult;

export type NotesWorkspaceCoordinatorEvent =
  | { type: "pending"; selectionPolicy: NotesPendingSelectionPolicy }
  | { type: "authorityRecovery"; authority: NotesWriteAuthority }
  | {
      type: "optimisticInsertion";
      snapshot: OptimisticInsertionSnapshot;
      rollback?: {
        ownerPaneId: string;
        sourceId: NoteId;
        selection: NotesHistoryPrimarySelection;
      };
    }
  | {
      type: "optimisticBackspaceGesture";
      snapshot: OptimisticBackspaceGesture | null;
      rollback?: {
        ownerPaneId: NotesPaneId;
        nodeId: NoteId;
        selection: NotesHistoryPrimarySelection;
      };
    }
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
  captureDraftCutoff?: (
    publicationOwner: NotesProjectionPublicationOwner
  ) => number;
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
  beforeSnapshot(): NotesHistorySnapshot | null;
  replaceBefore(before: NotesHistorySnapshot): void;
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
  drain(): Promise<boolean>;
  isLifecycleDraining(): boolean;
  reserveImageImportInsertion?(
    anchor: ImageNodeInsertionAnchor
  ): NotesWorkspaceImageImportReservation;
  enqueue(
    work: NotesWorkspaceQueueWork,
    options?: {
      silent?: boolean;
      observer?: boolean;
      publicationOwner?: NotesProjectionPublicationOwner;
      unknownOutcomeExpectation?: NotesUnknownOutcomeExpectation;
    }
  ): Promise<NotesWorkspaceCommandOutcome>;
  enqueueStructural(
    work: NotesWorkspaceQueueWork,
    options?: {
      selectionPolicy?: NotesPendingSelectionPolicy;
      retainAfterClose?: boolean;
      requireAllBarriers?: boolean;
      settleFailure?: (error: string) => void;
      keyboardInsertion?: NotesKeyboardInsertionPreparation;
      unknownOutcomeExpectation?: NotesUnknownOutcomeExpectation;
    }
  ): Promise<NotesWorkspaceCommandOutcome>;
  prepareKeyboardInsertion(
    input: NotesKeyboardInsertionRequest
  ): NotesKeyboardInsertionPreparation | null;
  cancelKeyboardInsertion(
    preparation: NotesKeyboardInsertionPreparation
  ): void;
  updateOptimisticKeyboardInsertion(
    expectedNodeId: NoteId,
    title: string
  ): void;
  acknowledgeOptimisticKeyboardInsertionFocus(
    expectedNodeId: NoteId,
    intentToken: number
  ): void;
  dismissOptimisticInsertionFailure(): void;
  pendingKeyboardInsertion(
    expectedNodeId: NoteId
  ): PendingKeyboardInsertion | undefined;
  beginBackspaceGesture(
    input: {
      readonly ownerPaneId: NotesPaneId;
      readonly nodeId: NoteId;
      readonly selection: NotesHistoryPrimarySelection;
    },
    createDraftLease: (token: number) => NotesBackspaceDraftLease | null,
    work: NotesBackspaceGestureQueueWork
  ): number | null;
  touchBackspaceGesture(token: number, nodeId: NoteId): void;
  removeEmptyNodeInBackspaceGesture(
    token: number,
    nodeId: NoteId,
    focusNodeId: NoteId | null
  ): boolean;
  finishBackspaceGesture(
    reason: "keyup" | "blur" | "hidden" | "drain"
  ): Promise<NotesWorkspaceCommandOutcome>;
  cancelBackspaceGesture(): void;
  publishOutlinePaneState(
    input: Omit<OutlinePanePublicationSnapshot, "sessionId">
  ): void;
  publishOutlineInteractionEpoch(input: {
    readonly paneId: string;
    readonly interactionEpoch: number;
  }): void;
  publishOutlineDragState(input: {
    readonly paneId: string;
    readonly activeDrag: boolean;
  }): void;
  unregisterOutlinePane(paneId: string): void;
  writeAuthority(): NotesWriteAuthority;
  retryAuthorityRecovery(): Promise<boolean>;
  close(): void;
  ownerToken(): number;
  isCurrentOwner(token: number): boolean;
  reserveAdmittedNavigation(
    before?: NotesHistorySnapshot,
    originPaneId?: NotesPaneId
  ): NotesNavigationPresentationLease;
  settleAuthoritativePresentation(
    workspace: PresentationWorkspace,
    snapshot: NotesHistorySnapshot,
    options?: { readonly applyToCurrentOwner?: boolean }
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
  keyboardInsertions: ReturnType<typeof createKeyboardInsertionRegistry>;
  optimisticKeyboardInsertions: Map<NoteId, OptimisticKeyboardInsertion>;
  optimisticInsertionFailure: OptimisticInsertionFailure | null;
  projectionGeneration: number;
  publicationOwners: Array<{
    readonly projectionGeneration: number;
    readonly owner: NotesProjectionPublicationOwner;
  }>;
  nextFrontendSessionGeneration: number;
  reservedHistoryEntryIds: string[];
  writeAuthority: NotesWriteAuthority;
  authorityRecoveryGeneration: number;
  authorityRecovery: Promise<NotesUnknownOutcomeDecision> | null;
  unknownOutcomeExpectation: NotesUnknownOutcomeExpectation | null;
  nextBackspaceGestureToken: number;
  backspaceGesture: BackspaceGestureState | null;
  lifecycleDrain: {
    readonly owner: SessionState;
    readonly completion: Promise<boolean>;
    settled: boolean;
  } | null;
}

interface BackspaceGestureState {
  snapshot: OptimisticBackspaceGesture;
  readonly owner: SessionState;
  readonly historyContext: NotesHistoryContext;
  readonly draftLease: NotesBackspaceDraftLease;
  readonly work: NotesBackspaceGestureQueueWork;
  afterSnapshot: NotesHistorySnapshot | null;
  draftCommit: NotesBackspaceDraftCommit | null;
  finishing: Promise<NotesWorkspaceCommandOutcome> | null;
  resolveFinishing: ((outcome: NotesWorkspaceCommandOutcome) => void) | null;
}

interface OutlinePaneState {
  snapshot: OutlinePanePublicationSnapshot;
  layoutGeneration: number;
  dragGeneration: number;
}

interface PendingCoordinatorGeneration {
  entry: CoordinatorEntry;
}

interface NavigationLeaseState {
  readonly entry: CoordinatorEntry;
  readonly originPaneId: NotesPaneId;
  before: NotesHistorySnapshot;
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
  captureDraftCutoff:
    | ((publicationOwner: NotesProjectionPublicationOwner) => number)
    | null;
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
  readonly frontendSessionId: string;
  readonly frontendSessionGeneration: number;
  readonly outlinePanes: Map<string, OutlinePaneState>;
  readonly preparedKeyboardInsertions: Map<
    NoteId,
    NotesKeyboardInsertionPreparation
  >;
  coordinatorSession: NotesWorkspaceCoordinatorSession | null;
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
  settleFailure: ((error: string) => void) | null;
  keyboardInsertion: NotesKeyboardInsertionPreparation | null;
  keyboardInsertionInvalidated: boolean;
  publicationOwner: NotesProjectionPublicationOwner;
  unknownOutcomeExpectation: NotesUnknownOutcomeExpectation | null;
}

type QueueItem = ActivationItem | CommandItem;

function errorMessage(cause: unknown): string {
  return parseNotesError(cause).message;
}

function settleFailureSafely(
  settleFailure: ((error: string) => void) | null | undefined,
  error: string
): void {
  try {
    settleFailure?.(error);
  } catch {
    // Caller-owned feedback cannot be allowed to strand the queue.
  }
}

function snapshotWorkspaceScope(
  scope: NotesWorkspaceScope
): NotesWorkspaceScope {
  return scope.kind === "tags"
    ? { kind: "tags", tags: canonicalizeTagFilters(scope.tags) }
    : { ...scope };
}

function clonePaneSnapshot(
  sessionId: string,
  input: Omit<OutlinePanePublicationSnapshot, "sessionId">
): OutlinePanePublicationSnapshot {
  return {
    ...input,
    sessionId,
    scope: snapshotWorkspaceScope(input.scope),
    collapsedNodeIds: new Set(input.collapsedNodeIds),
    locallyExpandedNodeIds: new Set(input.locallyExpandedNodeIds)
  };
}

function hideCompletedOutlineRows(
  rows: readonly FlattenedOutlineRow[],
  workspace: PresentationWorkspace,
  zoomedNodeId: NoteId | null
): FlattenedOutlineRow[] {
  let hiddenDepth: number | null = null;
  return rows.filter((row) => {
    if (hiddenDepth !== null) {
      if (row.depth > hiddenDepth) return false;
      hiddenDepth = null;
    }
    const node = workspace.nodesById[row.id];
    if (!node || node.completedAt === null) return true;
    hiddenDepth = row.depth;
    return row.id === zoomedNodeId;
  });
}

function projectPaneRows(
  workspace: PresentationWorkspace,
  pane: OutlinePanePublicationSnapshot,
  prospectiveExpandedNodeId?: NoteId
): {
  readonly rows: readonly FlattenedOutlineRow[];
  readonly locallyExpandedNodeIds: ReadonlySet<NoteId>;
} {
  const zoomedNodeId =
    pane.zoomedNodeId !== null && workspace.nodesById[pane.zoomedNodeId]
      ? pane.zoomedNodeId
      : null;
  const locallyExpandedNodeIds = new Set(pane.locallyExpandedNodeIds);
  if (prospectiveExpandedNodeId) {
    locallyExpandedNodeIds.add(prospectiveExpandedNodeId);
  }
  const rows = flattenVisibleOutlineRows(
    workspace,
    zoomedNodeId,
    locallyExpandedNodeIds
  );
  return {
    rows: pane.showCompleted
      ? rows
      : hideCompletedOutlineRows(rows, workspace, zoomedNodeId),
    locallyExpandedNodeIds
  };
}

function insertionPostconditionMatches(
  pending: PendingKeyboardInsertion,
  workspace: PresentationWorkspace
): boolean {
  const expected = workspace.nodesById[pending.intent.expectedNodeId];
  const source = workspace.nodesById[pending.intent.sourceId];
  if (!expected || !source) return false;
  const postcondition = pending.intent.postcondition;
  if (postcondition.kind === "first-child") {
    return (
      expected.parentId === postcondition.expectedParentId &&
      workspace.childIdsByParent[postcondition.expectedParentId]?.[
        postcondition.expectedIndex
      ] === expected.id &&
      expected.title === postcondition.expectedInsertedTitle
    );
  }
  const siblings =
    expected.parentId === null
      ? workspace.rootIds
      : workspace.childIdsByParent[expected.parentId] ?? [];
  const sourceIndex = siblings.indexOf(source.id);
  return (
    source.parentId === expected.parentId &&
    sourceIndex >= 0 &&
    siblings[sourceIndex + 1] === expected.id &&
    source.title === postcondition.expectedSourceTitle &&
    expected.title === postcondition.expectedInsertedTitle
  );
}

function insertionHistoryMatches(
  pending: PendingKeyboardInsertion,
  result: Extract<NotesWorkspaceQueueResult, { kind: "authoritative" }>
): boolean {
  const expectedEntryId = pending.expectedStructuralHistoryEntryId;
  return (
    (result.historyStatus?.historyEpoch ===
        pending.expectedStructuralHistoryEpoch &&
      result.historyStatus.nextUndoEntryId === expectedEntryId) ||
    result.nonAtomicHistoryEntryIds?.includes(expectedEntryId) === true
  );
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
const AUTHORITY_RECOVERY_INSTRUCTION =
  "Notes write authority is unknown. Retry recovery to continue editing.";
const MAX_PENDING_HISTORY_CLEANUP_IDS = 100;

function retainHistorySnapshot(snapshot: NotesHistorySnapshot): void {
  const revisions = [
    snapshot.expansion,
    ...(snapshot.secondaryPane ? [snapshot.secondaryPane.expansion] : []),
    ...(snapshot.tagFilterOrigin ? [snapshot.tagFilterOrigin.expansion] : [])
  ];
  for (const revision of revisions) {
    // Revisions carry their originating pool record, so the shared pool can
    // retain snapshots captured by another presentation-owned pool.
    notesExpansionSnapshotPool.retain(revision);
  }
}

function releaseHistorySnapshot(snapshot: NotesHistorySnapshot): void {
  const revisions = [
    snapshot.expansion,
    ...(snapshot.secondaryPane ? [snapshot.secondaryPane.expansion] : []),
    ...(snapshot.tagFilterOrigin ? [snapshot.tagFilterOrigin.expansion] : [])
  ];
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

  const notifyOptimisticInsertion = (
    entry: CoordinatorEntry,
    insertion: OptimisticKeyboardInsertion,
    rollback?: {
      readonly ownerPaneId: string;
      readonly sourceId: NoteId;
      readonly selection: NotesHistoryPrimarySelection;
    }
  ): void => {
    const owner = [...entry.sessions].find(
      (session) =>
        session.frontendSessionId === insertion.pending.ownerSessionId
    );
    if (!owner) return;
    notify(owner, {
      type: "optimisticInsertion",
      snapshot: {
        insertions: [...entry.optimisticKeyboardInsertions.values()].filter(
          (candidate) =>
            candidate.pending.ownerSessionId ===
            insertion.pending.ownerSessionId
        ),
        failure:
          entry.optimisticInsertionFailure?.insertion.pending.ownerSessionId ===
          insertion.pending.ownerSessionId
            ? entry.optimisticInsertionFailure
            : null
      },
      ...(rollback ? { rollback } : {})
    });
  };

  const notifyOptimisticBackspaceGesture = (
    state: BackspaceGestureState,
    rollback = false
  ): void => {
    const entry = state.owner.entry;
    const currentOwner =
      entry.owner?.active === true && entry.owner.isCurrent?.() !== false
        ? entry.owner
        : null;
    const recipient =
      state.owner.active && state.owner.isCurrent?.() !== false
        ? state.owner
        : currentOwner ??
          [...entry.sessions].find(
            (candidate) =>
              candidate.active && candidate.isCurrent?.() !== false
          ) ??
          state.owner;
    notify(recipient, {
      type: "optimisticBackspaceGesture",
      snapshot: entry.backspaceGesture === state
        ? state.snapshot
        : null,
      ...(rollback
        ? {
            rollback: {
              ownerPaneId: state.snapshot.ownerPaneId,
              nodeId: state.snapshot.startingNodeId,
              selection: { ...state.snapshot.startingSelection }
            }
          }
        : {})
    });
  };

  const updateOptimisticBackspaceGesture = (
    state: BackspaceGestureState,
    snapshot: OptimisticBackspaceGesture
  ): void => {
    if (state.owner.entry.backspaceGesture !== state) return;
    state.snapshot = snapshot;
    notifyOptimisticBackspaceGesture(state);
  };

  const clearOptimisticBackspaceGesture = (
    state: BackspaceGestureState,
    rollback = false,
    outcome?: NotesWorkspaceCommandOutcome
  ): void => {
    if (state.owner.entry.backspaceGesture !== state) return;
    state.owner.entry.backspaceGesture = null;
    notifyOptimisticBackspaceGesture(state, rollback);
    if (outcome) {
      const resolve = state.resolveFinishing;
      state.resolveFinishing = null;
      resolve?.(outcome);
    }
    maybeDeleteEntry(state.owner.entry);
  };

  const setOptimisticInsertionStatus = (
    entry: CoordinatorEntry,
    expectedNodeId: NoteId,
    status: OptimisticKeyboardInsertionStatus
  ): void => {
    const current = entry.optimisticKeyboardInsertions.get(expectedNodeId);
    if (!current || current.status === status) return;
    const insertion = { ...current, status };
    entry.optimisticKeyboardInsertions.set(expectedNodeId, insertion);
    notifyOptimisticInsertion(entry, insertion);
  };

  const removeOptimisticInsertion = (
    entry: CoordinatorEntry,
    expectedNodeId: NoteId,
    rollback?: {
      readonly ownerPaneId: string;
      readonly sourceId: NoteId;
      readonly selection: NotesHistoryPrimarySelection;
    }
  ): void => {
    const insertion =
      entry.optimisticKeyboardInsertions.get(expectedNodeId);
    if (!insertion) return;
    entry.optimisticKeyboardInsertions.delete(expectedNodeId);
    notifyOptimisticInsertion(entry, insertion, rollback);
  };

  const cancelKeyboardInsertion = (
    entry: CoordinatorEntry,
    preparation: NotesKeyboardInsertionPreparation
  ): void => {
    const cancelled = entry.keyboardInsertions.cancel(
      preparation.pending.intent.expectedNodeId,
      preparation.pending.intent.token
    );
    if (cancelled) {
      removeOptimisticInsertion(
        entry,
        preparation.pending.intent.expectedNodeId
      );
      for (const session of entry.sessions) {
        session.preparedKeyboardInsertions.delete(
          preparation.pending.intent.expectedNodeId
        );
      }
      entry.history.discard(preparation.historyContext.entryId);
    }
  };

  const isKeyboardInsertionCurrent = (
    entry: CoordinatorEntry,
    preparation: NotesKeyboardInsertionPreparation
  ): boolean => {
    const pending = preparation.pending;
    if (
      entry.keyboardInsertions.get(pending.intent.expectedNodeId) !== pending
    ) {
      return false;
    }
    for (const session of entry.sessions) {
      if (session.frontendSessionId !== pending.ownerSessionId) continue;
      return (
        session.preparedKeyboardInsertions.get(
          pending.intent.expectedNodeId
        ) === preparation &&
        session.outlinePanes.has(pending.ownerPaneId)
      );
    }
    return false;
  };

  const acceptProjectionPublications = async (
    entry: CoordinatorEntry,
    item: CommandItem,
    result: Extract<NotesWorkspaceQueueResult, { kind: "authoritative" }>
  ): Promise<{
    publications: Map<SessionState, NotesProjectionPublication>;
    insertionFocusCanceled: boolean;
  }> => {
    const resultScope = snapshotWorkspaceScope(
      result.projectionScope ?? item.sourceScope
    );
    const workspaceByScope = new Map<string, NotesWorkspace>([
      [scopeKey(resultScope), result.workspace]
    ]);
    while (true) {
      const missingScopes = new Map<string, NotesWorkspaceScope>();
      for (const session of entry.sessions) {
        for (const paneState of session.outlinePanes.values()) {
          const acceptedScope =
            session === item.owner && result.projectionScope
              ? resultScope
              : paneState.snapshot.scope;
          const key = scopeKey(acceptedScope);
          if (!workspaceByScope.has(key)) {
            missingScopes.set(key, acceptedScope);
          }
        }
      }
      if (missingScopes.size === 0) break;
      const loaded = await Promise.all(
        [...missingScopes].map(async ([key, scope]) => [
          key,
          await entry.repository.loadWorkspace(entry.vaultRoot, scope)
        ] as const)
      );
      for (const [key, workspace] of loaded) {
        workspaceByScope.set(key, workspace);
      }
    }

    const requestedPreparation = item.keyboardInsertion;
    const preparation =
      requestedPreparation &&
      isKeyboardInsertionCurrent(entry, requestedPreparation)
        ? requestedPreparation
        : null;
    const pending = preparation?.pending ?? null;
    const insertionFocusCanceled =
      item.keyboardInsertionInvalidated ||
      (requestedPreparation !== null && preparation === null);
    const owner: NotesProjectionPublicationOwner = pending
      ? {
          kind: "keyboard-insertion",
          intentToken: pending.intent.token
        }
      : item.publicationOwner;
    const projectionGeneration = entry.projectionGeneration + 1;
    const publicationOwners = [
      ...entry.publicationOwners,
      { projectionGeneration, owner }
    ].slice(-256);
    const publications = new Map<SessionState, NotesProjectionPublication>();
    const stagedPanes = [];
    for (const session of entry.sessions) {
      for (const [paneId, paneState] of session.outlinePanes) {
        const isOriginPane =
          pending !== null &&
          pending.ownerSessionId === session.frontendSessionId &&
          pending.ownerPaneId === paneId;
        const prospectiveExpandedNodeId =
          isOriginPane &&
          pending.intent.postcondition.kind === "first-child"
            ? pending.intent.postcondition.expectedParentId
            : undefined;
        const acceptedScope =
          session === item.owner && result.projectionScope
            ? resultScope
            : paneState.snapshot.scope;
        const paneWorkspace = workspaceByScope.get(scopeKey(acceptedScope))!;
        const normalized = normalizeWorkspace(paneWorkspace);
        const acceptedPaneSnapshot = {
          ...paneState.snapshot,
          scope: acceptedScope,
          locallyExpandedNodeIds:
            session === item.owner &&
            result.projectionLocallyExpandedNodeIds
              ? result.projectionLocallyExpandedNodeIds
              : paneState.snapshot.locallyExpandedNodeIds
        };
        const projected = projectPaneRows(
          normalized,
          acceptedPaneSnapshot,
          prospectiveExpandedNodeId
        );
        const visibleSignature = createOutlineVisibleSignature(projected.rows);
        const layoutChanged =
          visibleSignature !== paneState.snapshot.visibleSignature;
        const acceptedLayoutGeneration =
          paneState.layoutGeneration + (layoutChanged ? 1 : 0);
        const acceptedPane = {
          ...acceptedPaneSnapshot,
          locallyExpandedNodeIds: projected.locallyExpandedNodeIds,
          visibleSignature
        };
        let keyboardInsertionDisposition;

        if (isOriginPane && pending && preparation) {
          const historyMatches = insertionHistoryMatches(pending, result);
          const postconditionMatches = insertionPostconditionMatches(
            pending,
            normalized
          );
          const expectedNodeExists =
            normalized.nodesById[pending.intent.expectedNodeId] !== undefined;
          const authorityOutcome = historyMatches
            ? postconditionMatches
              ? "postconditionAccepted"
              : expectedNodeExists
                ? "ownedButSuperseded"
                : "mismatch"
            : "mismatch";
          const settlement = {
            intentToken: pending.intent.token,
            expectedNodeId: pending.intent.expectedNodeId,
            ownerSessionId: pending.ownerSessionId,
            ownerPaneId: pending.ownerPaneId,
            ownerSessionGeneration: pending.intent.ownerSessionGeneration,
            interactionEpochAtDispatch: pending.interactionEpochAtDispatch,
            baseProjectionGeneration: pending.projectionGenerationAtDispatch,
            acceptedProjectionGeneration: projectionGeneration,
            baseLayoutGeneration: pending.layoutGenerationAtDispatch,
            acceptedLayoutGeneration,
            authorityOutcome,
            focusEligible:
              authorityOutcome === "postconditionAccepted" &&
              result.uiUpdate?.pendingFocusId ===
                pending.intent.expectedNodeId
          } as const;
          keyboardInsertionDisposition =
            classifyKeyboardInsertionPublication({
              pending,
              settlement,
              previousPane: pending.paneSnapshotAtDispatch,
              acceptedPane,
              acceptedVisibleRows: projected.rows,
              acceptedDragGeneration: paneState.dragGeneration,
              publicationOwners: publicationOwners
                .filter(
                  (publication) =>
                    publication.projectionGeneration >
                      pending.projectionGenerationAtDispatch &&
                    publication.projectionGeneration <= projectionGeneration
                )
                .map((publication) => publication.owner)
            });
        }

        const publication = {
          projectionGeneration,
          layoutGeneration: acceptedLayoutGeneration,
          owner,
          visibleSignature,
          locallyExpandedNodeIds: projected.locallyExpandedNodeIds,
          ...(keyboardInsertionDisposition
            ? { keyboardInsertionDisposition }
            : {})
        };
        stagedPanes.push({
          session,
          paneState,
          acceptedLayoutGeneration,
          acceptedPane,
          publication
        });
        const currentPublication = publications.get(session);
        if (
          keyboardInsertionDisposition ||
          !currentPublication?.keyboardInsertionDisposition
        ) {
          publications.set(session, publication);
        }
      }
    }

    entry.projectionGeneration = projectionGeneration;
    entry.publicationOwners = publicationOwners;
    for (const staged of stagedPanes) {
      staged.paneState.layoutGeneration = staged.acceptedLayoutGeneration;
      staged.paneState.snapshot = staged.acceptedPane;
    }
    if (preparation && pending) {
      entry.keyboardInsertions.consume(
        pending.intent.expectedNodeId,
        pending.intent.token
      );
      for (const session of entry.sessions) {
        if (session.frontendSessionId === pending.ownerSessionId) {
          session.preparedKeyboardInsertions.delete(
            pending.intent.expectedNodeId
          );
          break;
        }
      }
    }
    return { publications, insertionFocusCanceled };
  };

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
      entry.authorityRecovery !== null ||
      entry.backspaceGesture !== null ||
      entry.lifecycleDrain !== null ||
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

  const setWriteAuthority = (
    entry: CoordinatorEntry,
    authority: NotesWriteAuthority
  ): void => {
    entry.writeAuthority = authority;
    for (const session of entry.sessions) {
      notify(session, { type: "authorityRecovery", authority });
    }
  };

  const recoverHistoryMismatchForEntry = (
    entry: CoordinatorEntry,
    preferredSession: SessionState | null,
    reload: () => Promise<{
      workspace: PresentationWorkspace;
      snapshot: NotesHistorySnapshot;
    }>
  ): Promise<{
    workspace: PresentationWorkspace;
    snapshot: NotesHistorySnapshot;
  } | null> => {
    if (entry.historyRecovery) return entry.historyRecovery;
    entry.historyBlocked = true;
    const recovery = (async () => {
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
        notifyReopenInstruction(entry, preferredSession);
        return null;
      } finally {
        entry.historyRecovery = null;
        maybeDeleteEntry(entry);
      }
    })();
    entry.historyRecovery = recovery;
    return recovery;
  };

  const recoverUnknownOutcomeForEntry = (
    entry: CoordinatorEntry,
    expectation: NotesUnknownOutcomeExpectation,
    preferredSession: SessionState | null
  ): Promise<NotesUnknownOutcomeDecision> => {
    if (entry.authorityRecovery) return entry.authorityRecovery;
    entry.unknownOutcomeExpectation = expectation;
    const generation = ++entry.authorityRecoveryGeneration;
    setWriteAuthority(entry, { kind: "recovering", generation });
    const recovery = (async (): Promise<NotesUnknownOutcomeDecision> => {
      let workspace;
      try {
        workspace = normalizeNotesWorkspace(
          await entry.repository.loadWorkspace(entry.vaultRoot, {
            kind: "active"
          })
        );
        if (!workspace) {
          throw new Error("Notes authority reload returned an invalid workspace.");
        }
      } catch (error) {
        const decision = recoverUnknownOutcome({
          expectation,
          authority: { kind: "failed", error }
        });
        if (decision.kind !== "authorityUnknown") {
          throw new Error("Notes authority recovery classification failed.");
        }
        setWriteAuthority(entry, {
          kind: "unknown",
          error: decision.error
        });
        return decision;
      }
      let historyStatus: NotesHistoryStatus | undefined;
      if (entry.repository.historyStatus) {
        try {
          const status = await entry.repository.historyStatus(
            entry.vaultRoot,
            expectation.historyContext.sessionId
          );
          if (isNotesHistoryState(status)) historyStatus = status;
        } catch {
          // Workspace authority can still be adopted without history proof.
        }
      }
      const unclassifiedHistoryProven =
        expectation.kind === "unclassified" &&
        expectation.historyContext.entryId.length > 0 &&
        historyStatus?.historyEpoch ===
          expectation.historyContext.historyEpoch &&
        historyStatus.canUndo &&
        !historyStatus.canRedo &&
        historyStatus.nextUndoEntryId === expectation.historyContext.entryId &&
        historyStatus.nextRedoEntryId === null;
      const provenHistoryStatus = unclassifiedHistoryProven
        ? historyStatus
        : undefined;
      let decision: NotesUnknownOutcomeDecision =
        expectation.kind === "unclassified" &&
        expectation.mutationCommitted === true &&
        !provenHistoryStatus
          ? {
              kind: "authorityUnknown",
              error: AUTHORITY_RECOVERY_INSTRUCTION
            }
          : provenHistoryStatus
            ? {
                kind: "committedAndCurrent",
                workspace,
                historyStatus: provenHistoryStatus
              }
            : recoverUnknownOutcome({
                expectation,
                authority: {
                  kind: "loaded",
                  workspace,
                  ...(historyStatus ? { historyStatus } : {})
                }
              });
      if (decision.kind === "committedWithoutHistoryProof") {
        const recoveredWorkspace = decision.workspace;
        const snapshot = preferredSession?.captureHistoryLocation?.() ?? null;
        const recovered = snapshot
          ? await recoverHistoryMismatchForEntry(
              entry,
              preferredSession,
              async () => ({
                workspace: normalizeWorkspace(recoveredWorkspace),
                snapshot
              })
            )
          : null;
        if (!recovered) {
          decision = {
            kind: "authorityUnknown",
            error: AUTHORITY_RECOVERY_INSTRUCTION
          };
        }
      }
      if (decision.kind === "authorityUnknown") {
        setWriteAuthority(entry, {
          kind: "unknown",
          error: decision.error
        });
      } else {
        if (decision.kind === "committedAndCurrent") {
          entry.historyStatus = decision.historyStatus;
        }
        setWriteAuthority(entry, { kind: "known" });
      }
      return decision;
    })().finally(() => {
      entry.authorityRecovery = null;
      maybeDeleteEntry(entry);
    });
    entry.authorityRecovery = recovery;
    return recovery;
  };

  const unknownOutcomeExpectation = (
    item: CommandItem
  ): NotesUnknownOutcomeExpectation => {
    if (item.unknownOutcomeExpectation) {
      return item.unknownOutcomeExpectation;
    }
    const preparation = item.keyboardInsertion;
    if (preparation) {
      return {
        kind: "structural",
        sourceId: preparation.pending.intent.sourceId,
        expectedNodeId: preparation.pending.intent.expectedNodeId,
        postcondition: preparation.pending.intent.postcondition,
        historyContext: preparation.historyContext
      };
    }
    return {
      kind: "unclassified",
      historyContext: {
        sessionId: item.entry.history.sessionId,
        historyEpoch: item.entry.history.historyEpoch,
        entryId: "",
        commandKind: "unknown"
      }
    };
  };

  const recoveredQueueResult = async (
    item: CommandItem
  ): Promise<NotesWorkspaceQueueSettlement> => {
    const expectation = unknownOutcomeExpectation(item);
    const decision = await recoverUnknownOutcomeForEntry(
      item.entry,
      expectation,
      item.owner
    );
    if (decision.kind === "authorityUnknown") {
      item.keyboardInsertionInvalidated = true;
      return { kind: "failure", error: decision.error };
    }
    const historyStatus =
      decision.kind === "committedAndCurrent"
        ? decision.historyStatus
        : item.entry.historyStatus;
    if (expectation.kind === "draft") {
      return {
        kind: "failure",
        error: "The draft outcome was recovered and requires manual retry.",
        workspace: decision.workspace,
        historyStatus
      };
    }
    if (decision.kind === "notProvenCommitted") {
      item.keyboardInsertionInvalidated = true;
      return {
        kind: "failure",
        error: "The mutation could not be proven committed.",
        workspace: decision.workspace,
        historyStatus
      };
    }
    const historyProven = decision.kind === "committedAndCurrent";
    if (!historyProven) item.keyboardInsertionInvalidated = true;
    const expectedNodeId =
      expectation.kind === "structural" ? expectation.expectedNodeId : null;
    return {
      kind: "authoritative",
      workspace: decision.workspace,
      historyStatus,
      scopeAgnostic: true,
      ...(historyProven
        ? {
            committedHistoryEntryIds: [expectation.historyContext.entryId],
            ...(expectedNodeId
              ? {
                  uiUpdate: {
                    selectedId: expectedNodeId,
                    editingNoteId: expectedNodeId,
                    pendingFocusId: expectedNodeId,
                    pendingFocusField: "title"
                  }
                }
              : {
                  uiUpdate: {
                    pendingFocusId: null,
                    pendingFocusField: null
                  }
                })
          }
        : {
            uiUpdate: {
              pendingFocusId: null,
              pendingFocusField: null
            }
          })
    };
  };

  const publishManualAuthorityRecovery = (
    entry: CoordinatorEntry,
    decision: Exclude<
      NotesUnknownOutcomeDecision,
      { readonly kind: "authorityUnknown" }
    >
  ): void => {
    let recoveredDecision = decision;
    const backspace = entry.backspaceGesture;
    if (
      backspace?.snapshot.status === "checking" &&
      backspace.draftCommit !== null
    ) {
      if (
        recoveredDecision.kind === "committedAndCurrent" &&
        backspace.afterSnapshot
      ) {
        const accepted = entry.history.acceptMutationResult(
          backspace.historyContext.entryId,
          backspace.afterSnapshot,
          recoveredDecision.historyStatus
        );
        if (accepted.accepted) {
          for (const entryId of accepted.unreachableEntryIds) {
            entry.pendingHistoryCleanupIds.add(entryId);
          }
          replaceAuthoritativePresentation(
            entry,
            normalizeWorkspace(recoveredDecision.workspace),
            backspace.afterSnapshot,
            false,
            false
          );
          backspace.afterSnapshot = null;
          backspace.draftLease.settle("committed");
          clearOptimisticBackspaceGesture(backspace, false, "committed");
        } else {
          releaseHistorySnapshot(backspace.afterSnapshot);
          backspace.afterSnapshot = null;
          recoveredDecision = {
            kind: "notProvenCommitted",
            workspace: recoveredDecision.workspace,
            historyStatus: recoveredDecision.historyStatus
          };
        }
      } else if (recoveredDecision.kind === "committedAndCurrent") {
        recoveredDecision = {
          kind: "notProvenCommitted",
          workspace: recoveredDecision.workspace,
          historyStatus: recoveredDecision.historyStatus
        };
      }
      if (
        recoveredDecision.kind !== "committedAndCurrent" &&
        entry.backspaceGesture === backspace
      ) {
        if (backspace.afterSnapshot) {
          releaseHistorySnapshot(backspace.afterSnapshot);
          backspace.afterSnapshot = null;
        }
        entry.history.discard(backspace.historyContext.entryId);
        backspace.draftLease.settle("failed");
        clearOptimisticBackspaceGesture(backspace, true, "failed");
      }
    }
    const historyStatus =
      recoveredDecision.kind === "committedAndCurrent"
        ? recoveredDecision.historyStatus
        : entry.historyStatus;
    entry.confirmedWorkspace = recoveredDecision.workspace;
    entry.historyStatus = historyStatus;
    entry.historyVersion += 1;
    const result: NotesWorkspaceQueueSettlement =
      recoveredDecision.kind === "notProvenCommitted"
        ? {
            kind: "failure",
            error: "The mutation could not be proven committed.",
            workspace: recoveredDecision.workspace,
            historyStatus,
            historyVersion: entry.historyVersion,
            uiUpdate: { pendingFocusId: null, pendingFocusField: null },
            scopeAgnostic: true
          }
        : {
            kind: "authoritative",
            workspace: recoveredDecision.workspace,
            historyStatus,
            historyVersion: entry.historyVersion,
            uiUpdate: { pendingFocusId: null, pendingFocusField: null },
            scopeAgnostic: true
          };
    for (const candidate of entry.sessions) {
      candidate.confirmedWorkspace = recoveredDecision.workspace;
      notify(candidate, {
        type: candidate === entry.owner ? "settled" : "synchronized",
        result,
        hasPendingWork: candidate.pendingWork > 0,
        ...(candidate === entry.owner
          ? {}
          : { sourceScope: { kind: "active" } })
      } as NotesWorkspaceCoordinatorEvent);
    }
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
      if (item.keyboardInsertion) {
        cancelKeyboardInsertion(item.entry, item.keyboardInsertion);
        item.keyboardInsertion = null;
      }
      item.owner = null;
      item.work = null;
      item.settleFailure = null;
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

  const settleItem = async (
    item: QueueItem,
    result: NotesWorkspaceQueueSettlement
  ): Promise<void> => {
    const entry = item.entry;
    if (entry.running !== item) {
      return;
    }
    if (item.kind === "activation") {
      entry.running = null;
    }
    const authoritativeWorkspace =
      result.kind === "authoritative"
        ? result.workspace
        : result.kind === "failure"
          ? result.workspace
          : undefined;
    if (authoritativeWorkspace && item.kind === "activation") {
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
          ? {
              ...result,
              workspace: presentationWorkspace,
              ...(presentation?.snapshot.libraryView === "tags"
                ? { invalidatesTagSummaries: true }
                : {})
            }
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
      const acceptedProjection =
        result.kind === "authoritative"
          ? await acceptProjectionPublications(entry, item, result)
          : {
              publications:
                new Map<SessionState, NotesProjectionPublication>(),
              insertionFocusCanceled: item.keyboardInsertionInvalidated
            };
      if (entry.running !== item) return;
      entry.running = null;
      if (authoritativeWorkspace) {
        entry.confirmedWorkspace = authoritativeWorkspace;
      }
      const projectionPublications = acceptedProjection.publications;
      const insertionFocusCanceled =
        acceptedProjection.insertionFocusCanceled ||
        item.keyboardInsertionInvalidated;
      const ownerPublication = owner
        ? projectionPublications.get(owner)
        : undefined;
      const insertionDisposition =
        ownerPublication?.keyboardInsertionDisposition;
      const insertionFocusAcknowledged =
        item.keyboardInsertion !== null &&
        entry.optimisticKeyboardInsertions.get(
          item.keyboardInsertion.pending.intent.expectedNodeId
        )?.focusAcknowledged === true;
      const focusEligible =
        !insertionFocusAcknowledged &&
        !insertionFocusCanceled &&
        (insertionDisposition?.kind === "exact" ||
        insertionDisposition?.kind === "mixed"
          ? insertionDisposition.settlement.focusEligible
          : !insertionDisposition);
      const ownerResult =
        (ownerPublication || insertionFocusCanceled) &&
        result.kind !== "skipped"
          ? {
              ...result,
              ...(focusEligible
                ? {}
                : {
                    uiUpdate: {
                      ...result.uiUpdate,
                      pendingFocusId: null,
                      pendingFocusField: null
                    }
                  }),
              ...(ownerPublication
                ? { projectionPublication: ownerPublication }
                : {})
            }
          : result;
      if (item.keyboardInsertion) {
        const expectedNodeId =
          item.keyboardInsertion.pending.intent.expectedNodeId;
        const optimistic =
          entry.optimisticKeyboardInsertions.get(expectedNodeId);
        if (optimistic && ownerResult.kind === "failure") {
          entry.optimisticInsertionFailure = {
            insertion: optimistic,
            message: `The new bullet could not be saved: ${ownerResult.error}. The last bullet action was reverted.`,
            recoveryText: optimisticInsertionRecoveryText(optimistic),
            retryable: false
          };
          removeOptimisticInsertion(entry, expectedNodeId, {
            ownerPaneId: optimistic.pending.ownerPaneId,
            sourceId: optimistic.pending.intent.sourceId,
            selection: optimistic.checkpoint.sourceSelection
          });
        } else {
          removeOptimisticInsertion(entry, expectedNodeId);
        }
        cancelKeyboardInsertion(entry, item.keyboardInsertion);
        item.keyboardInsertion = null;
      }
      item.work = null;
      item.settleFailure = null;
      if (owner && authoritativeWorkspace) {
        owner.confirmedWorkspace = authoritativeWorkspace;
      }
      if (owner?.active) {
        if (!item.silent) {
          owner.pendingWork = Math.max(0, owner.pendingWork - 1);
        }
        notify(owner, {
          type: "settled",
          result: ownerResult,
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
              : {}),
            ...(result.tagSummaries !== undefined
              ? { tagSummaries: result.tagSummaries }
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
            const sessionPublication = projectionPublications.get(session);
            const sessionResult: NotesWorkspaceQueueSettlement =
              sessionPublication &&
              synchronizedResult.kind !== "skipped"
                ? {
                    ...synchronizedResult,
                    projectionPublication: sessionPublication
                  }
                : synchronizedResult;
            if (
              sourceScope !== null &&
              session.getScope &&
              scopeKey(session.getScope()) === scopeKey(sourceScope)
            ) {
              session.confirmedWorkspace = authoritativeWorkspace;
            }
            notify(session, {
              type: "synchronized",
              result: sessionResult,
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
        } else if (item.entry.writeAuthority.kind !== "known") {
          result = { kind: "failure", error: AUTHORITY_RECOVERY_INSTRUCTION };
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
      if (item.kind === "command" && isNotesMutationOutcomeUnknown(cause)) {
        if (
          cause.mutationCommitted === true &&
          item.unknownOutcomeExpectation?.kind === "unclassified"
        ) {
          item.unknownOutcomeExpectation = {
            ...item.unknownOutcomeExpectation,
            mutationCommitted: true
          };
        }
        result = await recoveredQueueResult(item);
      } else {
        result = { kind: "failure", error: errorMessage(cause) };
      }
    }
    if (
      item.kind === "command" &&
      result.kind === "failure" &&
      item.settleFailure
    ) {
      const settleFailure = item.settleFailure;
      item.settleFailure = null;
      settleFailureSafely(settleFailure, result.error);
      result = { kind: "skipped" };
    }
    try {
      await settleItem(item, result);
    } catch (cause) {
      const projectionFailure: NotesWorkspaceQueueSettlement =
        result.kind === "authoritative"
          ? {
              kind: "failure",
              error: errorMessage(cause),
              workspace: result.workspace,
              historyStatus: result.historyStatus,
              historyVersion: result.historyVersion,
              committedHistoryEntryIds: result.committedHistoryEntryIds
            }
          : { kind: "failure", error: errorMessage(cause) };
      await settleItem(item, projectionFailure);
    }
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

      if (item.kind === "command" && item.keyboardInsertion) {
        const optimistic = entry.optimisticKeyboardInsertions.get(
          item.keyboardInsertion.pending.intent.expectedNodeId
        );
        if (
          optimistic?.dependencyId &&
          !entry.confirmedWorkspace.nodes.some(
            (node) => node.id === optimistic.dependencyId
          )
        ) {
          cancelItem(item);
          continue;
        }
      }
      entry.running = item;
      if (item.kind === "command" && item.keyboardInsertion) {
        setOptimisticInsertionStatus(
          entry,
          item.keyboardInsertion.pending.intent.expectedNodeId,
          "running"
        );
      }
      void executeItem(item);
      return;
    }

    maybeDeleteEntry(entry);
  }

  const createEntry = (
    repository: NotesStore,
    vaultRoot: string,
    installed: boolean
  ): CoordinatorEntry => {
    const reservedHistoryEntryIds: string[] = [];
    return {
      repository,
      vaultRoot,
      confirmedWorkspace: { nodes: [] },
      history: createNotesHistorySession({
        createId:
          typeof repository.undo === "function" &&
          typeof repository.redo === "function"
            ? () =>
                reservedHistoryEntryIds.shift() ??
                globalThis.crypto.randomUUID()
            : () => LEGACY_HISTORY_SESSION_ID
      }),
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
    leases: new Set(),
    keyboardInsertions: createKeyboardInsertionRegistry(),
    optimisticKeyboardInsertions: new Map(),
    optimisticInsertionFailure: null,
    projectionGeneration: 0,
    publicationOwners: [],
      nextFrontendSessionGeneration: 0,
      reservedHistoryEntryIds,
      writeAuthority: { kind: "known" },
      authorityRecoveryGeneration: 0,
      authorityRecovery: null,
      unknownOutcomeExpectation: null,
      nextBackspaceGestureToken: 0,
      backspaceGesture: null,
      lifecycleDrain: null
    };
  };

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
    const drainingBackspace =
      session.entry.backspaceGesture?.owner === session &&
      session.entry.backspaceGesture.finishing !== null;

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
    for (const pending of session.entry.keyboardInsertions.cancelForSession(
      session.frontendSessionId
    )) {
      session.entry.optimisticKeyboardInsertions.delete(
        pending.intent.expectedNodeId
      );
      session.entry.history.discard(
        pending.expectedStructuralHistoryEntryId
      );
    }
    session.outlinePanes.clear();
    session.preparedKeyboardInsertions.clear();
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
      } else if (
        session.entry.authoritativePresentation &&
        !drainingBackspace
      ) {
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

    const lifecycleDrain = session.entry.lifecycleDrain;
    if (lifecycleDrain?.owner === session && lifecycleDrain.settled) {
      session.entry.lifecycleDrain = null;
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
      const frontendSessionGeneration =
        ++entry.nextFrontendSessionGeneration;
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
        ownerToken: 0,
        frontendSessionId: `${vaultRoot}\u0000${frontendSessionGeneration}`,
        frontendSessionGeneration,
        outlinePanes: new Map(),
        preparedKeyboardInsertions: new Map(),
        coordinatorSession: null
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
        observer = false,
        settleFailure: ((error: string) => void) | null = null,
        keyboardInsertion: NotesKeyboardInsertionPreparation | null = null,
        publicationOwner: NotesProjectionPublicationOwner = { kind: "other" },
        unknownOutcomeExpectation: NotesUnknownOutcomeExpectation | null = null,
        lifecycleAdmitted = false
      ): Promise<NotesWorkspaceCommandOutcome> => {
        if (!session.active && !retainAfterOwnerClose) {
          return Promise.resolve("skipped");
        }
        if (session.presentation === "background") {
          return Promise.resolve("skipped");
        }
        if (
          entry.lifecycleDrain !== null &&
          !lifecycleAdmitted &&
          !silent &&
          !observer
        ) {
          return Promise.resolve("skipped");
        }
        if (
          !retainAfterOwnerClose &&
          !observer &&
          (entry.historyBlocked || entry.writeAuthority.kind !== "known")
        ) {
          if (settleFailure) {
            settleFailureSafely(
              settleFailure,
              entry.writeAuthority.kind === "unknown"
                ? entry.writeAuthority.error
                : AUTHORITY_RECOVERY_INSTRUCTION
            );
            return Promise.resolve("skipped");
          }
          return Promise.resolve("failed");
        }
        if (!retainAfterOwnerClose && !observer && session.activated) {
          if (entry.presentationBlocked) {
            if (transferOwner(entry, session)) {
              return Promise.resolve("skipped");
            }
            if (settleFailure) {
              settleFailureSafely(settleFailure, HISTORY_REOPEN_INSTRUCTION);
              return Promise.resolve("skipped");
            }
            return Promise.resolve("failed");
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
          settleFailure,
          keyboardInsertion,
          keyboardInsertionInvalidated: false,
          publicationOwner,
          unknownOutcomeExpectation,
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
        if (keyboardInsertion) {
          setOptimisticInsertionStatus(
            entry,
            keyboardInsertion.pending.intent.expectedNodeId,
            "queued"
          );
        }
        if (!silent) {
          notify(session, { type: "pending", selectionPolicy });
        }
        pump(entry);
        return item.completion;
      };
      let coordinatorSession!: NotesWorkspaceCoordinatorSession;
      const executeLifecycleDrain = async (): Promise<boolean> => {
        await activationCompletion;
        if (
          !session.active ||
          session.presentation !== "writable" ||
          entry.owner !== session
        ) {
          return false;
        }

        const backspace = entry.backspaceGesture;
        if (backspace) {
          const backspaceOwner = backspace.owner.coordinatorSession;
          if (!backspaceOwner) return false;
          const outcome = await backspaceOwner.finishBackspaceGesture("drain");
          if (outcome === "failed" || entry.backspaceGesture !== null) {
            return false;
          }
        }

        const admittedStructuralTail = entry.structuralTail;
        await admittedStructuralTail;
        if (!session.active || entry.writeAuthority.kind !== "known") {
          return false;
        }

        const participants = [...entry.sessions]
          .filter((participant) => participant.active)
          .map((participant) => {
            const cutoff =
              participant.captureDraftCutoff?.({ kind: "other" }) ?? 0;
            const beforeStructural = participant.beforeStructural;
            const afterStructural = participant.afterStructural;
            let finalized = false;
            return {
              cutoff,
              beforeStructural,
              finalize(): void {
                if (finalized) return;
                finalized = true;
                try {
                  afterStructural?.(cutoff);
                } catch {
                  // Lifecycle release cannot strand the strict drain.
                }
              }
            };
          });
        try {
          for (const participant of participants) {
            if (
              participant.beforeStructural &&
              !(await participant.beforeStructural(participant.cutoff))
            ) {
              return false;
            }
          }
        } finally {
          for (const participant of participants) participant.finalize();
        }

        let observerRan = false;
        await enqueueCommand(
          () => {
            observerRan = true;
            return { kind: "skipped" };
          },
          true,
          "preserve",
          true,
          true,
          null,
          null,
          { kind: "other" },
          null,
          true
        );
        if (
          !observerRan ||
          !session.active ||
          entry.writeAuthority.kind !== "known" ||
          entry.backspaceGesture !== null
        ) {
          return false;
        }
        await drainHistoryCleanup(entry);
        return entry.pendingHistoryCleanupIds.size === 0;
      };
      coordinatorSession = {
        activation: activationCompletion,
        history: entry.history,
        drain(): Promise<boolean> {
          const active = entry.lifecycleDrain;
          if (active) return active.completion;
          const terminal = completionParts<boolean>();
          const lifecycle = {
            owner: session,
            completion: terminal.completion,
            settled: false
          };
          entry.lifecycleDrain = lifecycle;
          void executeLifecycleDrain().then(
            (succeeded) => {
              lifecycle.settled = true;
              if (!succeeded && entry.lifecycleDrain === lifecycle) {
                entry.lifecycleDrain = null;
              }
              terminal.resolveCompletion(succeeded);
              maybeDeleteEntry(entry);
            },
            () => {
              lifecycle.settled = true;
              if (entry.lifecycleDrain === lifecycle) {
                entry.lifecycleDrain = null;
              }
              terminal.resolveCompletion(false);
              maybeDeleteEntry(entry);
            }
          );
          return terminal.completion;
        },
        isLifecycleDraining(): boolean {
          return entry.lifecycleDrain !== null;
        },
        prepareKeyboardInsertion(
          input: NotesKeyboardInsertionRequest
        ): NotesKeyboardInsertionPreparation | null {
          const paneState = session.outlinePanes.get(input.ownerPaneId);
          if (
            !session.active ||
            !session.activated ||
            session.presentation !== "writable" ||
            entry.owner !== session ||
            !paneState ||
            entry.lifecycleDrain !== null ||
            paneState.snapshot.interactionEpoch !==
              input.interactionEpochAtDispatch ||
            entry.keyboardInsertions.get(input.intent.expectedNodeId)
          ) {
            return null;
          }
          const before =
            session.captureHistoryLocation?.() ??
            entry.authoritativePresentation?.snapshot ??
            null;
          if (!before) return null;
          let historyContext;
          entry.reservedHistoryEntryIds.push(input.intent.expectedNodeId);
          try {
            historyContext = entry.history.beginStructuralEntry(
              input.intent.postcondition.kind === "split"
                ? "split"
                : "create",
              before
            );
          } catch {
            const reservedIndex = entry.reservedHistoryEntryIds.indexOf(
              input.intent.expectedNodeId
            );
            if (reservedIndex >= 0) {
              entry.reservedHistoryEntryIds.splice(reservedIndex, 1);
            }
            return null;
          }
          const pending: PendingKeyboardInsertion = {
            intent: {
              ...input.intent,
              ownerSessionGeneration: session.frontendSessionGeneration
            },
            ownerSessionId: session.frontendSessionId,
            ownerPaneId: input.ownerPaneId,
            interactionEpochAtDispatch: input.interactionEpochAtDispatch,
            expectedStructuralHistoryEpoch: historyContext.historyEpoch,
            expectedStructuralHistoryEntryId: historyContext.entryId,
            projectionGenerationAtDispatch: entry.projectionGeneration,
            layoutGenerationAtDispatch: paneState.layoutGeneration,
            paneSnapshotAtDispatch: clonePaneSnapshot(
              paneState.snapshot.sessionId,
              paneState.snapshot
            ),
            dragGenerationAtDispatch: paneState.dragGeneration
          };
          const preparation = { pending, historyContext };
          if (!entry.keyboardInsertions.register(pending)) {
            entry.history.discard(historyContext.entryId);
            return null;
          }
          session.preparedKeyboardInsertions.set(
            pending.intent.expectedNodeId,
            preparation
          );
          if (input.optimistic) {
            const optimistic: OptimisticKeyboardInsertion = {
              pending,
              historyContext,
              dependencyId: input.optimistic.dependencyId ?? null,
              checkpoint: input.optimistic.checkpoint,
              sourceTitle: input.optimistic.sourceTitle,
              insertedTitle: input.optimistic.insertedTitle,
              status: "prepared",
              focusAcknowledged: false,
              undoRequested: false
            };
            entry.optimisticKeyboardInsertions.set(
              pending.intent.expectedNodeId,
              optimistic
            );
            notifyOptimisticInsertion(entry, optimistic);
          }
          return preparation;
        },
        cancelKeyboardInsertion(preparation): void {
          if (
            preparation.pending.ownerSessionId ===
            session.frontendSessionId
          ) {
            cancelKeyboardInsertion(entry, preparation);
          }
        },
        updateOptimisticKeyboardInsertion(expectedNodeId, title): void {
          const insertion =
            entry.optimisticKeyboardInsertions.get(expectedNodeId);
          if (
            insertion?.pending.ownerSessionId !== session.frontendSessionId ||
            insertion.insertedTitle === title
          ) {
            return;
          }
          const updated = { ...insertion, insertedTitle: title };
          entry.optimisticKeyboardInsertions.set(expectedNodeId, updated);
          notifyOptimisticInsertion(entry, updated);
        },
        acknowledgeOptimisticKeyboardInsertionFocus(
          expectedNodeId,
          intentToken
        ): void {
          const insertion =
            entry.optimisticKeyboardInsertions.get(expectedNodeId);
          if (
            insertion?.pending.ownerSessionId !== session.frontendSessionId ||
            insertion.pending.intent.token !== intentToken ||
            insertion.focusAcknowledged
          ) {
            return;
          }
          const acknowledged = { ...insertion, focusAcknowledged: true };
          entry.optimisticKeyboardInsertions.set(
            expectedNodeId,
            acknowledged
          );
          notifyOptimisticInsertion(entry, acknowledged);
        },
        dismissOptimisticInsertionFailure(): void {
          const failure = entry.optimisticInsertionFailure;
          if (
            failure?.insertion.pending.ownerSessionId !==
            session.frontendSessionId
          ) {
            return;
          }
          entry.optimisticInsertionFailure = null;
          notifyOptimisticInsertion(entry, failure.insertion);
        },
        pendingKeyboardInsertion(expectedNodeId) {
          const pending = entry.keyboardInsertions.get(expectedNodeId);
          return pending?.ownerSessionId === session.frontendSessionId
            ? pending
            : undefined;
        },
        beginBackspaceGesture(input, createDraftLease, work): number | null {
          const current = entry.backspaceGesture;
          if (current) {
            return current.owner === session &&
              current.snapshot.ownerPaneId === input.ownerPaneId &&
              current.snapshot.status === "active"
              ? current.snapshot.token
              : null;
          }
          if (
            !session.active ||
            !session.activated ||
            session.presentation !== "writable" ||
            entry.owner !== session ||
            !session.outlinePanes.has(input.ownerPaneId) ||
            entry.lifecycleDrain !== null ||
            entry.historyBlocked ||
            entry.presentationBlocked ||
            entry.writeAuthority.kind !== "known"
          ) {
            return null;
          }
          let captured = session.captureHistoryLocation?.() ?? null;
          if (!captured && entry.authoritativePresentation) {
            captured = entry.authoritativePresentation.snapshot;
            retainHistorySnapshot(captured);
          }
          if (!captured) return null;
          const focus = {
            nodeId: input.nodeId,
            field: "title" as const,
            primarySelection: { ...input.selection }
          };
          const before =
            input.ownerPaneId === "secondary"
              ? captured.secondaryPane
                ? {
                    ...captured,
                    activePaneId: input.ownerPaneId,
                    secondaryPane: {
                      ...captured.secondaryPane,
                      selectedId: input.nodeId,
                      focus
                    }
                  }
                : null
              : {
                  ...captured,
                  activePaneId: input.ownerPaneId,
                  selectedId: input.nodeId,
                  focus
                };
          if (!before) {
            releaseHistorySnapshot(captured);
            return null;
          }
          let historyContext;
          try {
            historyContext = entry.history.beginStructuralEntry(
              "backspaceGesture",
              before
            );
          } catch {
            releaseHistorySnapshot(captured);
            return null;
          }
          releaseHistorySnapshot(captured);
          const token = ++entry.nextBackspaceGestureToken;
          let draftLease: NotesBackspaceDraftLease | null = null;
          try {
            draftLease = createDraftLease(token);
          } catch {
            // A missing draft owner invalidates the reserved history entry.
          }
          if (!draftLease || draftLease.token !== token) {
            entry.history.discard(historyContext.entryId);
            return null;
          }
          const state: BackspaceGestureState = {
            snapshot: {
              token,
              ownerPaneId: input.ownerPaneId,
              startingNodeId: input.nodeId,
              startingSelection: { ...input.selection },
              removedNodeIds: [],
              titleUpdate: null,
              focusNodeId: input.nodeId,
              status: "active"
            },
            owner: session,
            historyContext,
            draftLease,
            work,
            afterSnapshot: null,
            draftCommit: null,
            finishing: null,
            resolveFinishing: null
          };
          entry.backspaceGesture = state;
          notifyOptimisticBackspaceGesture(state);
          return token;
        },
        touchBackspaceGesture(token, nodeId): void {
          const state = entry.backspaceGesture;
          if (
            !state ||
            state.owner !== session ||
            state.snapshot.token !== token ||
            state.snapshot.status !== "active"
          ) {
            return;
          }
          state.draftLease.touch(nodeId);
        },
        removeEmptyNodeInBackspaceGesture(
          token,
          nodeId,
          focusNodeId
        ): boolean {
          const state = entry.backspaceGesture;
          if (
            !state ||
            state.owner !== session ||
            state.snapshot.token !== token ||
            state.snapshot.status !== "active"
          ) {
            return false;
          }
          const snapshot = appendBackspaceRemoval(state.snapshot, {
            nodeId,
            focusNodeId,
            titleUpdate: null
          });
          if (snapshot === state.snapshot) return false;
          updateOptimisticBackspaceGesture(state, snapshot);
          return true;
        },
        finishBackspaceGesture(reason): Promise<NotesWorkspaceCommandOutcome> {
          const state = entry.backspaceGesture;
          if (!state || state.owner !== session) {
            return Promise.resolve("skipped");
          }
          if (state.finishing) return state.finishing;
          if (state.snapshot.status !== "active") {
            return Promise.resolve("skipped");
          }
          const terminal = completionParts<NotesWorkspaceCommandOutcome>();
          state.finishing = terminal.completion;
          state.resolveFinishing = terminal.resolveCompletion;
          const queued = Object.freeze({
            ...state.snapshot,
            removedNodeIds: Object.freeze([...state.snapshot.removedNodeIds]),
            status: "queued" as const
          });
          updateOptimisticBackspaceGesture(state, queued);
          const rollback = (outcome: "failed" | "cancelled", restore: boolean) => {
            entry.history.discard(state.historyContext.entryId);
            state.draftLease.settle(outcome);
            clearOptimisticBackspaceGesture(
              state,
              restore,
              outcome === "failed" ? "failed" : "skipped"
            );
          };
          let after = session.captureHistoryLocation?.() ?? null;
          if (!after && entry.authoritativePresentation) {
            after = entry.authoritativePresentation.snapshot;
            retainHistorySnapshot(after);
          }
          state.afterSnapshot = after;
          const releaseAfter = (): void => {
            if (!state.afterSnapshot) return;
            releaseHistorySnapshot(state.afterSnapshot);
            state.afterSnapshot = null;
          };
          const fail = (
            outcome: "failed" | "cancelled",
            restore: boolean
          ): void => {
            releaseAfter();
            rollback(outcome, restore);
          };
          const completion = (async () => {
            if (!after) {
              fail("failed", true);
              return;
            }
            let draftCommit: NotesBackspaceDraftCommit;
            try {
              draftCommit = await state.draftLease.prepare(
                queued.removedNodeIds
              );
            } catch {
              fail("failed", true);
              return;
            }
            if (!draftCommit.baselineFlushed) {
              fail("failed", true);
              return;
            }
            state.draftCommit = draftCommit;
            if (
              queued.removedNodeIds.length === 0 &&
              draftCommit.titleUpdate === null
            ) {
              fail("cancelled", false);
              return;
            }
            const prepared = Object.freeze({
              ...queued,
              titleUpdate: draftCommit.titleUpdate
                ? Object.freeze({ ...draftCommit.titleUpdate })
                : null
            });
            updateOptimisticBackspaceGesture(state, prepared);
            const outcome = await coordinatorSession.enqueueStructural(
              async (context) => {
                const running = Object.freeze({
                  ...prepared,
                  status: "running" as const
                });
                updateOptimisticBackspaceGesture(state, running);
                let result;
                try {
                  result = await state.work(context, {
                    gesture: running,
                    historyContext: state.historyContext,
                    draftCommit
                  });
                } catch (cause) {
                  if (isNotesMutationOutcomeUnknown(cause)) {
                    updateOptimisticBackspaceGesture(state, {
                      ...running,
                      status: "checking"
                    });
                  }
                  throw cause;
                }
                if (result.kind !== "authoritative") return result;
                const acceptedAfter = state.afterSnapshot;
                if (!acceptedAfter) {
                  return {
                    kind: "failure",
                    error: "Backspace history location is unavailable.",
                    workspace: result.workspace,
                    historyStatus: result.historyStatus,
                    committedHistoryEntryIds: result.committedHistoryEntryIds
                  };
                }
                if (result.historyStatus) {
                  const accepted = entry.history.acceptMutationResult(
                    state.historyContext.entryId,
                    acceptedAfter,
                    result.historyStatus
                  );
                  if (!accepted.accepted) {
                    updateOptimisticBackspaceGesture(state, {
                      ...running,
                      status: "checking"
                    });
                    throw Object.assign(
                      new Error(
                        "Backspace history acknowledgement was rejected."
                      ),
                      {
                        notesMutationOutcome: "unknown" as const,
                        mutationCommitted: true as const
                      }
                    );
                  }
                  for (const entryId of accepted.unreachableEntryIds) {
                    entry.pendingHistoryCleanupIds.add(entryId);
                  }
                } else {
                  entry.history.rememberAfter(
                    state.historyContext.entryId,
                    acceptedAfter
                  );
                }
                replaceAuthoritativePresentation(
                  entry,
                  normalizeWorkspace(result.workspace),
                  acceptedAfter,
                  false,
                  false
                );
                state.afterSnapshot = null;
                return result;
              },
              {
                retainAfterClose: reason === "drain",
                requireAllBarriers: true,
                unknownOutcomeExpectation: {
                  kind: "unclassified",
                  historyContext: state.historyContext
                }
              }
            );
            if (outcome === "committed") {
              const recoveredAfter = state.afterSnapshot;
              if (recoveredAfter) {
                const historyStatus = entry.historyStatus;
                if (!historyStatus) {
                  fail("failed", true);
                  return;
                }
                const accepted = entry.history.acceptMutationResult(
                  state.historyContext.entryId,
                  recoveredAfter,
                  historyStatus
                );
                if (!accepted.accepted) {
                  updateOptimisticBackspaceGesture(state, {
                    ...state.snapshot,
                    status: "checking"
                  });
                  setWriteAuthority(entry, {
                    kind: "unknown",
                    error: AUTHORITY_RECOVERY_INSTRUCTION
                  });
                  return;
                }
                for (const entryId of accepted.unreachableEntryIds) {
                  entry.pendingHistoryCleanupIds.add(entryId);
                }
                replaceAuthoritativePresentation(
                  entry,
                  normalizeWorkspace(entry.confirmedWorkspace),
                  recoveredAfter,
                  false,
                  false
                );
                state.afterSnapshot = null;
              }
              state.draftLease.settle("committed");
              clearOptimisticBackspaceGesture(state, false, "committed");
              return;
            }
            if (
              state.snapshot.status === "checking" &&
              entry.writeAuthority.kind === "unknown"
            ) {
              return;
            }
            fail("failed", true);
          })().catch(() => {
            if (entry.backspaceGesture === state) {
              fail("failed", true);
            }
          });
          void completion;
          return terminal.completion;
        },
        cancelBackspaceGesture(): void {
          const state = entry.backspaceGesture;
          if (
            !state ||
            state.owner !== session ||
            state.snapshot.status !== "active"
          ) {
            return;
          }
          entry.history.discard(state.historyContext.entryId);
          state.draftLease.settle("cancelled");
          clearOptimisticBackspaceGesture(state, false, "skipped");
        },
        publishOutlinePaneState(input): void {
          if (!session.active) return;
          const snapshot = clonePaneSnapshot(
            session.frontendSessionId,
            input
          );
          const previous = session.outlinePanes.get(input.paneId);
          const layoutChanged = Boolean(
            previous &&
              (previous.snapshot.visibleSignature !==
                snapshot.visibleSignature ||
                previous.snapshot.geometryGeneration !==
                  snapshot.geometryGeneration)
          );
          session.outlinePanes.set(input.paneId, {
            snapshot,
            layoutGeneration:
              (previous?.layoutGeneration ?? 0) + (layoutChanged ? 1 : 0),
            dragGeneration:
              (previous?.dragGeneration ?? 0) +
              (previous &&
              previous.snapshot.activeDrag !== snapshot.activeDrag
                ? 1
                : 0)
          });
        },
        publishOutlineInteractionEpoch(input): void {
          const pane = session.outlinePanes.get(input.paneId);
          if (!pane) return;
          pane.snapshot = {
            ...pane.snapshot,
            interactionEpoch: input.interactionEpoch
          };
        },
        publishOutlineDragState(input): void {
          const pane = session.outlinePanes.get(input.paneId);
          if (!pane) return;
          if (pane.snapshot.activeDrag !== input.activeDrag) {
            pane.dragGeneration += 1;
          }
          pane.snapshot = {
            ...pane.snapshot,
            activeDrag: input.activeDrag
          };
        },
        unregisterOutlinePane(paneId): void {
          const invalidate = (item: QueueItem | null): void => {
            if (
              item?.kind !== "command" ||
              item.keyboardInsertion?.pending.ownerSessionId !==
                session.frontendSessionId ||
              item.keyboardInsertion.pending.ownerPaneId !== paneId
            ) {
              return;
            }
            item.keyboardInsertionInvalidated = true;
          };
          invalidate(entry.running);
          for (const item of entry.queue) invalidate(item);
          session.outlinePanes.delete(paneId);
          for (const pending of entry.keyboardInsertions.cancelForPane(
            session.frontendSessionId,
            paneId
          )) {
            entry.optimisticKeyboardInsertions.delete(
              pending.intent.expectedNodeId
            );
            session.preparedKeyboardInsertions.delete(
              pending.intent.expectedNodeId
            );
            entry.history.discard(
              pending.expectedStructuralHistoryEntryId
            );
          }
        },
        writeAuthority(): NotesWriteAuthority {
          return entry.writeAuthority;
        },
        retryAuthorityRecovery(): Promise<boolean> {
          const expectation = entry.unknownOutcomeExpectation;
          if (!expectation) return Promise.resolve(false);
          const publish =
            entry.writeAuthority.kind === "unknown";
          return recoverUnknownOutcomeForEntry(entry, expectation, session).then(
            (decision) => {
              if (decision.kind === "authorityUnknown") return false;
              if (publish) publishManualAuthorityRecovery(entry, decision);
              return true;
            }
          );
        },
        reserveImageImportInsertion(
          anchor: ImageNodeInsertionAnchor
        ): NotesWorkspaceImageImportReservation {
          return reserveImageImportInsertion(entry, anchor);
        },
        enqueue(
          work: NotesWorkspaceQueueWork,
          options?: {
            silent?: boolean;
            observer?: boolean;
            publicationOwner?: NotesProjectionPublicationOwner;
            unknownOutcomeExpectation?: NotesUnknownOutcomeExpectation;
          }
        ): Promise<NotesWorkspaceCommandOutcome> {
          return enqueueCommand(
            work,
            options?.silent ?? false,
            "clear",
            false,
            options?.observer ?? false,
            null,
            null,
            options?.publicationOwner,
            options?.unknownOutcomeExpectation ?? null
          );
        },
        enqueueStructural(
          work: NotesWorkspaceQueueWork,
          options?: {
            selectionPolicy?: NotesPendingSelectionPolicy;
            retainAfterClose?: boolean;
            requireAllBarriers?: boolean;
            settleFailure?: (error: string) => void;
            keyboardInsertion?: NotesKeyboardInsertionPreparation;
            unknownOutcomeExpectation?: NotesUnknownOutcomeExpectation;
          }
        ): Promise<NotesWorkspaceCommandOutcome> {
          if (session.presentation === "background") {
            return Promise.resolve("skipped");
          }
          const retainAfterClose = options?.retainAfterClose === true;
          const requireAllBarriers = options?.requireAllBarriers === true;
          const keyboardInsertion = options?.keyboardInsertion ?? null;
          const lifecycleAdmitted =
            entry.lifecycleDrain === null || retainAfterClose;
          if (!lifecycleAdmitted) {
            return Promise.resolve("skipped");
          }
          if (keyboardInsertion) {
            const pending = entry.keyboardInsertions.get(
              keyboardInsertion.pending.intent.expectedNodeId
            );
            if (
              pending !== keyboardInsertion.pending ||
              pending.ownerSessionId !== session.frontendSessionId ||
              keyboardInsertion.historyContext.entryId !==
                pending.expectedStructuralHistoryEntryId ||
              keyboardInsertion.historyContext.historyEpoch !==
                pending.expectedStructuralHistoryEpoch
            ) {
              cancelKeyboardInsertion(entry, keyboardInsertion);
              return Promise.resolve("skipped");
            }
            setOptimisticInsertionStatus(
              entry,
              pending.intent.expectedNodeId,
              "queued"
            );
          }
          const participants = [...entry.sessions]
            .filter((participant) => participant.active)
            .map((participant) => {
              const publicationOwner: NotesProjectionPublicationOwner =
                participant === session && keyboardInsertion
                  ? {
                      kind: "keyboard-draft",
                      intentToken: keyboardInsertion.pending.intent.token
                    }
                  : { kind: "other" };
              const cutoff =
                participant.captureDraftCutoff?.(publicationOwner) ?? 0;
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
                if (
                  keyboardInsertion &&
                  !isKeyboardInsertionCurrent(entry, keyboardInsertion)
                ) {
                  cancelKeyboardInsertion(entry, keyboardInsertion);
                  return "skipped";
                }
                const structural = enqueueCommand(
                  work,
                  false,
                  options?.selectionPolicy ?? "clear",
                  retainAfterClose,
                  false,
                  options?.settleFailure ?? null,
                  keyboardInsertion,
                  { kind: "other" },
                  options?.unknownOutcomeExpectation ?? null,
                  lifecycleAdmitted
                );
                finalizeParticipants();
                return await structural;
              } catch (cause) {
                if (!options?.settleFailure) throw cause;
                settleFailureSafely(
                  options.settleFailure,
                  errorMessage(cause)
                );
                return "skipped";
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
          const settlePreparedInsertion = (
            outcome: NotesWorkspaceCommandOutcome
          ): NotesWorkspaceCommandOutcome => {
            if (
              keyboardInsertion &&
              outcome !== "committed" &&
              entry.keyboardInsertions.get(
                keyboardInsertion.pending.intent.expectedNodeId
              ) === keyboardInsertion.pending
            ) {
              cancelKeyboardInsertion(entry, keyboardInsertion);
            }
            return outcome;
          };
          if (retainAfterClose) {
            return completion.then(settlePreparedInsertion);
          }
          // If the session closes before the structural intent settles, the
          // command was effectively dropped for this caller.
          return Promise.race([
            completion,
            session.closeCompletion.then(
              (): NotesWorkspaceCommandOutcome => "skipped"
            )
          ]).then(settlePreparedInsertion);
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
          before?: NotesHistorySnapshot,
          originPaneId: NotesPaneId = "primary"
        ): NotesNavigationPresentationLease {
          const canonicalBefore =
            before ?? entry.authoritativePresentation?.snapshot ?? null;
          if (
            !canonicalBefore ||
            session.presentation !== "writable" ||
            !session.active ||
            entry.owner !== session ||
            entry.ownerToken !== session.ownerToken ||
            entry.historyBlocked ||
            entry.presentationBlocked
          ) {
            return {
              beforeSnapshot: () => null,
              replaceBefore() {},
              setDestination() {},
              commit: () => [],
              cancel() {}
            };
          }
          retainHistorySnapshot(canonicalBefore);
          const state: NavigationLeaseState = {
            entry,
            originPaneId,
            before: canonicalBefore,
            after: null,
            workspace: null,
            active: true
          };
          entry.leases.add(state);
          return {
            beforeSnapshot() {
              return state.active ? state.before : null;
            },
            replaceBefore(before) {
              if (!state.active) return;
              retainHistorySnapshot(before);
              releaseHistorySnapshot(state.before);
              state.before = before;
            },
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
                destination,
                state.originPaneId
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
        settleAuthoritativePresentation(workspace, snapshot, options): void {
          replaceAuthoritativePresentation(entry, workspace, snapshot, true);
          const candidate = entry.owner;
          const applied = candidate
            ? candidate === session && options?.applyToCurrentOwner !== true
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
          return recoverHistoryMismatchForEntry(entry, session, reload);
        },
        resetHistory(historyEpoch, presentation): void {
          resetEntryHistory(entry, historyEpoch, presentation);
        },
        close(): void {
          closeSession(session);
        }
      };
      session.coordinatorSession = coordinatorSession;
      return coordinatorSession;
    },

    hasCoordinator(repository: NotesStore, vaultRoot: string): boolean {
      return entries.get(repository)?.has(vaultRoot) ?? false;
    }
  };
}

export const notesWorkspaceCoordinatorRegistry =
  createNotesWorkspaceCoordinatorRegistry();
