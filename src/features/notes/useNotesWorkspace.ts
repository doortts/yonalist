import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  createNoteId,
  isNotesMutationResult,
  MAX_NOTE_ATTACHMENT_BATCH_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS
} from "../../domain/notes";
import type {
  ImportImageNodeByteItem,
  ImportImageNodePathItem,
  MoveNoteNodeInput,
  NoteAttachment,
  NoteId,
  NoteImportNode,
  NoteNode,
  NotesHistoryContext,
  NotesHistoryStatus,
  NotesMutationResponse,
  NoteSearchResult,
  NoteTagFilter,
  NoteTagSummary,
  NotesStore,
  NotesStoreError,
  NotesWorkspace,
  NotesWorkspaceScope,
  PendingImageNodeByteItem
} from "../../domain/notes";
import {
  createNotesWriteQueue,
  type NotesWriteQueue
} from "../../services/notesWriteQueue";
import {
  notesWorkspaceCoordinatorRegistry,
  type NotesPendingSelectionPolicy,
  type NotesWorkspaceCommandOutcome,
  type NotesWorkspaceCoordinatorSession,
  type NotesWorkspaceImageImportReservation,
  type NotesWorkspaceQueueContext,
  type NotesWorkspaceQueueResult,
  type NotesWorkspaceQueueWork,
  type NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import {
  createNotesHistoryOwnerRegistry,
  type NotesHistoryFocus,
  type NotesHistoryFocusField,
  type NotesHistoryLocationSnapshot,
  type NotesHistorySnapshot
} from "./notesHistory";
import {
  normalizeWorkspace,
  notesSelectionReducer,
  notesWorkspaceReducer,
  reconcileUiState,
  type NormalizedNotesWorkspace,
  type NotesSelection,
  type NotesSelectionAction,
  type NotesWorkspaceDelta,
  type NotesWorkspaceReducerAction
} from "./notesWorkspaceReducer";
import {
  canonicalizeTagFilters,
  noteTagFilterFromLegacyScope,
  sameScope,
  tagFilterKey
} from "./notesWorkspaceScope";
import { parseAndValidateNoteSearchQuery } from "./noteSearchQuery";
import {
  nativeNotesAttachmentUi,
  type NotesAttachmentUiBoundary
} from "./notesAttachmentController";
import {
  buildNotesMoveNodeInput,
  isActiveMoveNode
} from "./notesMoveTargets";
import {
  createImageNodeIdPairs,
  imageNodeByteItems,
  imageNodeInsertionAnchor,
  imageNodePathItems,
  sameImageNodeInsertionAnchor,
  type ImageNodeInsertionAnchor
} from "./imageNodeInsertion";
import {
  NotesDraftEngine,
  type DraftWriteAttempt,
  type NotesDraftEngineHost,
  type NotesWorkspaceSessionRecord
} from "./notesDraftEngine";
import {
  applyBatchCommand,
  applyPreparedSelectionBatchCommand,
  commitPreparedMoveCommand,
  createChildCommand,
  createNextTextSiblingCommand,
  createRootCommand,
  deleteNodeCommand,
  duplicateNodeCommand,
  emptyTrashCommand,
  importSubtreeCommand,
  moveNodeCommand,
  removeEmptyNodeCommand,
  restoreNodeCommand,
  runAtomicSubtreeCommand,
  runRootLifecycle,
  splitNodeCommand,
  toggleCollapsedCommand,
  toggleCompleteCommand,
  toggleStarCommand,
  updateNodeCommand,
  type NotesBatchOp,
  type NotesBatchCommandSettlement,
  type NotesCommandContext
} from "./notesCommands";

export interface NotesDeleteAllOptions {
  /**
   * Discard any pending drafts that could not be written and delete the Notes
   * data regardless. Recovers a vault whose database is broken enough that the
   * pre-delete flush can never succeed.
   */
  discardDrafts?: boolean;
}

export interface NotesDeleteAllResult {
  /**
   * True when the database was deleted but some attachment files were left on
   * disk. Non-blocking: the deletion still completed.
   */
  attachmentCleanupFailed: boolean;
}

/**
 * Discriminator for the rejection `deleteAllNotesData` throws when the
 * pre-delete draft flush fails and the caller has not opted into discarding
 * drafts. Lets the settings dialog offer an explicit "discard and delete"
 * confirmation instead of surfacing a dead end.
 */
export const NOTES_DRAFTS_FLUSH_FAILED_CODE = "notes-drafts-flush-failed";

interface NotesDraftsFlushFailedError extends Error {
  code: typeof NOTES_DRAFTS_FLUSH_FAILED_CODE;
}

function notesDraftsFlushFailedError(
  cause: NotesStoreError | null
): NotesDraftsFlushFailedError {
  const error = new Error(
    cause?.message ?? "Pending Notes changes could not be saved."
  ) as NotesDraftsFlushFailedError;
  error.name = "NotesDraftsFlushFailedError";
  error.code = NOTES_DRAFTS_FLUSH_FAILED_CODE;
  return error;
}

export function isNotesDraftsFlushFailedError(
  value: unknown
): value is NotesDraftsFlushFailedError {
  return (
    value instanceof Error &&
    (value as { code?: unknown }).code === NOTES_DRAFTS_FLUSH_FAILED_CODE
  );
}

/**
 * Narrows the value resolved by `NotesStore.deleteDatabase`. Injected test
 * repositories may still resolve `undefined`, so the cleanup flag is read
 * structurally instead of trusting the interface type.
 */
function hasAttachmentCleanupFlag(
  value: unknown
): value is { attachmentCleanupFailed: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { attachmentCleanupFailed?: unknown })
      .attachmentCleanupFailed === "boolean"
  );
}

export interface NotesWorkspaceActions {
  acknowledgeFocus(nodeId: NoteId): Promise<void>;
  focusNode(nodeId: NoteId): Promise<void>;
  /** Records a real editor-caret move without dispatching a row-wide render. */
  markEditingFocus?(
    nodeId: NoteId,
    field: NotesHistoryFocusField
  ): void;
  /** Live navigation epoch used to own async command postconditions. */
  getNavigationVersion?(): number;
  createRoot(): Promise<NotesWorkspaceCommandOutcome>;
  createNextTextSibling(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  splitNode(
    nodeId: NoteId,
    newNodeId: NoteId,
    prefix: string,
    suffix: string,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<NotesWorkspaceCommandOutcome>;
  createChild(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  updateNode(
    nodeId: NoteId,
    patch: Pick<NoteNode, "title" | "note">
  ): Promise<NotesWorkspaceCommandOutcome>;
  updateNodeDraft(
    nodeId: NoteId,
    patch: Pick<NoteNode, "title" | "note">,
    field?: NotesHistoryFocusField
  ): void;
  flushNodeDraft(nodeId: NoteId): Promise<boolean>;
  flushAllDrafts(): Promise<boolean>;
  moveNode(
    input: MoveNoteNodeInput,
    focusNodeId?: NoteId | null,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<NotesWorkspaceCommandOutcome>;
  // Apply one structural op to a whole multi-node selection (plan Phase 4.1) as
  // a single history entry. `options.focusNodeId` lets a batch delete hand focus
  // to a surviving neighbor. Stable identity.
  applyBatch(
    nodeIds: readonly NoteId[],
    op: NotesBatchOp,
    options?: { focusNodeId?: NoteId | null }
  ): Promise<NotesWorkspaceCommandOutcome>;
  // Paste import (plan Phase 4.4): insert `nodes` as one contiguous block
  // under `parentId` right after `afterId`, one history entry. Focuses the
  // first imported root on success. Stable identity.
  importSubtree(
    parentId: NoteId | null,
    afterId: NoteId | null,
    nodes: readonly NoteImportNode[]
  ): Promise<NotesWorkspaceCommandOutcome>;
  toggleComplete(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  toggleCollapsed(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  expandAll(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  collapseAll(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  sortSubtreeAscending(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  sortSubtreeDescending(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  toggleStar(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  duplicateNode(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  removeEmptyNode(
    nodeId: NoteId,
    focusNodeId?: NoteId | null,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<NotesWorkspaceCommandOutcome>;
  deleteNode(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  restoreNode(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  archiveNode(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  unarchiveNode(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  emptyTrash(): Promise<NotesWorkspaceCommandOutcome>;
  selectLibraryView(view: NotesLibraryView): Promise<void>;
  toggleTagFilter(filter: NoteTagFilter): Promise<void>;
  searchNotes(query: string): Promise<NoteSearchResult[]>;
  openSearchResult(nodeId: NoteId): Promise<void>;
  deleteAllNotesData(
    options?: NotesDeleteAllOptions
  ): Promise<NotesDeleteAllResult>;
  zoomTo(nodeId: NoteId | null): Promise<void>;
  uploadImage?(nodeId: NoteId): Promise<void>;
  importDroppedImagePaths?(
    nodeId: NoteId,
    paths: readonly string[]
  ): Promise<void>;
  importClipboardImages?(
    nodeId: NoteId,
    items: readonly PendingImageNodeByteItem[]
  ): Promise<void>;
  retryImageUpload?(nodeId: NoteId, attemptId?: string): Promise<void>;
  loadAttachmentBytes?(attachmentId: string): Promise<Uint8Array>;
  viewImageOriginal?(attachmentId: string): Promise<void>;
  downloadImage?(
    attachmentId: string,
    originalName: string,
    mimeType: NoteAttachment["mimeType"]
  ): Promise<void>;
  resizeImage?(attachmentId: string, displayWidth: number): Promise<void>;
  removeImage?(attachmentId: string): Promise<void>;
  undo?(): Promise<void>;
  redo?(): Promise<void>;
  setImageImportMaxDisplayWidth(displayWidth: number | null): void;
  // Multi-node selection (Phase 4.1). Stable identity.
  setSelectionAnchor(anchorId: NoteId): void;
  extendSelectionTo(headId: NoteId): void;
  clearSelection(): void;
  replaceSelection?(
    selection: NotesSelection | null,
    expectedRevision?: number
  ): boolean;
  /** Synchronous ownership read for same-turn selection commands. */
  getSelectionSnapshot?(): Readonly<{
    selection: NotesSelection | null;
    revision: number;
  }>;
}

export type NotesLibraryView =
  | "all"
  | "starred"
  | "recent"
  | "tags"
  | "archive"
  | "trash";

export interface NotesWorkspaceCompoundOptions {
  draft?: Pick<NoteNode, "title" | "note">;
  expandNodeId?: NoteId;
  onSuccess?: () => void;
}

export interface UseNotesWorkspaceOptions {
  vaultRoot: string;
  repository: NotesStore;
  attachmentUi?: NotesAttachmentUiBoundary;
}

export interface NotesPreparedMove {
  readonly token: number;
  readonly vaultRoot: string;
  readonly scope: NotesWorkspaceScope;
  readonly generation: number;
  readonly sourceId: NoteId;
  readonly nodes: readonly NoteNode[];
}

/**
 * Frozen ownership proof for one selected-range operation. `workspace` is a
 * complete Active projection (never the current filtered/library projection)
 * and is deeply frozen at the node/attachment/ordering boundaries used by the
 * router.
 */
export interface NotesPreparedSelectionAuthority {
  readonly token: number;
  readonly vaultRoot: string;
  readonly scope: NotesWorkspaceScope;
  readonly generation: number;
  readonly session: NotesWorkspaceCoordinatorSession;
  readonly selectionRevision: number;
  readonly selectedNodeIds: readonly NoteId[];
  readonly workspace: NormalizedNotesWorkspace;
}

export type NotesPreparedMoveCommitResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Low-volatility slice: workspace projection + navigation + loading/history
 * status. Changes on structural mutations, navigation, and scope switches, but
 * NOT on draft keystrokes.
 */
export interface NotesStateSlice {
  state: NormalizedNotesWorkspace;
  deletingNotesData: boolean;
  libraryView: NotesLibraryView;
  activeTagFilters: readonly NoteTagFilter[];
  tagSummaries: readonly NoteTagSummary[];
  locallyExpandedNodeIds: ReadonlySet<NoteId>;
  status: NormalizedNotesWorkspace["status"];
  loading: boolean;
  error: string | null;
  canUndo?: boolean;
  canRedo?: boolean;
}

/**
 * High-volatility slice: the per-node draft buffer plus write/save-failure
 * surfaces. This is what churns on every keystroke.
 */
export interface NotesDraftsSlice {
  draftsByNodeId: Readonly<Record<NoteId, NotesNodeDraft>>;
  writeError: NotesStoreError | null;
  attachmentUploadErrorsByNodeId?: Readonly<Record<NoteId, string>>;
  attachmentUploadRetryAttemptIdsByNodeId?: Readonly<Record<NoteId, string>>;
  // The live multi-node selection (Phase 4.1). It rides the high-volatility
  // drafts slice — NOT the state slice the memoized rows subscribe to — so
  // extending the range re-renders only the pane, which fans out per-row
  // `isSelected` booleans. See NotesSelection's doc comment. Optional so the
  // many hand-built test workspace fixtures need not spell it out; the hook
  // always populates it and consumers coalesce a missing value to `null`.
  selection?: NotesSelection | null;
  /** Monotonic ownership version for late selected-range postconditions. */
  selectionRevision?: number;
}

/**
 * Stable slice: every action callback. Its identity must stay referentially
 * stable across draft keystrokes and unrelated state changes so that
 * action-only consumers never re-render for data they do not read.
 */
export interface NotesActionsSlice {
  actions: NotesWorkspaceActions;
  retryFailedDraft(nodeId: NoteId): Promise<void>;
  retryLastFailedWrite(): Promise<void>;
  loadActiveNodesForMove?(): Promise<readonly NoteNode[]>;
  prepareMoveNode?(nodeId: NoteId): Promise<NotesPreparedMove>;
  commitPreparedMove?(
    prepared: NotesPreparedMove,
    destinationId: NoteId | null
  ): Promise<NotesPreparedMoveCommitResult>;
  prepareSelectionAuthority?(
    selectedNodeIds: readonly NoteId[]
  ): Promise<NotesPreparedSelectionAuthority>;
  isPreparedSelectionAuthorityCurrent?(
    prepared: NotesPreparedSelectionAuthority
  ): boolean;
  applyPreparedSelectionBatch?(
    prepared: NotesPreparedSelectionAuthority,
    op: NotesBatchOp,
    options?: NotesPreparedSelectionBatchOptions
  ): Promise<NotesBatchCommandSettlement>;
}

export interface NotesPreparedSelectionBatchOptions {
  readonly focusNodeId?: NoteId | null;
  /** Client-only expansion applied only after an authoritative prepared move. */
  readonly expandNodeId?: NoteId;
  /** Navigation epoch captured when the semantic command began. */
  readonly expectedNavigationVersion?: number;
}

export interface UseNotesWorkspaceResult
  extends NotesStateSlice,
    NotesDraftsSlice,
    NotesActionsSlice {
  // Memoized slices for volatility-partitioned context providers. Always
  // populated by the hook; optional so that test fixtures may build the flat
  // shape without them.
  stateSlice?: NotesStateSlice;
  draftsSlice?: NotesDraftsSlice;
  actionsSlice?: NotesActionsSlice;
}

export interface NotesNodeDraft extends Pick<NoteNode, "title" | "note"> {
  revision: number;
  status: "pending" | "failed";
}

/**
 * Stable empty snapshot for the drafts external store before any engine exists
 * (first render) or after teardown. Shared so `getDraftsSnapshot` returns a
 * referentially stable value that never trips `useSyncExternalStore`.
 */
const EMPTY_DRAFTS: Readonly<Record<NoteId, NotesNodeDraft>> = {};

type ImageNodeImportRequest =
  | {
      readonly kind: "paths";
      readonly anchor: ImageNodeInsertionAnchor;
      readonly items: readonly ImportImageNodePathItem[];
    }
  | {
      readonly kind: "bytes";
      readonly anchor: ImageNodeInsertionAnchor;
      readonly items: readonly ImportImageNodeByteItem[];
    };

interface AttachmentUploadAttempt {
  readonly attemptId: string;
  readonly order: number;
  readonly nodeId: NoteId;
  readonly request: ImageNodeImportRequest;
  readonly retainedByteSize: number;
  scope: NotesWorkspaceScope;
  readonly initialMaxDisplayWidth: number;
  readonly historyContext: NotesHistoryContext | null;
  record: NotesWorkspaceSessionRecord;
  readonly orderingTurn: ImageImportOrderingTurn;
  reservation: NotesWorkspaceImageImportReservation | null;
  recoveryOwner: ImageImportRecoveryOwner | null;
  effectiveAnchor: ImageNodeInsertionAnchor | null;
  structuralIntent:
    | NotesWorkspaceSessionRecord["structuralIntents"][number]
    | null;
  enqueueCompletionSettled: boolean;
  detached: boolean;
  started: boolean;
  unknownOutcome: boolean;
  status: "pending" | "failed";
  error: string | null;
}

interface ImageImportRecoveryOwner {
  readonly repository: NotesStore;
  readonly vaultRoot: string;
  readonly session: NotesWorkspaceCoordinatorSession;
  readonly attempts: Map<string, AttachmentUploadAttempt>;
}

interface ImageImportOrderingSequence {
  tail: Promise<void>;
  pendingTurns: number;
}

interface ImageImportOrderingTurn {
  wait(): Promise<void>;
  release(): void;
}

// Structural imports can outlive the hook that created them. Keep their byte
// ownership shared until the retained coordinator closure actually finalizes.
const retainedAttachmentUploadByteAttempts = new Set<AttachmentUploadAttempt>();
const attachmentUploadAttempts = new Set<AttachmentUploadAttempt>();
const imageImportRecoveryOwners = new WeakMap<
  NotesStore,
  Map<string, ImageImportRecoveryOwner>
>();
const imageImportRecoverySubscribers = new WeakMap<
  NotesStore,
  Map<string, Set<() => void>>
>();
const imageImportOrderingSequences = new WeakMap<
  NotesStore,
  Map<string, Map<string, ImageImportOrderingSequence>>
>();

interface NotesDataDeletionVaultState {
  owner: object | null;
  readonly subscribers: Set<() => void>;
  readonly participants: Set<NotesDraftEngine>;
}

let notesDataDeletionStates = new WeakMap<
  NotesStore,
  Map<string, NotesDataDeletionVaultState>
>();

function notesDataDeletionState(
  repository: NotesStore,
  vaultRoot: string,
  create: boolean
): NotesDataDeletionVaultState | null {
  let vaults = notesDataDeletionStates.get(repository);
  if (!vaults && create) {
    vaults = new Map();
    notesDataDeletionStates.set(repository, vaults);
  }
  let state = vaults?.get(vaultRoot);
  if (!state && create) {
    state = {
      owner: null,
      subscribers: new Set(),
      participants: new Set()
    };
    vaults!.set(vaultRoot, state);
  }
  return state ?? null;
}

function maybeDeleteNotesDataDeletionState(
  repository: NotesStore,
  vaultRoot: string,
  state: NotesDataDeletionVaultState
): void {
  if (
    state.owner !== null ||
    state.subscribers.size > 0 ||
    state.participants.size > 0
  ) {
    return;
  }
  const vaults = notesDataDeletionStates.get(repository);
  if (vaults?.get(vaultRoot) !== state) return;
  vaults.delete(vaultRoot);
  if (vaults.size === 0) {
    notesDataDeletionStates.delete(repository);
  }
}

function notifyNotesDataDeletionState(state: NotesDataDeletionVaultState): void {
  for (const subscriber of state.subscribers) {
    subscriber();
  }
}

function reserveNotesDataDeletion(
  repository: NotesStore,
  vaultRoot: string,
  token: object
): boolean {
  const state = notesDataDeletionState(repository, vaultRoot, true)!;
  if (state.owner !== null) return false;
  state.owner = token;
  notifyNotesDataDeletionState(state);
  return true;
}

function releaseNotesDataDeletion(
  repository: NotesStore,
  vaultRoot: string,
  token: object
): void {
  const state = notesDataDeletionState(repository, vaultRoot, false);
  if (state?.owner !== token) return;
  state.owner = null;
  notifyNotesDataDeletionState(state);
  maybeDeleteNotesDataDeletionState(repository, vaultRoot, state);
}

function isNotesDataDeletionInProgress(
  repository: NotesStore,
  vaultRoot: string
): boolean {
  return notesDataDeletionState(repository, vaultRoot, false)?.owner != null;
}

function subscribeToNotesDataDeletion(
  repository: NotesStore,
  vaultRoot: string,
  subscriber: () => void
): () => void {
  const state = notesDataDeletionState(repository, vaultRoot, true)!;
  state.subscribers.add(subscriber);
  return () => {
    state.subscribers.delete(subscriber);
    maybeDeleteNotesDataDeletionState(repository, vaultRoot, state);
  };
}

function registerNotesDataDeletionParticipant(
  repository: NotesStore,
  vaultRoot: string,
  engine: NotesDraftEngine
): () => void {
  const state = notesDataDeletionState(repository, vaultRoot, true)!;
  state.participants.add(engine);
  return () => {
    state.participants.delete(engine);
    maybeDeleteNotesDataDeletionState(repository, vaultRoot, state);
  };
}

function notesDataDeletionParticipants(
  repository: NotesStore,
  vaultRoot: string
): readonly NotesDraftEngine[] {
  return [
    ...(notesDataDeletionState(repository, vaultRoot, false)?.participants ?? [])
  ];
}

function reserveImageImportOrderingTurn(
  repository: NotesStore,
  vaultRoot: string,
  anchor: ImageNodeInsertionAnchor
): ImageImportOrderingTurn {
  let vaults = imageImportOrderingSequences.get(repository);
  if (!vaults) {
    vaults = new Map();
    imageImportOrderingSequences.set(repository, vaults);
  }
  let sequences = vaults.get(vaultRoot);
  if (!sequences) {
    sequences = new Map();
    vaults.set(vaultRoot, sequences);
  }
  const key = JSON.stringify([anchor.parentId, anchor.afterId]);
  let sequence = sequences.get(key);
  if (!sequence) {
    sequence = { tail: Promise.resolve(), pendingTurns: 0 };
    sequences.set(key, sequence);
  }

  const predecessor = sequence.tail;
  let resolveTurn!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  // A turn can be canceled before it reaches the head of the sequence. Its
  // successors must still wait for the unresolved predecessor, even when the
  // canceled turn has already released its own resources.
  sequence.tail = predecessor.then(() => completion);
  sequence.pendingTurns += 1;
  let released = false;

  return {
    wait(): Promise<void> {
      return predecessor;
    },
    release(): void {
      if (released) return;
      released = true;
      sequence!.pendingTurns = Math.max(0, sequence!.pendingTurns - 1);
      resolveTurn();
      if (
        sequence!.pendingTurns === 0 &&
        sequences!.get(key) === sequence
      ) {
        sequences!.delete(key);
        if (sequences!.size === 0) {
          vaults!.delete(vaultRoot);
        }
      }
    }
  };
}

function releaseImageImportReservation(
  attempt: AttachmentUploadAttempt
): void {
  attempt.reservation?.release();
  attempt.reservation = null;
  attempt.orderingTurn.release();
}

function recoveryOwnerFor(
  repository: NotesStore,
  vaultRoot: string,
  create: boolean
): ImageImportRecoveryOwner | null {
  let vaults = imageImportRecoveryOwners.get(repository);
  let owner = vaults?.get(vaultRoot) ?? null;
  if (owner || !create) {
    return owner;
  }
  if (!vaults) {
    vaults = new Map();
    imageImportRecoveryOwners.set(repository, vaults);
  }
  owner = {
    repository,
    vaultRoot,
    session: notesWorkspaceCoordinatorRegistry.openSession({
      repository,
      vaultRoot,
      onEvent() {
        // The recovery session keeps coordinator history and insertion
        // reservations alive. A mounted hook remains the UI event owner.
      }
    }),
    attempts: new Map()
  };
  vaults.set(vaultRoot, owner);
  return owner;
}

function notifyImageImportRecoveryFor(
  repository: NotesStore,
  vaultRoot: string
): void {
  const subscribers = imageImportRecoverySubscribers
    .get(repository)
    ?.get(vaultRoot);
  for (const subscriber of subscribers ?? []) {
    subscriber();
  }
}

function notifyImageImportRecovery(owner: ImageImportRecoveryOwner): void {
  notifyImageImportRecoveryFor(owner.repository, owner.vaultRoot);
}

function retainAttachmentUploadAttemptForRecovery(
  attempt: AttachmentUploadAttempt
): void {
  if (attempt.recoveryOwner) {
    notifyImageImportRecovery(attempt.recoveryOwner);
    return;
  }
  const owner = recoveryOwnerFor(
    attempt.record.repository,
    attempt.record.vaultRoot,
    true
  )!;
  attempt.recoveryOwner = owner;
  owner.attempts.set(attempt.attemptId, attempt);
  notifyImageImportRecovery(owner);
}

function releaseAttachmentUploadRecovery(
  attempt: AttachmentUploadAttempt
): void {
  const owner = attempt.recoveryOwner;
  if (!owner) return;
  owner.attempts.delete(attempt.attemptId);
  notifyImageImportRecovery(owner);
  attempt.recoveryOwner = null;
  if (owner.attempts.size > 0) return;
  owner.session.close();
  const vaults = imageImportRecoveryOwners.get(owner.repository);
  if (vaults?.get(owner.vaultRoot) === owner) {
    vaults.delete(owner.vaultRoot);
    if (vaults.size === 0) {
      imageImportRecoveryOwners.delete(owner.repository);
    }
  }
}

function finalizeAttachmentUploadAttempt(
  attempt: AttachmentUploadAttempt
): void {
  releaseImageImportReservation(attempt);
  retainedAttachmentUploadByteAttempts.delete(attempt);
  attachmentUploadAttempts.delete(attempt);
  releaseAttachmentUploadRecovery(attempt);
}

function recoveredAttachmentUploadAttempts(
  repository: NotesStore,
  vaultRoot: string
): readonly AttachmentUploadAttempt[] {
  return [
    ...(recoveryOwnerFor(repository, vaultRoot, false)?.attempts.values() ?? [])
  ];
}

function subscribeToImageImportRecovery(
  repository: NotesStore,
  vaultRoot: string,
  subscriber: () => void
): () => void {
  let vaults = imageImportRecoverySubscribers.get(repository);
  if (!vaults) {
    vaults = new Map();
    imageImportRecoverySubscribers.set(repository, vaults);
  }
  let subscribers = vaults.get(vaultRoot);
  if (!subscribers) {
    subscribers = new Set();
    vaults.set(vaultRoot, subscribers);
  }
  subscribers.add(subscriber);
  return () => {
    subscribers!.delete(subscriber);
    if (subscribers!.size === 0 && vaults!.get(vaultRoot) === subscribers) {
      vaults!.delete(vaultRoot);
      if (vaults!.size === 0) {
        imageImportRecoverySubscribers.delete(repository);
      }
    }
  };
}

/** Clears module recovery state between deterministic hook tests only. */
export function resetImageImportRecoveryForTests(): void {
  for (const attempt of [...attachmentUploadAttempts]) {
    attempt.detached = true;
    finalizeAttachmentUploadAttempt(attempt);
  }
  notesDataDeletionStates = new WeakMap();
}

function clipboardImageBatchByteSize(
  items: readonly PendingImageNodeByteItem[]
): number | null {
  if (
    items.length === 0 ||
    items.length > MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS
  ) {
    return null;
  }

  let aggregateBytes = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(items, index)) {
      return null;
    }
    const byteSize = items[index]?.blob.size;
    if (
      !Number.isSafeInteger(byteSize) ||
      byteSize <= 0 ||
      byteSize > MAX_NOTE_ATTACHMENT_BYTES
    ) {
      return null;
    }
    aggregateBytes += byteSize;
    if (aggregateBytes > MAX_NOTE_ATTACHMENT_BATCH_BYTES) {
      return null;
    }
  }
  return aggregateBytes;
}

export interface StructuralCommandOptions {
  readonly historyContext?: NotesHistoryContext | null;
  readonly retainHistoryOnFailure?: boolean;
  readonly selectionPolicy?: NotesPendingSelectionPolicy;
}

export function authoritative(
  workspace: NotesWorkspace,
  uiUpdate?: NotesWorkspaceUiUpdate,
  historyStatus?: { canUndo: boolean; canRedo: boolean },
  options?: Pick<
    Extract<NotesWorkspaceQueueResult, { kind: "authoritative" }>,
    | "scopeAgnostic"
    | "committedHistoryEntryIds"
    | "invalidatesTagSummaries"
    | "delta"
  >
): NotesWorkspaceQueueResult {
  return {
    kind: "authoritative",
    workspace,
    uiUpdate,
    historyStatus,
    ...options
  };
}

/**
 * The backend audit delta, relative to the full (unscoped) database. See
 * {@link NotesMutationResult}; the fields arrive together (all present or all
 * absent) whenever the mutation ran under a history context.
 */
export interface RawNotesMutationDelta {
  changedNodes: NoteNode[];
  removedNodeIds: NoteId[];
  changedAttachments: NoteAttachment[];
}

export interface UnwrappedNotesMutation {
  workspace: NotesWorkspace;
  historyEntryId: string | null | undefined;
  historyStatus: NotesHistoryStatus | undefined;
  atomic: boolean;
  delta: RawNotesMutationDelta | null;
  // Only set by `notes_import_subtree` (plan Phase 4.4, paste import): the new
  // root ids in caller order, so the command can focus `importedRootIds[0]`.
  importedRootIds: readonly NoteId[] | undefined;
  // Only set by a batch duplicate: fresh copied roots in source order.
  duplicatedRootIds: readonly NoteId[] | undefined;
}

export function unwrapNotesMutation(
  response: NotesMutationResponse
): UnwrappedNotesMutation {
  if (isNotesMutationResult(response)) {
    // The three delta fields are written as a group; `changedNodes` being
    // present is the signal that the mutation ran with a history context and
    // therefore carries an audit delta.
    const delta =
      response.changedNodes !== undefined
        ? {
            changedNodes: response.changedNodes,
            removedNodeIds: response.removedNodeIds ?? [],
            changedAttachments: response.changedAttachments ?? []
          }
        : null;
    return {
      workspace: response.workspace,
      historyEntryId: response.historyEntryId,
      historyStatus: {
        canUndo: response.canUndo,
        canRedo: response.canRedo
      },
      atomic: true,
      delta,
      importedRootIds: response.importedRootIds,
      duplicatedRootIds: response.duplicatedRootIds
    };
  }
  return {
    workspace: response,
    historyEntryId: undefined,
    historyStatus: undefined,
    atomic: false,
    delta: null,
    importedRootIds: undefined,
    duplicatedRootIds: undefined
  };
}

/**
 * Reconcile the backend's full-database audit delta into a delta that is
 * consistent with the *active* scope's projected store. Active membership is
 * exactly `deletedAt === null && archivedAt === null`, so any changed node that
 * gained a `deletedAt`/`archivedAt` timestamp has left the active scope and is
 * recorded as a removal instead of an upsert; attachments of removed nodes are
 * dropped alongside them.
 *
 * Returns `undefined` when there is nothing to patch — including the
 * attachment-removal case, whose audit delta is empty because deleted
 * attachment rows are never surfaced (see history.rs). An empty delta falls
 * back to full normalization, which correctly reflects the removal.
 */
export function scopedActiveDelta(
  raw: RawNotesMutationDelta | null
): NotesWorkspaceDelta | undefined {
  if (!raw) {
    return undefined;
  }
  const removedNodeIds = [...raw.removedNodeIds];
  const removedSet = new Set(removedNodeIds);
  const changedNodes: NoteNode[] = [];
  for (const node of raw.changedNodes) {
    if (node.deletedAt !== null || node.archivedAt !== null) {
      if (!removedSet.has(node.id)) {
        removedNodeIds.push(node.id);
        removedSet.add(node.id);
      }
    } else {
      changedNodes.push(node);
    }
  }
  const changedAttachments = raw.changedAttachments.filter(
    (attachment) => !removedSet.has(attachment.nodeId)
  );
  if (
    changedNodes.length === 0 &&
    removedNodeIds.length === 0 &&
    changedAttachments.length === 0
  ) {
    return undefined;
  }
  return { changedNodes, removedNodeIds, changedAttachments };
}

/**
 * The delta is safe to forward to the reducer only when the projection did not
 * re-scope the mutation workspace: for the active scope {@link workspaceForScope}
 * returns the mutation workspace by reference, so identity equality is a precise
 * "this is the unprojected active workspace" signal. Any non-active scope loads
 * a fresh workspace (new reference, different parent linkage) and must fall back
 * to full normalization.
 */
function forwardableActiveDelta(
  mutation: UnwrappedNotesMutation,
  projection: ProjectedNotesMutation
): NotesWorkspaceDelta | undefined {
  if (
    projection.projectionError !== undefined ||
    projection.workspace !== mutation.workspace
  ) {
    return undefined;
  }
  return scopedActiveDelta(mutation.delta);
}

export function appliedHistoryContext(
  context: NotesHistoryContext | null | undefined,
  mutation: UnwrappedNotesMutation
): NotesHistoryContext | null | undefined {
  if (!mutation.atomic) {
    return context;
  }
  return context?.entryId === mutation.historyEntryId ? context : null;
}

export function historyArguments(
  context: NotesHistoryContext | null | undefined
): [] | [NotesHistoryContext] {
  return context ? [context] : [];
}

function supportsHistory(repository: NotesStore): boolean {
  return repository.undo !== undefined && repository.redo !== undefined;
}

export function expansionsOutsideSubtree(
  current: ReadonlySet<NoteId>,
  workspace: NotesWorkspace,
  subtreeRootId: NoteId
): Set<NoteId> {
  const nodesById = Object.fromEntries(
    workspace.nodes.map((node) => [node.id, node])
  ) as Record<NoteId, NoteNode>;
  const next = new Set(current);
  for (const candidateId of current) {
    let candidate: NoteNode | undefined = nodesById[candidateId];
    const visited = new Set<NoteId>();
    while (candidate && !visited.has(candidate.id)) {
      if (candidate.id === subtreeRootId) {
        next.delete(candidateId);
        break;
      }
      visited.add(candidate.id);
      candidate = candidate.parentId
        ? nodesById[candidate.parentId]
        : undefined;
    }
  }
  return next;
}

export function samePreparedMoveNode(
  prepared: NoteNode | undefined,
  current: NoteNode | undefined
): boolean {
  return Boolean(
    prepared &&
      current &&
      prepared.id === current.id &&
      prepared.parentId === current.parentId &&
      prepared.sortKey === current.sortKey &&
      prepared.title === current.title &&
      prepared.note === current.note &&
      prepared.layoutMode === current.layoutMode &&
      prepared.isCollapsed === current.isCollapsed &&
      prepared.isStarred === current.isStarred &&
      prepared.completedAt === current.completedAt &&
      prepared.createdAt === current.createdAt &&
      prepared.updatedAt === current.updatedAt &&
      prepared.deletedAt === current.deletedAt &&
      prepared.archivedAt === current.archivedAt &&
      prepared.archiveRootId === current.archiveRootId
  );
}

export async function workspaceForScope(
  context: NotesWorkspaceQueueContext,
  mutationWorkspace: NotesWorkspace,
  scope: NotesWorkspaceScope
): Promise<NotesWorkspace> {
  return scope.kind === "active"
    ? mutationWorkspace
    : context.repository.loadWorkspace(context.vaultRoot, scope);
}

export interface ProjectedNotesMutation {
  workspace: NotesWorkspace;
  projectionError?: string;
}

export async function projectNotesMutation(
  context: NotesWorkspaceQueueContext,
  mutation: UnwrappedNotesMutation,
  scope: NotesWorkspaceScope
): Promise<ProjectedNotesMutation> {
  try {
    return {
      workspace: await workspaceForScope(context, mutation.workspace, scope)
    };
  } catch (cause) {
    if (!mutation.atomic) {
      throw cause;
    }
    return {
      workspace: mutation.workspace,
      projectionError: errorMessage(cause)
    };
  }
}

export function directMutationResult(
  mutation: UnwrappedNotesMutation,
  projection: ProjectedNotesMutation,
  uiUpdate?: NotesWorkspaceUiUpdate,
  broadcastScope?: NotesWorkspaceScope
): NotesWorkspaceQueueResult {
  if (!projection.projectionError) {
    const result = authoritative(
      projection.workspace,
      uiUpdate,
      mutation.historyStatus,
      {
        invalidatesTagSummaries: true,
        delta: forwardableActiveDelta(mutation, projection)
      }
    );
    return broadcastScope && result.kind === "authoritative"
      ? { ...result, broadcastScope: cloneWorkspaceScope(broadcastScope) }
      : result;
  }
  return {
    kind: "failure",
    error: projection.projectionError,
    workspace: projection.workspace,
    uiUpdate,
    historyStatus: mutation.historyStatus,
    scopeAgnostic: true,
    ...(broadcastScope
      ? { broadcastScope: cloneWorkspaceScope(broadcastScope) }
      : {}),
    invalidatesTagSummaries: true,
    ...(mutation.historyEntryId
      ? { committedHistoryEntryIds: [mutation.historyEntryId] }
      : {})
  };
}

export interface NotesWorkspaceQueueStep {
  run(): Promise<NotesMutationResponse>;
  historyEntryId?: string;
}

interface BufferedWorkspaceCommand {
  work: NotesWorkspaceQueueWork;
  structural?: boolean;
  selectionPolicy?: NotesPendingSelectionPolicy;
  resolve(outcome: NotesWorkspaceCommandOutcome): void;
}

interface SearchNavigation {
  rootId: NoteId;
  expandedNodeIds: Set<NoteId>;
}

export interface LiveNotesNavigation {
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  pendingFocusField: NotesHistoryFocusField | null;
}

export interface TagFilterOrigin {
  scope: NotesWorkspaceScope;
  libraryView: Exclude<NotesLibraryView, "tags">;
  navigation: LiveNotesNavigation;
  locallyExpandedNodeIds: ReadonlySet<NoteId>;
}

interface TagSummaryRefreshWaiter {
  version: number;
  resolve(summaries: readonly NoteTagSummary[] | null): void;
}

function resolveBufferedCommands(commands: BufferedWorkspaceCommand[]): void {
  for (const command of commands) {
    // Draining without a live session drops the command, so its caller learns
    // the work was skipped rather than committed.
    command.resolve("skipped");
  }
}

function enqueueBufferedCommands(
  session: NotesWorkspaceCoordinatorSession,
  commands: BufferedWorkspaceCommand[]
): void {
  for (const command of commands) {
    let completion: Promise<NotesWorkspaceCommandOutcome>;
    try {
      completion = command.structural
        ? session.enqueueStructural(command.work, {
            selectionPolicy: command.selectionPolicy
          })
        : session.enqueue(command.work);
    } catch {
      command.resolve("skipped");
      continue;
    }
    void completion.then(command.resolve, () => command.resolve("failed"));
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function scopeForLibraryView(
  view: Exclude<NotesLibraryView, "tags">
): NotesWorkspaceScope {
  switch (view) {
    case "all":
      return { kind: "active" };
    case "starred":
      return { kind: "starred" };
    case "recent":
      return { kind: "recent" };
    case "archive":
      return { kind: "archive" };
    case "trash":
      return { kind: "trash" };
  }
}

// Scope equality and tag-filter canonicalization live in one module so the
// coordinator and this hook compare scopes the same, key-order-independent way.
// Re-exported (below) because existing consumers (notesCommands, tests) import
// these names from the hook module.
export { canonicalizeTagFilters, sameScope, tagFilterKey };

function cloneWorkspaceScope(scope: NotesWorkspaceScope): NotesWorkspaceScope {
  return scope.kind === "tags"
    ? { kind: "tags", tags: canonicalizeTagFilters(scope.tags) }
    : { ...scope };
}

function freezeActiveAuthorityWorkspace(
  workspace: NotesWorkspace
): NormalizedNotesWorkspace {
  const nodes = workspace.nodes.map((node) => Object.freeze({ ...node }));
  const attachmentsByNodeId = Object.fromEntries(
    Object.entries(workspace.attachmentsByNodeId ?? {}).map(
      ([nodeId, attachments]) => [
        nodeId,
        attachments.map((item) => Object.freeze({ ...item }))
      ]
    )
  );
  const normalized = normalizeWorkspace({ nodes, attachmentsByNodeId });
  for (const childIds of Object.values(normalized.childIdsByParent)) {
    Object.freeze(childIds);
  }
  for (const attachments of Object.values(
    normalized.attachmentsByNodeId
  )) {
    Object.freeze(attachments);
  }
  Object.freeze(normalized.nodesById);
  Object.freeze(normalized.childIdsByParent);
  Object.freeze(normalized.rootIds);
  Object.freeze(normalized.attachmentsByNodeId);
  return Object.freeze(normalized);
}

function libraryStateForScope(scope: NotesWorkspaceScope): {
  view: Exclude<NotesLibraryView, "tags"> | "tags";
  filters: readonly NoteTagFilter[];
} {
  switch (scope.kind) {
    case "active":
      return { view: "all", filters: [] };
    case "starred":
      return { view: "starred", filters: [] };
    case "recent":
      return { view: "recent", filters: [] };
    case "archive":
      return { view: "archive", filters: [] };
    case "trash":
      return { view: "trash", filters: [] };
    case "tag": {
      const filter = noteTagFilterFromLegacyScope(scope.tag);
      return {
        view: "tags",
        filters: filter ? [filter] : []
      };
    }
    case "tags":
      return { view: "tags", filters: canonicalizeTagFilters(scope.tags) };
  }
}

function restoredTagFilterNavigation(
  workspace: NotesWorkspace,
  origin: TagFilterOrigin
): { uiUpdate: NotesWorkspaceUiUpdate; expandedNodeIds: ReadonlySet<NoteId> } {
  const normalized = normalizeWorkspace(workspace);
  const existing = (nodeId: NoteId | null): NoteId | null | undefined =>
    nodeId === null
      ? null
      : normalized.nodesById[nodeId]
        ? nodeId
        : undefined;
  const fallbackId = normalized.rootIds[0] ?? null;
  const restoredZoomRootId = existing(origin.navigation.zoomRootId);
  const zoomRootId =
    restoredZoomRootId === undefined ? fallbackId : restoredZoomRootId;
  const restoredSelectedId = existing(origin.navigation.selectedId);
  const selectedId =
    restoredSelectedId === undefined ? zoomRootId ?? fallbackId : restoredSelectedId;
  const editingNoteId = existing(origin.navigation.editingNoteId) ?? null;
  const pendingFocusId = existing(origin.navigation.pendingFocusId) ?? null;
  return {
    uiUpdate: {
      selectedId,
      zoomRootId,
      editingNoteId,
      pendingFocusId,
      pendingFocusField:
        pendingFocusId === null ? null : origin.navigation.pendingFocusField
    },
    expandedNodeIds: new Set(
      [...origin.locallyExpandedNodeIds].filter((nodeId) =>
        Boolean(normalized.nodesById[nodeId])
      )
    )
  };
}

function searchNavigation(
  workspace: NotesWorkspace,
  nodeId: NoteId
): SearchNavigation | null {
  const normalized = normalizeWorkspace(workspace);
  if (!normalized.nodesById[nodeId]) {
    return null;
  }
  const trail: NoteId[] = [];
  const visited = new Set<NoteId>();
  let currentId: NoteId | null = nodeId;
  while (currentId !== null && !visited.has(currentId)) {
    const node: NoteNode | undefined = normalized.nodesById[currentId];
    if (!node) {
      return null;
    }
    visited.add(currentId);
    trail.push(currentId);
    currentId = node.parentId;
  }
  const orderedTrail = trail.reverse();
  const rootId = orderedTrail[0];
  if (!rootId) {
    return null;
  }
  return {
    rootId,
    expandedNodeIds: new Set(
      orderedTrail
        .slice(0, -1)
        .filter((id) => normalized.nodesById[id]?.isCollapsed)
    )
  };
}

export async function runCompoundQueueWork(
  context: NotesWorkspaceQueueContext,
  steps: NotesWorkspaceQueueStep[],
  uiUpdate?: NotesWorkspaceUiUpdate,
  scope: NotesWorkspaceScope = { kind: "active" }
): Promise<NotesWorkspaceQueueResult> {
  let workspace = context.confirmedWorkspace;
  let hasAuthoritativeStep = false;
  let historyStatus: NotesHistoryStatus | undefined;
  let stepCount = 0;
  let lastMutation: UnwrappedNotesMutation | null = null;
  const committedHistoryEntryIds: string[] = [];

  try {
    for (const step of steps) {
      const mutation = unwrapNotesMutation(await step.run());
      workspace = mutation.workspace;
      hasAuthoritativeStep = true;
      stepCount += 1;
      lastMutation = mutation;
      historyStatus = mutation.historyStatus ?? historyStatus;
      const committedHistoryEntryId = mutation.atomic
        ? mutation.historyEntryId
        : step.historyEntryId;
      if (
        committedHistoryEntryId &&
        !committedHistoryEntryIds.includes(committedHistoryEntryId)
      ) {
        committedHistoryEntryIds.push(committedHistoryEntryId);
      }
    }
    const projectedWorkspace = await workspaceForScope(context, workspace, scope);
    // Forward the delta only for a single-step compound on the active scope:
    // multi-step deltas span intermediate DB states and cannot be trusted as a
    // single incremental patch, and a re-scoped projection breaks the raw
    // delta's parent linkage. `projectedWorkspace === workspace` holds iff the
    // active scope returned the mutation workspace unprojected.
    const delta =
      stepCount === 1 && lastMutation && projectedWorkspace === workspace
        ? scopedActiveDelta(lastMutation.delta)
        : undefined;
    return authoritative(
      projectedWorkspace,
      uiUpdate,
      historyStatus,
      committedHistoryEntryIds.length > 0
        ? { committedHistoryEntryIds, invalidatesTagSummaries: true, delta }
        : { invalidatesTagSummaries: true, delta }
    );
  } catch (cause) {
    if (hasAuthoritativeStep && scope.kind !== "active") {
      workspace = context.confirmedWorkspace;
      try {
        workspace = await context.repository.loadWorkspace(
          context.vaultRoot,
          scope
        );
      } catch {
        // The last confirmed projection still belongs to the selected scope.
      }
    }
    return {
      kind: "failure",
      error: errorMessage(cause),
      ...(hasAuthoritativeStep ? { workspace } : {}),
      ...(historyStatus ? { historyStatus } : {}),
      ...(hasAuthoritativeStep ? { invalidatesTagSummaries: true } : {}),
      ...(committedHistoryEntryIds.length > 0
        ? { committedHistoryEntryIds }
        : {})
    };
  }
}

export function notifySuccess(callback: (() => void) | undefined): void {
  if (!callback) {
    return;
  }
  try {
    callback();
  } catch {
    // Local completion handlers cannot change an authoritative queue result.
  }
}

export function confirmedState(
  context: NotesWorkspaceQueueContext
): NormalizedNotesWorkspace {
  return normalizeWorkspace(context.confirmedWorkspace);
}

export function focusedUiUpdate(
  focusNodeId: NoteId | null | undefined
): NotesWorkspaceUiUpdate | undefined {
  return focusNodeId == null
    ? undefined
    : {
        selectedId: focusNodeId,
        editingNoteId: focusNodeId,
        pendingFocusId: focusNodeId,
        pendingFocusField: "title"
      };
}

export function duplicateRootId(
  before: NormalizedNotesWorkspace,
  after: NotesWorkspace,
  sourceId: NoteId
): NoteId | null {
  const source = before.nodesById[sourceId];
  if (!source) {
    return null;
  }
  return (
    after.nodes.find(
      (node) =>
        node.parentId === source.parentId && !before.nodesById[node.id]
    )?.id ?? null
  );
}

export interface NotesLifecycleNavigationSnapshot {
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  pendingFocusField: NotesHistoryFocusField | null;
  locallyExpandedNodeIds: ReadonlySet<NoteId>;
  scope: NotesWorkspaceScope;
}

export interface NotesLifecycleNavigationTransition {
  before: NotesLifecycleNavigationSnapshot;
  after: NotesLifecycleNavigationSnapshot;
}

export function rootIdForNode(
  workspace: NormalizedNotesWorkspace,
  nodeId: NoteId | null
): NoteId | null {
  let currentId = nodeId;
  const visited = new Set<NoteId>();
  while (currentId !== null && !visited.has(currentId)) {
    const node = workspace.nodesById[currentId];
    if (!node) {
      return null;
    }
    if (node.parentId === null) {
      return node.id;
    }
    visited.add(currentId);
    currentId = node.parentId;
  }
  return null;
}

function fallbackRootAfterRemoval(
  beforeRootIds: readonly NoteId[],
  afterRootIds: readonly NoteId[],
  removedRootId: NoteId
): NoteId | null {
  const removedIndex = beforeRootIds.indexOf(removedRootId);
  const remaining = new Set(afterRootIds);
  if (removedIndex < 0) {
    return afterRootIds[0] ?? null;
  }
  for (let index = removedIndex + 1; index < beforeRootIds.length; index += 1) {
    const candidate = beforeRootIds[index];
    if (remaining.has(candidate)) {
      return candidate;
    }
  }
  for (let index = removedIndex - 1; index >= 0; index -= 1) {
    const candidate = beforeRootIds[index];
    if (remaining.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveRootLifecycleNavigation(
  beforeWorkspace: NormalizedNotesWorkspace,
  afterWorkspace: NormalizedNotesWorkspace,
  removedRootId: NoteId,
  before: NotesLifecycleNavigationSnapshot
): NotesLifecycleNavigationTransition {
  const openRootId = rootIdForNode(beforeWorkspace, before.zoomRootId);
  if (openRootId !== removedRootId) {
    const existing = (nodeId: NoteId | null) =>
      nodeId !== null && afterWorkspace.nodesById[nodeId] ? nodeId : null;
    const pendingFocusId = existing(before.pendingFocusId);
    return {
      before,
      after: {
        ...before,
        selectedId: existing(before.selectedId),
        zoomRootId: existing(before.zoomRootId),
        editingNoteId: existing(before.editingNoteId),
        pendingFocusId,
        pendingFocusField:
          pendingFocusId === null ? null : before.pendingFocusField,
        locallyExpandedNodeIds: new Set(
          [...before.locallyExpandedNodeIds].filter(
            (nodeId) => afterWorkspace.nodesById[nodeId]
          )
        )
      }
    };
  }

  const fallbackRootId = fallbackRootAfterRemoval(
    beforeWorkspace.rootIds,
    afterWorkspace.rootIds,
    removedRootId
  );
  const fallbackRoot = fallbackRootId
    ? afterWorkspace.nodesById[fallbackRootId]
    : undefined;
  const focusFallback =
    fallbackRoot !== undefined &&
    fallbackRoot.deletedAt === null;
  return {
    before,
    after: {
      ...before,
      selectedId: fallbackRootId,
      zoomRootId: fallbackRootId,
      editingNoteId: focusFallback ? fallbackRootId : null,
      pendingFocusId: focusFallback ? fallbackRootId : null,
      pendingFocusField:
        focusFallback ? before.pendingFocusField ?? "title" : null,
      locallyExpandedNodeIds: new Set()
    }
  };
}

export function hasMoveDependencies(
  workspace: NormalizedNotesWorkspace,
  input: MoveNoteNodeInput
): boolean {
  return Boolean(
    workspace.nodesById[input.id] &&
      (input.parentId === null || workspace.nodesById[input.parentId]) &&
      (input.afterId === null || workspace.nodesById[input.afterId]) &&
      (input.beforeId == null || workspace.nodesById[input.beforeId])
  );
}

export function useNotesWorkspace({
  vaultRoot,
  repository,
  attachmentUi = nativeNotesAttachmentUi
}: UseNotesWorkspaceOptions): UseNotesWorkspaceResult {
  const [state, dispatch] = useReducer(
    notesWorkspaceReducer,
    undefined,
    (): NormalizedNotesWorkspace => ({
      ...normalizeWorkspace({ nodes: [] }),
      status: "loading"
    })
  );
  // Multi-node selection lives in its own reducer, off the workspace projection,
  // so extending the range never re-renders the memoized rows (which read the
  // workspace off the state context but never the selection). It is exposed
  // through the high-volatility drafts slice; see NotesSelection's doc comment.
  const [selection, dispatchSelection] = useReducer(notesSelectionReducer, null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selectionRevisionRef = useRef(0);
  const selectionPreparationTokenRef = useRef(0);
  const [libraryView, setLibraryView] = useState<NotesLibraryView>("all");
  const libraryViewRef = useRef(libraryView);
  libraryViewRef.current = libraryView;
  const [activeTagFilters, setActiveTagFilters] = useState<
    readonly NoteTagFilter[]
  >([]);
  const [tagSummaries, setTagSummaries] = useState<readonly NoteTagSummary[]>([]);
  const tagSummaryRequestedVersionRef = useRef(0);
  const tagSummarySettledVersionRef = useRef(0);
  const tagSummaryRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const tagSummaryRefreshWaitersRef = useRef<TagSummaryRefreshWaiter[]>([]);
  const pumpTagSummaryRefreshRef = useRef<(() => void) | null>(null);
  const [locallyExpandedNodeIds, setLocallyExpandedNodeIds] = useState<
    ReadonlySet<NoteId>
  >(() => new Set());
  const [attachmentUploadErrorsByNodeId, setAttachmentUploadErrorsByNodeId] =
    useState<Readonly<Record<NoteId, string>>>({});
  const [
    attachmentUploadRetryAttemptIdsByNodeId,
    setAttachmentUploadRetryAttemptIdsByNodeId
  ] = useState<Readonly<Record<NoteId, string>>>({});
  const attachmentUploadAttemptsByNodeIdRef = useRef(
    new Map<NoteId, Map<string, AttachmentUploadAttempt>>()
  );
  const attachmentUploadAttemptOrderRef = useRef(0);
  const imageImportMaxDisplayWidthRef = useRef<number | null>(null);
  const subscribeNotesDataDeletion = useCallback(
    (subscriber: () => void): (() => void) =>
      subscribeToNotesDataDeletion(repository, vaultRoot, subscriber),
    [repository, vaultRoot]
  );
  const getNotesDataDeletionSnapshot = useCallback(
    (): boolean => isNotesDataDeletionInProgress(repository, vaultRoot),
    [repository, vaultRoot]
  );
  const deletingNotesData = useSyncExternalStore(
    subscribeNotesDataDeletion,
    getNotesDataDeletionSnapshot,
    getNotesDataDeletionSnapshot
  );
  const [historyStatus, setHistoryStatus] = useState({
    canUndo: false,
    canRedo: false
  });
  const activeScopeRef = useRef<NotesWorkspaceScope>({ kind: "active" });
  const activeWorkspaceGenerationRef = useRef(0);
  const movePreparationTokenRef = useRef(0);
  const vaultRootRef = useRef(vaultRoot);
  vaultRootRef.current = vaultRoot;
  const attachmentActionGenerationRef = useRef({ repository, vaultRoot });
  if (
    attachmentActionGenerationRef.current.repository !== repository ||
    attachmentActionGenerationRef.current.vaultRoot !== vaultRoot
  ) {
    attachmentActionGenerationRef.current = { repository, vaultRoot };
  }
  const attachmentActionGeneration = attachmentActionGenerationRef.current;
  const requestedTagFiltersRef = useRef<readonly NoteTagFilter[]>([]);
  const tagFilterOriginRef = useRef<TagFilterOrigin | null>(null);
  const tagFilterRequestRef = useRef(0);
  const locallyExpandedNodeIdsRef = useRef<ReadonlySet<NoteId>>(new Set());
  // The reducer is the sole owner of settled navigation (selection, zoom root,
  // expansion, pending focus). `stateRef` is its synchronous mirror: `dispatch`
  // is wrapped by `applyAction` (below), which runs the reducer against this ref
  // before scheduling React, so callbacks and in-flight commands read the same
  // "settled + just-committed" navigation the render will show — no separate
  // live-navigation owner. The render-phase resync keeps the two in lockstep
  // across renders triggered by unrelated state (drafts, tag summaries, …).
  const stateRef = useRef(state);
  stateRef.current = state;
  // The one piece of navigation the reducer cannot own: which field of the
  // node currently being edited holds the caret. Tracking it in the reducer
  // would dispatch (and re-render every row) on each keystroke, so it lives in
  // this single-purpose ref, written only by `setDraftEditingNavigation` and
  // read only when capturing a history "before" snapshot. It overlays the
  // settled focus field while its node is still the editing node.
  const editingFocusRef = useRef<NotesHistoryFocus | null>(null);
  const navigationVersionRef = useRef(0);
  const sessionRef = useRef<NotesWorkspaceCoordinatorSession | null>(null);
  const historyOwnerByEntryIdRef = useRef(
    createNotesHistoryOwnerRegistry<NotesWorkspaceCoordinatorSession>(200)
  );
  const sessionRecordRef = useRef<NotesWorkspaceSessionRecord | null>(null);
  const draftEngineRef = useRef<NotesDraftEngine | null>(null);
  const draftsListenersRef = useRef(new Set<() => void>());
  const writeErrorListenersRef = useRef(new Set<() => void>());
  const bufferedCommandsRef = useRef<BufferedWorkspaceCommand[]>([]);
  const finalCleanupTokenRef = useRef<object | null>(null);
  const attachmentRecoveryChangeRef = useRef<() => void>(() => undefined);
  const closedRef = useRef(false);

  /**
   * Single synchronous selection write path. The monotonic revision changes
   * with every effective selection action, letting an async command apply its
   * postcondition only if the user has not changed the range meanwhile.
   */
  const updateSelection = useCallback(
    (
      action: NotesSelectionAction,
      expectedRevision?: number
    ): boolean => {
      if (
        expectedRevision !== undefined &&
        selectionRevisionRef.current !== expectedRevision
      ) {
        return false;
      }
      const previous = selectionRef.current;
      const next = notesSelectionReducer(previous, action);
      if (next === previous) {
        return false;
      }
      selectionRef.current = next;
      selectionRevisionRef.current += 1;
      dispatchSelection(action);
      return true;
    },
    []
  );

  // Every reducer action flows through here. Running the reducer against the
  // synchronous mirror first (with the same pure reducer React will run on
  // commit) keeps `stateRef` ahead of the render, so navigation reads never
  // observe a stale value even before React re-renders. It also retires the
  // live editing caret whenever the reducer authoritatively moves somewhere
  // else. A settle that catches the reducer up to the same live editor keeps
  // that caret; pure zoom and silent draft settles do as well.
  const applyAction = useCallback(
    (action: NotesWorkspaceReducerAction): void => {
      const previous = stateRef.current;
      const next = notesWorkspaceReducer(previous, action);
      stateRef.current = next;
      const liveEditingFocus = editingFocusRef.current;
      const liveEditingNodeWasRemoved =
        liveEditingFocus !== null &&
        next.nodesById[liveEditingFocus.nodeId] === undefined;
      const settlesToLiveEditingFocus =
        liveEditingFocus !== null &&
        next.selectedId === liveEditingFocus.nodeId &&
        next.editingNoteId === liveEditingFocus.nodeId &&
        (next.pendingFocusId === null ||
          (next.pendingFocusId === liveEditingFocus.nodeId &&
            (next.pendingFocusField ?? "title") === liveEditingFocus.field));
      if (
        liveEditingNodeWasRemoved ||
        ((next.selectedId !== previous.selectedId ||
          next.editingNoteId !== previous.editingNoteId ||
          next.pendingFocusField !== previous.pendingFocusField) &&
          !settlesToLiveEditingFocus)
      ) {
        editingFocusRef.current = null;
      }
      dispatch(action);
      // Navigation invalidates any live selection range: caret moves
      // (focusNode), zoom (setZoomRoot), and scope reload/init
      // (startWorkspaceLoad) all drop it. Structural-command loading applies
      // its command-specific selection policy in the coordinator event handler.
      if (
        selectionRef.current !== null &&
        (action.type === "focusNode" ||
          action.type === "setZoomRoot" ||
          action.type === "startWorkspaceLoad")
      ) {
        updateSelection({ type: "clearSelection" });
      }
    },
    [updateSelection]
  );

  // The single derivation of "current navigation": settled reducer state, with
  // the live editing caret overlaid. The caret can lead the reducer — a node is
  // editable (and typed into) before any focus/command settles a selection for
  // it — so while the overlay is live it owns selection/editing-node/field;
  // zoom root and pending focus stay with the reducer. `applyAction` drops the
  // overlay the moment the reducer authoritatively moves editing, so a stale
  // caret never leaks in. This is the one place the caret ref and the reducer
  // are combined; every former `liveNavigationRef.current` read routes here.
  const currentNavigation = useCallback((): LiveNotesNavigation => {
    const settled = stateRef.current;
    const editing = editingFocusRef.current;
    return {
      selectedId: editing ? editing.nodeId : settled.selectedId,
      zoomRootId: settled.zoomRootId,
      editingNoteId: editing ? editing.nodeId : settled.editingNoteId,
      pendingFocusId: settled.pendingFocusId,
      pendingFocusField: editing ? editing.field : settled.pendingFocusField
    };
  }, []);
  const currentEditingFocus = useCallback(
    (): NotesHistoryFocus | null => editingFocusRef.current,
    []
  );

  // The draft engine is the external store behind the drafts slice. A stable
  // subscribe/getSnapshot pair reads whichever engine is currently active so
  // the store facade survives vault switches without resubscribing.
  const subscribeDrafts = useCallback((listener: () => void): (() => void) => {
    draftsListenersRef.current.add(listener);
    return () => {
      draftsListenersRef.current.delete(listener);
    };
  }, []);
  const getDraftsSnapshot = useCallback(
    (): Readonly<Record<NoteId, NotesNodeDraft>> =>
      draftEngineRef.current?.getDraftsSnapshot() ?? EMPTY_DRAFTS,
    []
  );
  const draftsByNodeId = useSyncExternalStore(subscribeDrafts, getDraftsSnapshot);
  const subscribeWriteError = useCallback(
    (listener: () => void): (() => void) => {
      writeErrorListenersRef.current.add(listener);
      return () => {
        writeErrorListenersRef.current.delete(listener);
      };
    },
    []
  );
  const getWriteErrorSnapshot = useCallback(
    (): NotesStoreError | null =>
      draftEngineRef.current?.getWriteErrorSnapshot() ?? null,
    []
  );
  const currentWriteError = useSyncExternalStore(
    subscribeWriteError,
    getWriteErrorSnapshot
  );
  const notifyDraftsListeners = useCallback((): void => {
    for (const listener of draftsListenersRef.current) {
      listener();
    }
  }, []);
  const notifyWriteErrorListeners = useCallback((): void => {
    for (const listener of writeErrorListenersRef.current) {
      listener();
    }
  }, []);

  const releaseFinalizedDetachedAttachmentUploadAttempts = useCallback(
    (record: NotesWorkspaceSessionRecord): void => {
      for (const attempt of attachmentUploadAttempts) {
        if (
          attempt.record === record &&
          attempt.detached &&
          !attempt.started &&
          !attempt.unknownOutcome &&
          attempt.enqueueCompletionSettled &&
          (attempt.structuralIntent === null ||
            !record.structuralIntents.includes(attempt.structuralIntent))
        ) {
          retainedAttachmentUploadByteAttempts.delete(attempt);
          attachmentUploadAttempts.delete(attempt);
          releaseAttachmentUploadRecovery(attempt);
        }
      }
    },
    []
  );

  const prepareAttachmentUploadAttemptsForTeardown = useCallback((): void => {
    for (const attempts of attachmentUploadAttemptsByNodeIdRef.current.values()) {
      for (const attempt of attempts.values()) {
        if (!attempt.started && !attempt.unknownOutcome) continue;
        attempt.detached = true;
        retainAttachmentUploadAttemptForRecovery(attempt);
      }
    }
  }, []);

  const discardAttachmentUploadAttempts = useCallback((): void => {
    const detachedRecords = new Set<NotesWorkspaceSessionRecord>();
    for (const attempts of attachmentUploadAttemptsByNodeIdRef.current.values()) {
      for (const attempt of attempts.values()) {
        const context = attempt.historyContext;
        if (attempt.status === "pending") {
          attempt.detached = true;
          detachedRecords.add(attempt.record);
        }
        if (attempt.started || attempt.unknownOutcome) {
          attempt.detached = true;
          retainAttachmentUploadAttemptForRecovery(attempt);
          continue;
        }
        releaseImageImportReservation(attempt);
        if (attempt.enqueueCompletionSettled) {
          retainedAttachmentUploadByteAttempts.delete(attempt);
          attachmentUploadAttempts.delete(attempt);
        }
        if (context) {
          historyOwnerByEntryIdRef.current
            .owner(context.entryId)
            ?.history.discard(context.entryId);
          historyOwnerByEntryIdRef.current.discard(context.entryId);
        }
      }
    }
    attachmentUploadAttemptsByNodeIdRef.current.clear();
    for (const record of detachedRecords) {
      releaseFinalizedDetachedAttachmentUploadAttempts(record);
    }
  }, [releaseFinalizedDetachedAttachmentUploadAttempts]);

  const settleTagSummaryRefreshWaiters = useCallback(
    (version: number, summaries: readonly NoteTagSummary[] | null): void => {
      const settled: TagSummaryRefreshWaiter[] = [];
      const pending: TagSummaryRefreshWaiter[] = [];
      for (const waiter of tagSummaryRefreshWaitersRef.current) {
        (waiter.version <= version ? settled : pending).push(waiter);
      }
      tagSummaryRefreshWaitersRef.current = pending;
      for (const waiter of settled) {
        waiter.resolve(summaries);
      }
    },
    []
  );

  const pumpTagSummaryRefresh = useCallback((): void => {
    if (tagSummaryRefreshPromiseRef.current) {
      return;
    }
    let completion!: Promise<void>;
    completion = (async () => {
      while (
        tagSummarySettledVersionRef.current <
        tagSummaryRequestedVersionRef.current
      ) {
        const version = tagSummaryRequestedVersionRef.current;
        const record = sessionRecordRef.current;
        const session = record?.session ?? null;
        let summaries: readonly NoteTagSummary[] | null = null;
        if (
          record &&
          !record.closing &&
          sessionRef.current === session
        ) {
          try {
            summaries = await record.repository.listTagsWithCounts(
              record.vaultRoot
            );
          } catch {
            summaries = null;
          }
        }

        tagSummarySettledVersionRef.current = Math.max(
          tagSummarySettledVersionRef.current,
          version
        );
        if (version !== tagSummaryRequestedVersionRef.current) {
          continue;
        }
        const recordStillCurrent =
          record !== null &&
          !record.closing &&
          sessionRecordRef.current === record &&
          sessionRef.current === session;
        if (recordStillCurrent && summaries) {
          setTagSummaries(summaries);
        }
        settleTagSummaryRefreshWaiters(
          version,
          recordStillCurrent ? summaries : null
        );
      }
    })().finally(() => {
      if (tagSummaryRefreshPromiseRef.current !== completion) {
        return;
      }
      tagSummaryRefreshPromiseRef.current = null;
      if (
        tagSummarySettledVersionRef.current <
        tagSummaryRequestedVersionRef.current
      ) {
        pumpTagSummaryRefreshRef.current?.();
      }
    });
    tagSummaryRefreshPromiseRef.current = completion;
  }, [settleTagSummaryRefreshWaiters]);
  pumpTagSummaryRefreshRef.current = pumpTagSummaryRefresh;

  const requestTagSummaryRefresh = useCallback(() => {
    const version = ++tagSummaryRequestedVersionRef.current;
    const completion = new Promise<readonly NoteTagSummary[] | null>(
      (resolve) => {
        tagSummaryRefreshWaitersRef.current.push({ version, resolve });
      }
    );
    pumpTagSummaryRefreshRef.current?.();
    return completion;
  }, []);

  useLayoutEffect(() => {
    closedRef.current = false;
    const previousEngine = draftEngineRef.current;
    if (previousEngine) {
      prepareAttachmentUploadAttemptsForTeardown();
      void previousEngine.beginShutdown();
    }
    applyAction({ type: "startWorkspaceLoad" });
    setAttachmentUploadErrorsByNodeId({});
    setAttachmentUploadRetryAttemptIdsByNodeId({});
    discardAttachmentUploadAttempts();
    setHistoryStatus({ canUndo: false, canRedo: false });
    activeScopeRef.current = { kind: "active" };
    activeWorkspaceGenerationRef.current += 1;
    movePreparationTokenRef.current += 1;
    selectionPreparationTokenRef.current += 1;
    requestedTagFiltersRef.current = [];
    tagFilterOriginRef.current = null;
    tagFilterRequestRef.current += 1;
    locallyExpandedNodeIdsRef.current = new Set();
    editingFocusRef.current = null;
    setLibraryView("all");
    setActiveTagFilters([]);
    const invalidatedTagSummaryVersion =
      ++tagSummaryRequestedVersionRef.current;
    tagSummarySettledVersionRef.current = Math.max(
      tagSummarySettledVersionRef.current,
      invalidatedTagSummaryVersion
    );
    settleTagSummaryRefreshWaiters(invalidatedTagSummaryVersion, null);
    setTagSummaries([]);
    setLocallyExpandedNodeIds(locallyExpandedNodeIdsRef.current);
    let engine!: NotesDraftEngine;
    const session = notesWorkspaceCoordinatorRegistry.openSession({
      repository,
      vaultRoot,
      onEvent(event) {
        if (engine.record.closing || sessionRecordRef.current !== engine.record) {
          return;
        }
        if (event.type === "pending") {
          applyAction({ type: "setLoading" });
          if (
            event.selectionPolicy === "clear" &&
            selectionRef.current !== null
          ) {
            updateSelection({ type: "clearSelection" });
          }
          return;
        }
        if (
          event.result.kind === "authoritative" ||
          (event.result.kind === "failure" && event.result.workspace)
        ) {
          activeWorkspaceGenerationRef.current += 1;
        }
        // The coordinator is the single owner of undo/redo availability: it
        // stamps every settled result with the authoritative historyStatus in
        // queue order, so the hook just adopts whatever the latest event
        // carries. No hook-side version comparison — settled/synchronized
        // events already arrive in the coordinator's monotonic order.
        if (
          event.result.kind !== "skipped" &&
          event.result.historyStatus
        ) {
          setHistoryStatus(event.result.historyStatus);
        }
        if (
          event.result.kind !== "skipped" &&
          event.result.invalidatesTagSummaries
        ) {
          void requestTagSummaryRefresh();
        }
        const expansionWorkspace =
          event.result.kind === "authoritative"
            ? event.result.workspace
            : event.result.kind === "failure"
              ? event.result.workspace
              : undefined;
        if (
          expansionWorkspace &&
          event.result.kind !== "skipped" &&
          event.result.clearLocalExpansionSubtreeId
        ) {
          const next = expansionsOutsideSubtree(
            locallyExpandedNodeIdsRef.current,
            expansionWorkspace,
            event.result.clearLocalExpansionSubtreeId
          );
          locallyExpandedNodeIdsRef.current = next;
          setLocallyExpandedNodeIds(next);
        }
        if (
          event.type === "synchronized" &&
          (event.sourceScope === null ||
            !sameScope(event.sourceScope, activeScopeRef.current))
        ) {
          const refreshScope = activeScopeRef.current;
          void session.enqueue(async (context) => {
            const workspace = await context.repository.loadWorkspace(
              context.vaultRoot,
              refreshScope
            );
            if (
              engine.record.closing ||
              sessionRecordRef.current !== engine.record ||
              sessionRef.current !== session ||
              !sameScope(activeScopeRef.current, refreshScope)
            ) {
              return { kind: "skipped" };
            }
            return {
              kind: "authoritative",
              workspace,
              suppressSynchronization: true
            };
          });
          return;
        }
        // The reducer settles navigation from this same result via its one
        // reconciler; a stale editing caret is naturally ignored once the
        // reducer moves the editing node (see currentNavigation's guard), so
        // there is no parallel navigation ref to reconcile here anymore.
        applyAction({
          type: "settleQueueWork",
          result: event.result,
          hasPendingWork: event.hasPendingWork
        });
      },
      captureDraftCutoff: () => engine.captureDraftCutoff(),
      beforeStructural: (cutoff) => engine.flushDraftBarrier(cutoff),
      afterStructural: (cutoff) => {
        engine.releaseDraftBarrier(cutoff);
        releaseFinalizedDetachedAttachmentUploadAttempts(engine.record);
      },
      isCurrent: () =>
        !engine.record.closing &&
        sessionRecordRef.current === engine.record &&
        sessionRef.current === session,
      getScope: () => activeScopeRef.current
    });
    const host: NotesDraftEngineHost = {
      beginTextEntry,
      beginStandaloneTextEntry,
      completeHistoryOwner,
      discardHistoryEntry,
      persistDraftMutation,
      setDraftEditingNavigation,
      currentRecord: () => sessionRecordRef.current,
      currentSession: () => sessionRef.current,
      isDeletingNotesData: () =>
        isNotesDataDeletionInProgress(repository, vaultRoot),
      onDraftsChanged: notifyDraftsListeners,
      onWriteErrorChanged: notifyWriteErrorListeners
    };
    engine = new NotesDraftEngine({
      repository,
      vaultRoot,
      session,
      writeQueue: createNotesWriteQueue(),
      host
    });
    sessionRecordRef.current = engine.record;
    sessionRef.current = session;
    draftEngineRef.current = engine;
    const unregisterNotesDataDeletionParticipant =
      registerNotesDataDeletionParticipant(repository, vaultRoot, engine);
    const unsubscribeImageImportRecovery = subscribeToImageImportRecovery(
      repository,
      vaultRoot,
      () => attachmentRecoveryChangeRef.current()
    );
    attachmentRecoveryChangeRef.current();
    // Point the drafts external store at the freshly opened engine (empty
    // buffer). The engine wires its own recovery subscription internally.
    notifyDraftsListeners();
    notifyWriteErrorListeners();
    enqueueBufferedCommands(
      session,
      bufferedCommandsRef.current.splice(0)
    );

    return () => {
      unregisterNotesDataDeletionParticipant();
      unsubscribeImageImportRecovery();
      engine.dispose();
      if (sessionRef.current === session) {
        sessionRef.current = null;
        // ref array is never reassigned; draining current buffered commands at teardown is intended
        // eslint-disable-next-line react-hooks/exhaustive-deps
        resolveBufferedCommands(bufferedCommandsRef.current.splice(0));
      }
    };
    // Session subscribe/teardown effect keyed on vault/repository; the engine's
    // host collaborators are stable callbacks invoked from the effect but omitted
    // so a re-render does not tear down and re-open the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    discardAttachmentUploadAttempts,
    prepareAttachmentUploadAttemptsForTeardown,
    releaseFinalizedDetachedAttachmentUploadAttempts,
    repository,
    requestTagSummaryRefresh,
    settleTagSummaryRefreshWaiters,
    vaultRoot
  ]);

  useEffect(() => {
    finalCleanupTokenRef.current = null;
    return () => {
      const engine = draftEngineRef.current;
      if (engine) {
        prepareAttachmentUploadAttemptsForTeardown();
        void engine.beginShutdown();
      }
      const token = {};
      finalCleanupTokenRef.current = token;
      queueMicrotask(() => {
        if (finalCleanupTokenRef.current !== token) {
          return;
        }
        finalCleanupTokenRef.current = null;
        closedRef.current = true;
        const finalRecord = sessionRecordRef.current;
        sessionRecordRef.current = null;
        if (finalRecord && sessionRef.current === finalRecord.session) {
          sessionRef.current = null;
        }
        discardAttachmentUploadAttempts();
        // ref array is never reassigned; draining current buffered commands at teardown is intended
        // eslint-disable-next-line react-hooks/exhaustive-deps
        resolveBufferedCommands(bufferedCommandsRef.current.splice(0));
      });
    };
  }, [
    discardAttachmentUploadAttempts,
    prepareAttachmentUploadAttemptsForTeardown
  ]);

  const runCommand = useCallback(
    (work: NotesWorkspaceQueueWork): Promise<void> => {
      if (isNotesDataDeletionInProgress(repository, vaultRoot)) {
        return Promise.resolve();
      }
      const session = sessionRef.current;
      if (session) {
        // Navigation/refresh work does not report a settlement to its caller.
        return session.enqueue(work).then(() => undefined);
      }
      if (closedRef.current) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        bufferedCommandsRef.current.push({ work, resolve: () => resolve() });
      });
    },
    [repository, vaultRoot]
  );

  const replaceLocalExpansions = useCallback(
    (nodeIds: ReadonlySet<NoteId>): void => {
      navigationVersionRef.current += 1;
      locallyExpandedNodeIdsRef.current = nodeIds;
      setLocallyExpandedNodeIds(nodeIds);
    },
    []
  );

  // Clear every tag-filter tracker together: the requested (optimistic) filters,
  // the return-here origin, the request generation, and the rendered active
  // filters. One code path so the trackers cannot drift apart across the
  // scope-changing actions that each used to reset them inline.
  const resetTagFilterTracking = useCallback((): void => {
    requestedTagFiltersRef.current = [];
    tagFilterOriginRef.current = null;
    tagFilterRequestRef.current += 1;
    setActiveTagFilters([]);
  }, []);

  // Build a history snapshot from an explicit navigation + expansion set. The
  // "before" capture passes the current navigation; the "after" capture (in
  // rememberHistoryAfter) passes the reducer-reconciled post-mutation
  // navigation, so both share this one shape.
  const buildHistorySnapshot = useCallback(
    (
      navigation: LiveNotesNavigation,
      expandedNodeIds: ReadonlySet<NoteId>,
      focus?: NotesHistoryFocus | null
    ): NotesHistorySnapshot => {
      const resolvedFocus =
        focus === undefined
          ? navigation.editingNoteId
            ? {
                nodeId: navigation.editingNoteId,
                field: navigation.pendingFocusField ?? "title"
              }
            : null
          : focus;
      const origin = tagFilterOriginRef.current;
      const tagFilterOrigin: NotesHistoryLocationSnapshot | null = origin
        ? {
            scope: cloneWorkspaceScope(origin.scope),
            selectedId: origin.navigation.selectedId,
            zoomRootId: origin.navigation.zoomRootId,
            locallyExpandedNodeIds: [...origin.locallyExpandedNodeIds],
            focus: origin.navigation.editingNoteId
              ? {
                  nodeId: origin.navigation.editingNoteId,
                  field: origin.navigation.pendingFocusField ?? "title"
                }
              : null
          }
        : null;
      return {
        scope: activeScopeRef.current,
        selectedId: navigation.selectedId,
        zoomRootId: navigation.zoomRootId,
        locallyExpandedNodeIds: [...expandedNodeIds],
        focus: resolvedFocus,
        tagFilterOrigin
      };
    },
    []
  );

  const captureHistorySnapshot = useCallback(
    (focus?: NotesHistoryFocus | null): NotesHistorySnapshot =>
      buildHistorySnapshot(
        currentNavigation(),
        locallyExpandedNodeIdsRef.current,
        focus
      ),
    [buildHistorySnapshot, currentNavigation]
  );

  const registerHistoryOwner = useCallback(
    (
      context: NotesHistoryContext,
      owner: NotesWorkspaceCoordinatorSession
    ): NotesHistoryContext => {
      const owners = historyOwnerByEntryIdRef.current;
      owners.begin(context.entryId, owner);
      return context;
    },
    []
  );

  const beginTextEntry = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      nodeId: NoteId,
      focus: NotesHistoryFocus
    ): NotesHistoryContext | null =>
      supportsHistory(record.repository)
        ? registerHistoryOwner(
            record.session.history.beginTextBurst(
              nodeId,
              captureHistorySnapshot(focus)
            ),
            record.session
          )
        : null,
    [captureHistorySnapshot, registerHistoryOwner]
  );

  const beginStandaloneTextEntry = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      nodeId: NoteId,
      focus: NotesHistoryFocus
    ): NotesHistoryContext | null => {
      if (!supportsHistory(record.repository)) {
        return null;
      }
      record.session.history.closeTextBurst();
      const context = registerHistoryOwner(
        record.session.history.beginTextBurst(
          nodeId,
          captureHistorySnapshot(focus)
        ),
        record.session
      );
      record.session.history.closeTextBurst(context.entryId);
      return context;
    },
    [captureHistorySnapshot, registerHistoryOwner]
  );

  const closeTextBurst = useCallback((): void => {
    sessionRef.current?.history.closeTextBurst();
  }, []);

  const beginStructuralEntry = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      commandKind: string
    ): NotesHistoryContext | null => {
      if (!supportsHistory(record.repository)) {
        return null;
      }
      return registerHistoryOwner(
        record.session.history.beginStructuralEntry(
          commandKind,
          captureHistorySnapshot()
        ),
        record.session
      );
    },
    [captureHistorySnapshot, registerHistoryOwner]
  );

  const completeHistoryOwner = useCallback((entryId: string): void => {
    historyOwnerByEntryIdRef.current.complete(entryId);
  }, []);

  const rememberHistoryAfter = useCallback(
    (
      context: NotesHistoryContext | null | undefined,
      workspace: NotesWorkspace,
      uiUpdate?: NotesWorkspaceUiUpdate,
      focus?: NotesHistoryFocus | null,
      expandedNodeIds?: ReadonlySet<NoteId>
    ): void => {
      if (!context) {
        return;
      }
      const owner = historyOwnerByEntryIdRef.current.owner(context.entryId);
      if (
        !owner || sessionRef.current !== owner
      ) {
        owner?.history.discard(context.entryId);
        historyOwnerByEntryIdRef.current.discard(context.entryId);
        return;
      }
      // The post-mutation navigation is computed with the reducer's own
      // reconciler against the settled navigation — the exact value the reducer
      // will settle to when this result flows through settleQueueWork. No
      // parallel navigation ref is advanced; the snapshot is a pure derivation.
      const afterNavigation = reconcileUiState(
        workspace,
        currentNavigation(),
        uiUpdate
      );
      const after = buildHistorySnapshot(
        afterNavigation,
        expandedNodeIds ?? locallyExpandedNodeIdsRef.current,
        focus
      );
      owner.history.rememberAfter(context.entryId, after);
      if (context.commandKind !== "text") {
        completeHistoryOwner(context.entryId);
      }
    },
    [buildHistorySnapshot, completeHistoryOwner, currentNavigation]
  );

  const discardHistoryEntry = useCallback(
    (context: NotesHistoryContext | null | undefined): void => {
      if (!context) {
        return;
      }
      const owner = historyOwnerByEntryIdRef.current.owner(context.entryId);
      owner?.history.discard(context.entryId);
      historyOwnerByEntryIdRef.current.discard(context.entryId);
    },
    []
  );

  const settleInlineTextEntry = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      context: NotesHistoryContext | null,
      result: NotesWorkspaceQueueResult
    ): void => {
      if (!context) {
        return;
      }
      record.session.history.closeTextBurst(context.entryId);
      if (
        result.kind !== "skipped" &&
        result.committedHistoryEntryIds?.includes(context.entryId) &&
        historyOwnerByEntryIdRef.current.owner(context.entryId) ===
          record.session &&
        sessionRef.current === record.session
      ) {
        completeHistoryOwner(context.entryId);
      } else {
        discardHistoryEntry(context);
      }
    },
    [completeHistoryOwner, discardHistoryEntry]
  );

  const runStructuralCommand = useCallback(
    (
      commandKind: string,
      work: (
        context: NotesWorkspaceQueueContext,
        historyContext: NotesHistoryContext | null,
        record: NotesWorkspaceSessionRecord
      ) => Promise<NotesWorkspaceQueueResult> | NotesWorkspaceQueueResult,
      options?: StructuralCommandOptions
    ): Promise<NotesWorkspaceCommandOutcome> => {
      const sharedDeletionInProgress = isNotesDataDeletionInProgress(
        repository,
        vaultRoot
      );
      if (sharedDeletionInProgress || closedRef.current) {
        if (
          !sharedDeletionInProgress ||
          options?.retainHistoryOnFailure !== true
        ) {
          discardHistoryEntry(options?.historyContext);
        }
        return Promise.resolve("skipped");
      }
      const currentRecord = sessionRecordRef.current;
      const invocationRecord =
        currentRecord?.repository === repository &&
        currentRecord.vaultRoot === vaultRoot
          ? currentRecord
          : null;
      const queueWork: NotesWorkspaceQueueWork = async (context) => {
        const record = invocationRecord ?? sessionRecordRef.current;
        if (
          !record ||
          context.repository !== repository ||
          context.vaultRoot !== vaultRoot ||
          record.repository !== context.repository ||
          record.vaultRoot !== context.vaultRoot
        ) {
          return { kind: "skipped" };
        }
        const historyContext =
          options && "historyContext" in options
            ? options.historyContext ?? null
            : beginStructuralEntry(record, commandKind);
        try {
          const result = await work(context, historyContext, record);
          const owner = historyContext
            ? historyOwnerByEntryIdRef.current.owner(historyContext.entryId)
            : undefined;
          const structuralCommitted = Boolean(
            historyContext &&
              result.kind === "failure" &&
              result.committedHistoryEntryIds?.includes(historyContext.entryId)
          );
          const retainHistory =
            options?.retainHistoryOnFailure === true &&
            result.kind === "failure";
          if (
            !retainHistory &&
            ((result.kind !== "authoritative" && !structuralCommitted) ||
              (historyContext !== null &&
                (owner === undefined ||
                  historyOwnerByEntryIdRef.current.isInFlight(
                    historyContext.entryId
                  ))))
          ) {
            discardHistoryEntry(historyContext);
          }
          return result;
        } catch (cause) {
          if (!options?.retainHistoryOnFailure) {
            discardHistoryEntry(historyContext);
          }
          throw cause;
        }
      };
      const record = sessionRecordRef.current;
      if (
        record &&
        !record.closing &&
        record.repository === repository &&
        record.vaultRoot === vaultRoot
      ) {
        return record.session.enqueueStructural(queueWork, {
          selectionPolicy: options?.selectionPolicy
        });
      }
      return new Promise<NotesWorkspaceCommandOutcome>((resolve) => {
        bufferedCommandsRef.current.push({
          work: queueWork,
          structural: true,
          selectionPolicy: options?.selectionPolicy,
          resolve
        });
      });
    },
    [beginStructuralEntry, discardHistoryEntry, repository, vaultRoot]
  );

  // Assemble the structural-command context once. Refs are live handles;
  // the callbacks are the only identity inputs, so this memo (and therefore
  // every delegating command below) only churns when one of them changes —
  // exactly the pre-extraction identity behaviour the context-split tests pin.
  const commandCtx = useMemo<NotesCommandContext>(
    () => ({
      activeScopeRef,
      sessionRecordRef,
      sessionRef,
      currentNavigation,
      currentEditingFocus,
      navigationVersionRef,
      locallyExpandedNodeIdsRef,
      tagFilterRequestRef,
      tagFilterOriginRef,
      stateRef,
      requestedTagFiltersRef,
      movePreparationTokenRef,
      selectionPreparationTokenRef,
      selectionRevisionRef,
      vaultRootRef,
      libraryViewRef,
      activeWorkspaceGenerationRef,
      setLibraryView,
      setActiveTagFilters,
      runStructuralCommand,
      rememberHistoryAfter,
      replaceLocalExpansions,
      beginTextEntry,
      settleInlineTextEntry,
      closeTextBurst
    }),
    [
      currentNavigation,
      currentEditingFocus,
      runStructuralCommand,
      rememberHistoryAfter,
      replaceLocalExpansions,
      beginTextEntry,
      settleInlineTextEntry,
      closeTextBurst
    ]
  );

  const persistDraftMutation = useCallback(
    async (
      context: NotesWorkspaceQueueContext,
      attempt: DraftWriteAttempt
    ): Promise<NotesWorkspaceQueueResult> => {
      const { nodeId, draft, historyContext } = attempt;
      if (!confirmedState(context).nodesById[nodeId]) {
        return { kind: "skipped" };
      }
      try {
        const mutation = unwrapNotesMutation(
          await context.repository.updateNode(
            context.vaultRoot,
            {
              id: nodeId,
              title: draft.title,
              note: draft.note
            },
            ...historyArguments(historyContext)
          )
        );
        const projection = await projectNotesMutation(
          context,
          mutation,
          activeScopeRef.current
        );
        const appliedContext = appliedHistoryContext(historyContext, mutation);
        if (historyContext && mutation.atomic && !appliedContext) {
          discardHistoryEntry(historyContext);
        }
        rememberHistoryAfter(
          appliedContext,
          projection.workspace,
          undefined,
          attempt.focus
        );
        return directMutationResult(mutation, projection);
      } catch (cause) {
        return { kind: "failure", error: errorMessage(cause) };
      }
    },
    [discardHistoryEntry, rememberHistoryAfter]
  );

  const markEditingFocus = useCallback(
    (nodeId: NoteId, field: NotesHistoryFocusField): void => {
      // A real DOM focus event is a new navigation gesture even when the user
      // returns to the same node/field after focusing outside the editor.
      navigationVersionRef.current += 1;
      editingFocusRef.current = { nodeId, field };
    },
    []
  );
  const setDraftEditingNavigation = useCallback(
    (nodeId: NoteId, field: NotesHistoryFocusField): void => {
      // Draft updates are only a fallback for non-DOM callers. Repeated typing
      // in one field must not manufacture a navigation gesture per keystroke.
      const current = editingFocusRef.current;
      if (current?.nodeId === nodeId && current.field === field) {
        return;
      }
      navigationVersionRef.current += 1;
      editingFocusRef.current = { nodeId, field };
    },
    []
  );
  const getNavigationVersion = useCallback(
    (): number => navigationVersionRef.current,
    []
  );

  // Stable selection actions (Phase 4.1). `setSelectionAnchor`/`extendSelectionTo`
  // mirror onto `selectionRef` synchronously — like `applyAction` does for the
  // workspace reducer — so an event handler that anchors then extends within one
  // turn (shift+arrow, shift+click) reads its own just-written selection.
  const setSelectionAnchor = useCallback((anchorId: NoteId): void => {
    updateSelection({
      type: "setSelectionAnchor",
      anchorId
    });
  }, [updateSelection]);
  const extendSelectionTo = useCallback((headId: NoteId): void => {
    updateSelection({
      type: "extendSelectionTo",
      headId
    });
  }, [updateSelection]);
  const clearSelection = useCallback((): void => {
    if (selectionRef.current === null) {
      return;
    }
    updateSelection({ type: "clearSelection" });
  }, [updateSelection]);
  const replaceSelection = useCallback(
    (
      nextSelection: NotesSelection | null,
      expectedRevision?: number
    ): boolean =>
      updateSelection(
        {
          type: "replaceSelection",
          selection: nextSelection ? { ...nextSelection } : null
        },
        expectedRevision
      ),
    [updateSelection]
  );
  const getSelectionSnapshot = useCallback(
    () => ({
      selection: selectionRef.current,
      revision: selectionRevisionRef.current
    }),
    []
  );

  // The draft pipeline lives in NotesDraftEngine; these are thin, stable
  // delegators onto the currently active engine so action identity never churns.
  const updateNodeDraft = useCallback(
    (
      nodeId: NoteId,
      patch: Pick<NoteNode, "title" | "note">,
      field: NotesHistoryFocusField = "title"
    ): void => {
      // Typing into a node collapses any live multi-node selection (parity with
      // Workflowy). Guarded so only the first keystroke after a selection pays
      // the dispatch; subsequent keystrokes are no-ops.
      if (selectionRef.current !== null) {
        updateSelection({ type: "clearSelection" });
      }
      draftEngineRef.current?.updateNodeDraft(nodeId, patch, field);
    },
    [updateSelection]
  );

  const flushNodeDraft = useCallback(
    (nodeId: NoteId): Promise<boolean> =>
      draftEngineRef.current?.flushNodeDraft(nodeId) ?? Promise.resolve(false),
    []
  );

  const retryFailedDraft = useCallback(
    (nodeId: NoteId): Promise<void> =>
      draftEngineRef.current?.retryFailedDraft(nodeId) ?? Promise.resolve(),
    []
  );

  const retryLastFailedWrite = useCallback(
    (): Promise<void> =>
      draftEngineRef.current?.retryLastFailedWrite() ?? Promise.resolve(),
    []
  );

  const flushAllDraftsBeforeStructural = useCallback(
    (): Promise<boolean> =>
      draftEngineRef.current?.flushAllDrafts() ?? Promise.resolve(false),
    []
  );

  const flushDraftBeforeStructural = useCallback(
    (_nodeId: NoteId): Promise<boolean> => flushAllDraftsBeforeStructural(),
    [flushAllDraftsBeforeStructural]
  );

  const replayHistory = useCallback(
    async (direction: "undo" | "redo"): Promise<void> => {
      const record = sessionRecordRef.current;
      const session = sessionRef.current;
      if (!record || !session || record.session !== session) {
        return;
      }
      let replayedSnapshot: NotesHistorySnapshot | null = null;
      let replayedExpansionIds: ReadonlySet<NoteId> | null = null;
      let replayedScope: NotesWorkspaceScope | null = null;
      let replayedTagFilterOrigin: TagFilterOrigin | null | undefined;
      await session.enqueueStructural(async (context) => {
        const replay =
          direction === "undo" ? context.repository.undo : context.repository.redo;
        if (!replay) {
          return { kind: "skipped" };
        }
        const currentScope = activeScopeRef.current;
        const result = await replay(
          context.vaultRoot,
          session.history.sessionId,
          currentScope
        );
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== session
        ) {
          return authoritative(
            result.workspace,
            undefined,
            {
              canUndo: result.canUndo,
              canRedo: result.canRedo
            },
            {
              scopeAgnostic: currentScope.kind !== "active",
              invalidatesTagSummaries: true
            }
          );
        }
        const replayOwner = result.replayedEntryId
          ? historyOwnerByEntryIdRef.current.owner(result.replayedEntryId)
          : undefined;
        replayedSnapshot =
          replayOwner === session
            ? session.history.snapshotForReplay(
                result.replayedEntryId,
                direction
              )
            : null;
        replayedScope = replayedSnapshot?.scope ?? currentScope;
        if (replayedSnapshot) {
          const origin = replayedSnapshot.tagFilterOrigin;
          replayedTagFilterOrigin = origin
            ? {
                scope: cloneWorkspaceScope(origin.scope),
                libraryView: (() => {
                  const library = libraryStateForScope(origin.scope).view;
                  return library === "tags" ? "all" : library;
                })(),
                navigation: {
                  selectedId: origin.selectedId,
                  zoomRootId: origin.zoomRootId,
                  editingNoteId: origin.focus?.nodeId ?? null,
                  pendingFocusId: origin.focus?.nodeId ?? null,
                  pendingFocusField: origin.focus?.field ?? null
                },
                locallyExpandedNodeIds: new Set(
                  origin.locallyExpandedNodeIds
                )
              }
            : null;
        }
        let replayedWorkspace = result.workspace;
        if (!sameScope(replayedScope, currentScope)) {
          replayedWorkspace = await context.repository.loadWorkspace(
            context.vaultRoot,
            replayedScope
          );
          if (
            record.closing ||
            sessionRecordRef.current !== record ||
            sessionRef.current !== session
          ) {
            return authoritative(
              result.workspace,
              undefined,
              {
                canUndo: result.canUndo,
                canRedo: result.canRedo
              },
              {
                scopeAgnostic: currentScope.kind !== "active",
                invalidatesTagSummaries: true
              }
            );
          }
        }
        activeScopeRef.current = replayedScope;
        const existingIds = new Set(replayedWorkspace.nodes.map((item) => item.id));
        replayedExpansionIds = new Set(
          (replayedSnapshot?.locallyExpandedNodeIds ?? [
            ...locallyExpandedNodeIdsRef.current
          ]).filter((nodeId) => existingIds.has(nodeId))
        );
        const focus = replayedSnapshot?.focus ?? null;
        return authoritative(
          replayedWorkspace,
          replayedSnapshot
            ? {
                selectedId: replayedSnapshot.selectedId,
                zoomRootId: replayedSnapshot.zoomRootId,
                editingNoteId: focus?.nodeId ?? null,
                pendingFocusId: focus?.nodeId ?? null,
                pendingFocusField: focus?.field ?? null
              }
            : undefined,
          { canUndo: result.canUndo, canRedo: result.canRedo },
          { invalidatesTagSummaries: true }
        );
      });
      if (
        record.closing ||
        sessionRecordRef.current !== record ||
        sessionRef.current !== session
      ) {
        return;
      }
      if (replayedExpansionIds) {
        replaceLocalExpansions(replayedExpansionIds);
      }
      if (replayedScope) {
        const library = libraryStateForScope(replayedScope);
        setLibraryView(library.view);
        requestedTagFiltersRef.current = library.filters;
        setActiveTagFilters(library.filters);
        if (replayedTagFilterOrigin !== undefined) {
          tagFilterOriginRef.current = replayedTagFilterOrigin;
        }
      }
    },
    [
      replaceLocalExpansions,
    ]
  );

  const undo = useCallback(() => replayHistory("undo"), [replayHistory]);
  const redo = useCallback(() => replayHistory("redo"), [replayHistory]);

  const loadLibraryScope = useCallback(
    async (
      view: NotesLibraryView,
      scope: NotesWorkspaceScope
    ): Promise<void> => {
      if (
        (sessionRecordRef.current?.drafts.size ?? 0) > 0 &&
        !(await flushAllDraftsBeforeStructural())
      ) {
        return;
      }
      const record = sessionRecordRef.current;
      if (!record) return;
      const session = record.session;
      let loaded = false;
      await runCommand(async (context) => {
        const workspace = await context.repository.loadWorkspace(
          context.vaultRoot,
          scope
        );
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== session
        ) {
          return { kind: "skipped" };
        }
        loaded = true;
        activeScopeRef.current = scope;
        return authoritative(workspace, {
          selectedId: null,
          zoomRootId: null,
          editingNoteId: null,
          pendingFocusId: null
        });
      });
      if (
        !loaded ||
        record.closing ||
        sessionRecordRef.current !== record ||
        sessionRef.current !== session
      ) {
        return;
      }
      setLibraryView(view);
      resetTagFilterTracking();
      replaceLocalExpansions(new Set());
    },
    [
      flushAllDraftsBeforeStructural,
      replaceLocalExpansions,
      resetTagFilterTracking,
      runCommand
    ]
  );

  const selectLibraryView = useCallback(
    async (view: NotesLibraryView): Promise<void> => {
      if (view !== "tags") {
        await loadLibraryScope(view, scopeForLibraryView(view));
        return;
      }
      if (requestedTagFiltersRef.current.length > 0) {
        return;
      }
      if (
        (sessionRecordRef.current?.drafts.size ?? 0) > 0 &&
        !(await flushAllDraftsBeforeStructural())
      ) {
        return;
      }
      const record = sessionRecordRef.current;
      if (!record) {
        return;
      }
      const originLibrary = libraryStateForScope(activeScopeRef.current);
      const chooserOrigin: TagFilterOrigin = {
        scope: cloneWorkspaceScope(activeScopeRef.current),
        libraryView:
          originLibrary.view === "tags" ? "all" : originLibrary.view,
        navigation: currentNavigation(),
        locallyExpandedNodeIds: new Set(locallyExpandedNodeIdsRef.current)
      };
      let listedTags: readonly NoteTagSummary[] | null = null;
      await runCommand(async () => {
        listedTags = await requestTagSummaryRefresh();
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== record.session
        ) {
          return { kind: "skipped" };
        }
        return authoritative(
          { nodes: [] },
          {
            selectedId: null,
            zoomRootId: null,
            editingNoteId: null,
            pendingFocusId: null
          }
        );
      });
      if (
        !listedTags ||
        record.closing ||
        sessionRecordRef.current !== record ||
        sessionRef.current !== record.session
      ) {
        return;
      }
      tagFilterOriginRef.current = chooserOrigin;
      setLibraryView("tags");
      replaceLocalExpansions(new Set());
    }, [
      currentNavigation,
      flushAllDraftsBeforeStructural,
      loadLibraryScope,
      replaceLocalExpansions,
      requestTagSummaryRefresh,
      runCommand
    ]
  );

  const toggleTagFilter = useCallback(
    async (filter: NoteTagFilter): Promise<void> => {
      const currentFilters = requestedTagFiltersRef.current;
      const key = tagFilterKey(filter);
      const exists = currentFilters.some(
        (candidate) => tagFilterKey(candidate) === key
      );
      const nextFilters = canonicalizeTagFilters(
        exists
          ? currentFilters.filter((candidate) => tagFilterKey(candidate) !== key)
          : [...currentFilters, filter]
      );
      const requestId = ++tagFilterRequestRef.current;
      requestedTagFiltersRef.current = nextFilters;
      let capturedOrigin = false;
      const rollbackRequestedFilters = () => {
        if (tagFilterRequestRef.current !== requestId) {
          return;
        }
        requestedTagFiltersRef.current = currentFilters;
        if (capturedOrigin) {
          tagFilterOriginRef.current = null;
        }
      };

      if (
        currentFilters.length === 0 &&
        nextFilters.length > 0 &&
        tagFilterOriginRef.current === null
      ) {
        const originLibrary = libraryStateForScope(activeScopeRef.current);
        tagFilterOriginRef.current = {
          scope: cloneWorkspaceScope(activeScopeRef.current),
          libraryView:
            originLibrary.view === "tags" ? "all" : originLibrary.view,
          navigation: currentNavigation(),
          locallyExpandedNodeIds: new Set(locallyExpandedNodeIdsRef.current)
        };
        capturedOrigin = true;
      }

      if (
        (sessionRecordRef.current?.drafts.size ?? 0) > 0 &&
        !(await flushAllDraftsBeforeStructural())
      ) {
        rollbackRequestedFilters();
        return;
      }
      const record = sessionRecordRef.current;
      if (!record) {
        rollbackRequestedFilters();
        return;
      }
      const session = record.session;
      const origin = tagFilterOriginRef.current;
      const nextScope: NotesWorkspaceScope =
        nextFilters.length > 0
          ? { kind: "tags", tags: nextFilters }
          : cloneWorkspaceScope(origin?.scope ?? { kind: "active" });
      let loaded = false;
      let restoredExpansions: ReadonlySet<NoteId> = new Set();

      await runCommand(async (context) => {
        if (tagFilterRequestRef.current !== requestId) {
          return { kind: "skipped" };
        }
        const [workspace, countedTags] = await Promise.all([
          context.repository.loadWorkspace(context.vaultRoot, nextScope),
          requestTagSummaryRefresh()
        ]);
        if (
          tagFilterRequestRef.current !== requestId ||
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== session
        ) {
          return { kind: "skipped" };
        }
        if (!countedTags) {
          return { kind: "skipped" };
        }
        loaded = true;
        activeScopeRef.current = nextScope;
        if (nextFilters.length > 0) {
          return authoritative(workspace, {
            selectedId: null,
            zoomRootId: null,
            editingNoteId: null,
            pendingFocusId: null
          });
        }
        const restoration = origin
          ? restoredTagFilterNavigation(workspace, origin)
          : {
              uiUpdate: {
                selectedId: null,
                zoomRootId: null,
                editingNoteId: null,
                pendingFocusId: null
              },
              expandedNodeIds: new Set<NoteId>()
            };
        restoredExpansions = restoration.expandedNodeIds;
        return authoritative(workspace, restoration.uiUpdate);
      });

      if (
        !loaded ||
        tagFilterRequestRef.current !== requestId ||
        record.closing ||
        sessionRecordRef.current !== record ||
        sessionRef.current !== session
      ) {
        rollbackRequestedFilters();
        return;
      }
      setActiveTagFilters(nextFilters);
      if (nextFilters.length > 0) {
        setLibraryView("tags");
        replaceLocalExpansions(new Set());
        return;
      }
      setLibraryView(origin?.libraryView ?? "all");
      replaceLocalExpansions(restoredExpansions);
      tagFilterOriginRef.current = null;
    },
    [
      currentNavigation,
      flushAllDraftsBeforeStructural,
      replaceLocalExpansions,
      requestTagSummaryRefresh,
      runCommand
    ]
  );

  const searchNotes = useCallback(
    async (query: string): Promise<NoteSearchResult[]> => {
      const parsed = parseAndValidateNoteSearchQuery(query);
      if (!parsed.ok) {
        throw new Error(parsed.error.message);
      }
      const structured =
        parsed.query.requiredTags.length > 0 ||
        parsed.query.excludedTags.length > 0 ||
        parsed.query.orGroups.length > 0;
      if (!structured) {
        return repository.search(vaultRoot, parsed.query.text);
      }
      if (!repository.searchStructured) {
        throw new Error("Structured Notes search is unavailable.");
      }
      return repository.searchStructured(vaultRoot, parsed.query);
    },
    [repository, vaultRoot]
  );

  const openSearchResult = useCallback(
    async (nodeId: NoteId): Promise<void> => {
      if (
        (sessionRecordRef.current?.drafts.size ?? 0) > 0 &&
        !(await flushAllDraftsBeforeStructural())
      ) {
        return;
      }
      const record = sessionRecordRef.current;
      if (!record) return;
      const session = record.session;
      let expandedNodeIds: ReadonlySet<NoteId> = new Set();
      let loaded = false;
      await runCommand(async (context) => {
        const workspace = await context.repository.loadWorkspace(
          context.vaultRoot,
          { kind: "active" }
        );
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== session
        ) {
          return { kind: "skipped" };
        }
        loaded = true;
        activeScopeRef.current = { kind: "active" };
        const navigation = searchNavigation(workspace, nodeId);
        expandedNodeIds = navigation?.expandedNodeIds ?? new Set();
        return authoritative(
          workspace,
          navigation
            ? {
                selectedId: nodeId,
                zoomRootId: navigation.rootId,
                editingNoteId: nodeId,
                pendingFocusId: nodeId
              }
            : {
                selectedId: null,
                zoomRootId: null,
                editingNoteId: null,
                pendingFocusId: null
              }
        );
      });
      if (
        !loaded ||
        record.closing ||
        sessionRecordRef.current !== record ||
        sessionRef.current !== session
      ) {
        return;
      }
      setLibraryView("all");
      resetTagFilterTracking();
      replaceLocalExpansions(expandedNodeIds);
    },
    [
      flushAllDraftsBeforeStructural,
      replaceLocalExpansions,
      resetTagFilterTracking,
      runCommand
    ]
  );

  const acknowledgeFocus = useCallback(
    async (nodeId: NoteId) => {
      const pending = stateRef.current;
      if (
        pending.pendingFocusId === nodeId &&
        pending.pendingFocusField !== null &&
        pending.nodesById[nodeId] !== undefined
      ) {
        // OutlineNodeRow calls this only after DOM focus succeeds. Preserve the
        // acknowledged field as the live caret without creating a new user
        // navigation epoch, then retire the pending-focus request.
        editingFocusRef.current = {
          nodeId,
          field: pending.pendingFocusField
        };
      }
      applyAction({ type: "acknowledgePendingFocus", nodeId });
    },
    [applyAction]
  );

  const focusNode = useCallback(
    async (nodeId: NoteId) => {
      void flushNodeDraft(nodeId);
      navigationVersionRef.current += 1;
      // applyAction retires the live caret; the reducer owns the new position.
      applyAction({ type: "focusNode", nodeId });
    },
    [applyAction, flushNodeDraft]
  );

  const createRoot = useCallback(
    () => createRootCommand(commandCtx),
    [commandCtx]
  );

  const createChild = useCallback(
    (nodeId: NoteId) => createChildCommand(commandCtx, nodeId),
    [commandCtx]
  );

  const createNextTextSibling = useCallback(
    (nodeId: NoteId) => createNextTextSiblingCommand(commandCtx, nodeId),
    [commandCtx]
  );

  const splitNode = useCallback(
    (
      nodeId: NoteId,
      newNodeId: NoteId,
      prefix: string,
      suffix: string,
      options?: NotesWorkspaceCompoundOptions
    ) =>
      splitNodeCommand(commandCtx, nodeId, newNodeId, prefix, suffix, options),
    [commandCtx]
  );

  const updateNode = useCallback(
    (nodeId: NoteId, patch: Pick<NoteNode, "title" | "note">) =>
      updateNodeCommand(commandCtx, nodeId, patch),
    [commandCtx]
  );

  const moveNode = useCallback(
    (
      input: MoveNoteNodeInput,
      focusNodeId?: NoteId | null,
      options?: NotesWorkspaceCompoundOptions
    ) => moveNodeCommand(commandCtx, input, focusNodeId, options),
    [commandCtx]
  );

  const applyBatch = useCallback(
    async (
      nodeIds: readonly NoteId[],
      op: NotesBatchOp,
      options?: { focusNodeId?: NoteId | null }
    ) =>
      (
        await applyBatchCommand(
        commandCtx,
        nodeIds,
        op,
        focusedUiUpdate(options?.focusNodeId)
        )
      ).outcome,
    [commandCtx]
  );

  const importSubtree = useCallback(
    (
      parentId: NoteId | null,
      afterId: NoteId | null,
      nodes: readonly NoteImportNode[]
    ) => importSubtreeCommand(commandCtx, { parentId, afterId, nodes }),
    [commandCtx]
  );

  const toggleComplete = useCallback(
    (nodeId: NoteId) => toggleCompleteCommand(commandCtx, nodeId),
    [commandCtx]
  );

  const toggleCollapsed = useCallback(
    (nodeId: NoteId) => toggleCollapsedCommand(commandCtx, nodeId),
    [commandCtx]
  );

  const expandAll = useCallback(
    (nodeId: NoteId) =>
      runAtomicSubtreeCommand(
        commandCtx,
        "expand-all",
        "expandAll",
        nodeId,
        true
      ),
    [commandCtx]
  );

  const collapseAll = useCallback(
    (nodeId: NoteId) =>
      runAtomicSubtreeCommand(
        commandCtx,
        "collapse-all",
        "collapseAll",
        nodeId,
        true
      ),
    [commandCtx]
  );

  const sortSubtreeAscending = useCallback(
    (nodeId: NoteId) =>
      runAtomicSubtreeCommand(
        commandCtx,
        "sort-ascending",
        "sortSubtreeAscending",
        nodeId,
        false
      ),
    [commandCtx]
  );

  const sortSubtreeDescending = useCallback(
    (nodeId: NoteId) =>
      runAtomicSubtreeCommand(
        commandCtx,
        "sort-descending",
        "sortSubtreeDescending",
        nodeId,
        false
      ),
    [commandCtx]
  );

  const toggleStar = useCallback(
    (nodeId: NoteId) => toggleStarCommand(commandCtx, nodeId),
    [commandCtx]
  );

  const duplicateNode = useCallback(
    (nodeId: NoteId) => duplicateNodeCommand(commandCtx, nodeId),
    [commandCtx]
  );

  const archiveNode = useCallback(
    (nodeId: NoteId) => runRootLifecycle(commandCtx, nodeId, "archive"),
    [commandCtx]
  );

  const unarchiveNode = useCallback(
    (nodeId: NoteId) => runRootLifecycle(commandCtx, nodeId, "unarchive"),
    [commandCtx]
  );

  const removeEmptyNode = useCallback(
    (
      nodeId: NoteId,
      focusNodeId?: NoteId | null,
      options?: NotesWorkspaceCompoundOptions
    ) => removeEmptyNodeCommand(commandCtx, nodeId, focusNodeId, options),
    [commandCtx]
  );

  const deleteNode = useCallback(
    (nodeId: NoteId) => deleteNodeCommand(commandCtx, nodeId),
    [commandCtx]
  );

  const restoreNode = useCallback(
    (nodeId: NoteId) => restoreNodeCommand(commandCtx, nodeId),
    [commandCtx]
  );

  const emptyTrash = useCallback(
    () => emptyTrashCommand(commandCtx),
    [commandCtx]
  );

  const purgeAttachmentUploadAttemptsAfterDataDeletion = useCallback((): void => {
    for (const attempt of [...attachmentUploadAttempts]) {
      const recoveryOwner = attempt.recoveryOwner;
      const belongsToDeletedVault = recoveryOwner
        ? recoveryOwner.repository === repository &&
          recoveryOwner.vaultRoot === vaultRoot
        : attempt.record.repository === repository &&
          attempt.record.vaultRoot === vaultRoot;
      if (!belongsToDeletedVault) continue;

      attempt.detached = true;
      const context = attempt.historyContext;
      if (context) {
        const registeredOwner = historyOwnerByEntryIdRef.current.owner(
          context.entryId
        );
        (registeredOwner ?? attempt.record.session).history.discard(
          context.entryId
        );
        historyOwnerByEntryIdRef.current.discard(context.entryId);
      }
      finalizeAttachmentUploadAttempt(attempt);
    }
    notifyImageImportRecoveryFor(repository, vaultRoot);
    const currentAttachmentGeneration = attachmentActionGenerationRef.current;
    if (
      !closedRef.current &&
      currentAttachmentGeneration.repository === repository &&
      currentAttachmentGeneration.vaultRoot === vaultRoot
    ) {
      attachmentUploadAttemptsByNodeIdRef.current.clear();
      setAttachmentUploadErrorsByNodeId({});
      setAttachmentUploadRetryAttemptIdsByNodeId({});
    }
  }, [repository, vaultRoot]);

  const deleteAllNotesData = useCallback(
    async (options?: NotesDeleteAllOptions): Promise<NotesDeleteAllResult> => {
      const record = sessionRecordRef.current;
      if (!record || record.closing || sessionRef.current !== record.session) {
        throw new Error("The Notes workspace is unavailable.");
      }
      if (isNotesDataDeletionInProgress(repository, vaultRoot)) {
        throw new Error("Notes data deletion is already in progress.");
      }

      const discardDrafts = options?.discardDrafts === true;
      const deletionToken = {};
      if (!reserveNotesDataDeletion(repository, vaultRoot, deletionToken)) {
        throw new Error("Notes data deletion is already in progress.");
      }
      const deletionParticipants = notesDataDeletionParticipants(
        repository,
        vaultRoot
      );

      try {
        if (discardDrafts) {
          for (const participant of deletionParticipants) {
            participant.discardPendingDrafts();
          }
        }

        let deletionError: unknown = null;
        let deleted = false;
        let attachmentCleanupFailed = false;
        await record.session.enqueueStructural(
          async (context) => {
            try {
              const outcome = (await context.repository.deleteDatabase(
                context.vaultRoot
              )) as unknown;
              attachmentCleanupFailed =
                hasAttachmentCleanupFlag(outcome) &&
                outcome.attachmentCleanupFailed;
              deleted = true;
              return authoritative(
                { nodes: [] },
                {
                  selectedId: null,
                  zoomRootId: null,
                  editingNoteId: null,
                  pendingFocusId: null
                }
              );
            } catch (cause) {
              deletionError = cause;
              return { kind: "failure", error: errorMessage(cause) };
            }
          },
          {
            retainAfterClose: true,
            requireAllBarriers: !discardDrafts
          }
        );
        if (deletionError) {
          throw deletionError;
        }
        if (!deleted) {
          const failedParticipant = deletionParticipants.find(
            (participant) =>
              participant.record.writeError !== null ||
              participant.record.drafts.size > 0
          );
          if (!discardDrafts && failedParticipant) {
            throw notesDraftsFlushFailedError(
              failedParticipant.record.writeError
            );
          }
          throw new Error("Notes data deletion did not complete.");
        }

        purgeAttachmentUploadAttemptsAfterDataDeletion();
        const resetParticipants = new Set([
          ...deletionParticipants,
          ...notesDataDeletionParticipants(repository, vaultRoot)
        ]);
        for (const participant of resetParticipants) {
          participant.resetAfterDataDeletion();
        }
        if (
          sessionRecordRef.current === record &&
          sessionRef.current === record.session
        ) {
          activeScopeRef.current = { kind: "active" };
          setLibraryView("all");
          resetTagFilterTracking();
          setTagSummaries([]);
          replaceLocalExpansions(new Set());
        }
        return { attachmentCleanupFailed };
      } finally {
        releaseNotesDataDeletion(repository, vaultRoot, deletionToken);
      }
    },
    [
      purgeAttachmentUploadAttemptsAfterDataDeletion,
      replaceLocalExpansions,
      repository,
      resetTagFilterTracking,
      vaultRoot
    ]
  );

  const zoomTo = useCallback(
    async (nodeId: NoteId | null) => {
      navigationVersionRef.current += 1;
      applyAction({ type: "setZoomRoot", zoomRootId: nodeId });
    },
    [applyAction]
  );

  const setAttachmentUploadError = useCallback(
    (
      nodeId: NoteId,
      error: string | null,
      retryAttemptId?: string
    ): void => {
      let effectiveRetryAttemptId = retryAttemptId;
      if (error !== null && effectiveRetryAttemptId === undefined) {
        for (const attempt of
          attachmentUploadAttemptsByNodeIdRef.current.get(nodeId)?.values() ??
          []) {
          if (attempt.status === "failed") {
            effectiveRetryAttemptId = attempt.attemptId;
          }
        }
      }
      setAttachmentUploadErrorsByNodeId((current) => {
        if (error === null) {
          if (current[nodeId] === undefined) return current;
          const next = { ...current };
          delete next[nodeId];
          return next;
        }
        return current[nodeId] === error
          ? current
          : { ...current, [nodeId]: error };
      });
      setAttachmentUploadRetryAttemptIdsByNodeId((current) => {
        if (error === null || effectiveRetryAttemptId === undefined) {
          if (current[nodeId] === undefined) return current;
          const next = { ...current };
          delete next[nodeId];
          return next;
        }
        return current[nodeId] === effectiveRetryAttemptId
          ? current
          : { ...current, [nodeId]: effectiveRetryAttemptId };
      });
    },
    []
  );

  const publishLatestAttachmentAttemptError = useCallback(
    (nodeId: NoteId): void => {
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(nodeId);
      let latestFailedAttempt: AttachmentUploadAttempt | undefined;
      for (const attempt of attempts?.values() ?? []) {
        if (attempt.status === "failed") latestFailedAttempt = attempt;
      }
      setAttachmentUploadError(
        nodeId,
        latestFailedAttempt?.error ?? null,
        latestFailedAttempt?.attemptId
      );
    },
    [setAttachmentUploadError]
  );

  const syncRecoveredAttachmentUploadAttempts = useCallback((): void => {
    const recovered = recoveredAttachmentUploadAttempts(repository, vaultRoot);
    const recoveredSet = new Set(recovered);
    const affectedNodeIds = new Set<NoteId>();
    for (const attempts of attachmentUploadAttemptsByNodeIdRef.current.values()) {
      for (const [attemptId, attempt] of attempts) {
        const recoveryOwner = attempt.recoveryOwner;
        const belongsToCurrentVault = recoveryOwner
          ? recoveryOwner.repository === repository &&
            recoveryOwner.vaultRoot === vaultRoot
          : attempt.record.repository === repository &&
            attempt.record.vaultRoot === vaultRoot;
        const finalized =
          belongsToCurrentVault && !attachmentUploadAttempts.has(attempt);
        const noLongerRecovered =
          recoveryOwner?.repository === repository &&
          recoveryOwner.vaultRoot === vaultRoot &&
          !recoveredSet.has(attempt);
        if (finalized || noLongerRecovered) {
          attempts.delete(attemptId);
          if (finalized && attempt.historyContext) {
            historyOwnerByEntryIdRef.current.discard(
              attempt.historyContext.entryId
            );
          }
          affectedNodeIds.add(attempt.nodeId);
        }
      }
    }
    for (const attempt of recovered) {
      const attempts =
        attachmentUploadAttemptsByNodeIdRef.current.get(attempt.nodeId) ??
        new Map();
      attempts.set(attempt.attemptId, attempt);
      attachmentUploadAttemptsByNodeIdRef.current.set(attempt.nodeId, attempts);
      affectedNodeIds.add(attempt.nodeId);
    }
    for (const [nodeId, attempts] of attachmentUploadAttemptsByNodeIdRef.current) {
      if (attempts.size === 0) {
        attachmentUploadAttemptsByNodeIdRef.current.delete(nodeId);
      }
    }
    for (const nodeId of affectedNodeIds) {
      publishLatestAttachmentAttemptError(nodeId);
    }
  }, [publishLatestAttachmentAttemptError, repository, vaultRoot]);
  attachmentRecoveryChangeRef.current = syncRecoveredAttachmentUploadAttempts;

  const setImageImportMaxDisplayWidth = useCallback(
    (displayWidth: number | null): void => {
      imageImportMaxDisplayWidthRef.current =
        displayWidth !== null &&
        Number.isSafeInteger(displayWidth) &&
        displayWidth > 0
          ? displayWidth
          : null;
    },
    []
  );

  const removeAttachmentUploadAttempt = useCallback(
    (attempt: AttachmentUploadAttempt): void => {
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(
        attempt.nodeId
      );
      if (attempts?.get(attempt.attemptId) !== attempt) return;
      attempts.delete(attempt.attemptId);
      if (attempts.size === 0) {
        attachmentUploadAttemptsByNodeIdRef.current.delete(attempt.nodeId);
      }
    },
    []
  );

  const discardPendingAttachmentUploadAttempt = useCallback(
    (attempt: AttachmentUploadAttempt): void => {
      if (attempt.status !== "pending" || attempt.unknownOutcome) return;
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(
        attempt.nodeId
      );
      if (attempts?.get(attempt.attemptId) !== attempt) return;
      finalizeAttachmentUploadAttempt(attempt);
      discardHistoryEntry(attempt.historyContext);
      removeAttachmentUploadAttempt(attempt);
      publishLatestAttachmentAttemptError(attempt.nodeId);
    },
    [
      discardHistoryEntry,
      publishLatestAttachmentAttemptError,
      removeAttachmentUploadAttempt
    ]
  );

  const admitAttachmentUploadBytes = useCallback(
    (incomingByteSize: number): boolean => {
      let retainedByteSize = 0;
      for (const attempt of retainedAttachmentUploadByteAttempts) {
        retainedByteSize += attempt.retainedByteSize;
      }
      return (
        retainedByteSize + incomingByteSize <=
        MAX_NOTE_ATTACHMENT_BATCH_BYTES
      );
    },
    []
  );

  const createAttachmentUploadAttempt = useCallback(
    (
      nodeId: NoteId,
      request: ImageNodeImportRequest,
      initialMaxDisplayWidth: number,
      retainedByteSize = 0
    ): AttachmentUploadAttempt | null => {
      const record = sessionRecordRef.current;
      if (
        !record ||
        record.closing ||
        record.repository !== repository ||
        record.vaultRoot !== vaultRoot
      ) {
        return null;
      }
      const attempt: AttachmentUploadAttempt = {
        attemptId: globalThis.crypto.randomUUID(),
        order: ++attachmentUploadAttemptOrderRef.current,
        nodeId,
        request,
        retainedByteSize,
        scope: cloneWorkspaceScope(activeScopeRef.current),
        initialMaxDisplayWidth,
        historyContext: beginStructuralEntry(record, "attachment-import"),
        record,
        orderingTurn: reserveImageImportOrderingTurn(
          repository,
          vaultRoot,
          request.anchor
        ),
        reservation:
          record.session.reserveImageImportInsertion?.(request.anchor) ?? null,
        recoveryOwner: null,
        effectiveAnchor: null,
        structuralIntent: null,
        enqueueCompletionSettled: false,
        detached: false,
        started: false,
        unknownOutcome: false,
        status: "pending",
        error: null
      };
      const attempts =
        attachmentUploadAttemptsByNodeIdRef.current.get(nodeId) ?? new Map();
      attempts.set(attempt.attemptId, attempt);
      attachmentUploadAttemptsByNodeIdRef.current.set(nodeId, attempts);
      attachmentUploadAttempts.add(attempt);
      if (request.kind === "bytes") {
        retainedAttachmentUploadByteAttempts.add(attempt);
      }
      publishLatestAttachmentAttemptError(nodeId);
      return attempt;
    },
    [
      beginStructuralEntry,
      publishLatestAttachmentAttemptError,
      repository,
      vaultRoot
    ]
  );

  const executeAttachmentUploadAttempt = useCallback(
    async (attempt: AttachmentUploadAttempt): Promise<void> => {
      const retainedUnknownError = attempt.unknownOutcome
        ? attempt.error
        : null;
      attempt.status = "pending";
      attempt.error = null;
      attempt.structuralIntent = null;
      attempt.enqueueCompletionSettled = false;
      attempt.detached = false;
      attempt.started = false;
      if (attempt.request.kind === "bytes") {
        retainedAttachmentUploadByteAttempts.add(attempt);
      }
      publishLatestAttachmentAttemptError(attempt.nodeId);

      let outcome: NotesWorkspaceCommandOutcome | null = null;
      try {
        await attempt.orderingTurn.wait();
        if (attempt.detached) {
          if (attempt.unknownOutcome) {
            attempt.status = "failed";
            attempt.error = retainedUnknownError;
            if (attempt.recoveryOwner) {
              notifyImageImportRecovery(attempt.recoveryOwner);
            }
          }
          return;
        }
        const priorStructuralIntents = new Set(
          attempt.record.structuralIntents
        );
        const completion = runStructuralCommand(
          "attachment-import",
          async (context, historyContext, record) => {
          attempt.scope = cloneWorkspaceScope(context.sourceScope);
          const confirmedTarget = confirmedState(context).nodesById[
            attempt.nodeId
          ];
          const currentAnchor = imageNodeInsertionAnchor(
            stateRef.current,
            attempt.nodeId
          );
          if (
            record !== attempt.record ||
            (!attempt.unknownOutcome &&
              (!confirmedTarget ||
                confirmedTarget.deletedAt !== null ||
                confirmedTarget.archivedAt !== null ||
                currentAnchor === null ||
                !sameImageNodeInsertionAnchor(
                  currentAnchor,
                  attempt.request.anchor
                )))
          ) {
            if (attempt.unknownOutcome) {
              return {
                kind: "failure",
                error:
                  attempt.error ??
                  "Image upload reconciliation is still pending."
              };
            }
            finalizeAttachmentUploadAttempt(attempt);
            removeAttachmentUploadAttempt(attempt);
            publishLatestAttachmentAttemptError(attempt.nodeId);
            return { kind: "skipped" };
          }
          const executionAnchor =
            attempt.effectiveAnchor ??
            attempt.reservation?.resolve() ??
            attempt.request.anchor;
          attempt.effectiveAnchor = executionAnchor;
          const operationGeneration = activeWorkspaceGenerationRef.current;
          const isCurrent = (): boolean =>
            sessionRecordRef.current === attempt.record &&
            !attempt.record.closing &&
            sessionRef.current === attempt.record.session &&
            activeWorkspaceGenerationRef.current === operationGeneration;
          let mutationOutcomeKnown = false;
          try {
            if (
              attempt.request.kind === "paths" &&
              !context.repository.importImageNodePaths
            ) {
              throw new Error("Image node path import is unavailable.");
            }
            if (
              attempt.request.kind === "bytes" &&
              !context.repository.importImageNodeBytes
            ) {
              throw new Error("Image node byte import is unavailable.");
            }
            attempt.started = true;
            const response =
              attempt.request.kind === "paths"
                ? await context.repository.importImageNodePaths!(
                    context.vaultRoot,
                    {
                      parentId: executionAnchor.parentId,
                      afterId: executionAnchor.afterId,
                      items: attempt.request.items,
                      initialMaxDisplayWidth: attempt.initialMaxDisplayWidth
                    },
                    ...historyArguments(historyContext)
                  )
                : await context.repository.importImageNodeBytes!(
                    context.vaultRoot,
                    {
                      parentId: executionAnchor.parentId,
                      afterId: executionAnchor.afterId,
                      items: attempt.request.items,
                      initialMaxDisplayWidth: attempt.initialMaxDisplayWidth
                    },
                    ...historyArguments(historyContext)
                  );
            const mutation = unwrapNotesMutation(response);
            mutationOutcomeKnown = true;
            attempt.unknownOutcome = false;
            const appliedContext = appliedHistoryContext(historyContext, mutation);
            const importedTailId = mutation.importedRootIds?.at(-1);
            if (importedTailId) {
              attempt.reservation?.commit(importedTailId);
            }
            const projection = await projectNotesMutation(
              context,
              mutation,
              attempt.scope
            );
            if (!isCurrent()) {
              discardHistoryEntry(historyContext);
              removeAttachmentUploadAttempt(attempt);
              return directMutationResult(
                mutation,
                projection,
                undefined,
                attempt.scope
              );
            }
            const importedRootId = mutation.importedRootIds?.[0] ?? null;
            const uiUpdate = importedRootId
              ? {
                  selectedId: importedRootId,
                  editingNoteId: importedRootId,
                  pendingFocusId: importedRootId,
                  pendingFocusField: "title" as const
                }
              : undefined;
            rememberHistoryAfter(
              appliedContext,
              projection.workspace,
              uiUpdate
            );
            removeAttachmentUploadAttempt(attempt);
            publishLatestAttachmentAttemptError(attempt.nodeId);
            return directMutationResult(
              mutation,
              projection,
              uiUpdate,
              attempt.scope
            );
          } catch (cause) {
            const message = `Image upload failed: ${errorMessage(cause)}`;
            if (!attempt.started && !attempt.unknownOutcome) {
              removeAttachmentUploadAttempt(attempt);
              discardHistoryEntry(attempt.historyContext);
              setAttachmentUploadError(attempt.nodeId, message);
              return { kind: "failure", error: message };
            }
            attempt.unknownOutcome = true;
            attempt.status = "failed";
            attempt.error = message;
            if (!isCurrent()) {
              attempt.detached = true;
              removeAttachmentUploadAttempt(attempt);
              retainAttachmentUploadAttemptForRecovery(attempt);
              return { kind: "failure", error: message };
            }
            publishLatestAttachmentAttemptError(attempt.nodeId);
            return { kind: "failure", error: message };
          } finally {
            // A rejected native response has an unknown commit outcome. Keep
            // its turn, insertion reservation, and retry bytes until an exact
            // idempotent retry reconciles the sequence.
            if (
              mutationOutcomeKnown ||
              (!attempt.started && !attempt.unknownOutcome)
            ) {
              finalizeAttachmentUploadAttempt(attempt);
            }
          }
          },
          {
            historyContext: attempt.historyContext,
            retainHistoryOnFailure: true
          }
        );
        attempt.structuralIntent =
          attempt.record.structuralIntents.find(
            (intent) => !priorStructuralIntents.has(intent)
          ) ?? null;
        outcome = await completion;
      } catch {
        if (!attempt.started && !attempt.unknownOutcome) {
          discardPendingAttachmentUploadAttempt(attempt);
        } else if (!attempt.started && attempt.unknownOutcome) {
          attempt.status = "failed";
          attempt.error ??= retainedUnknownError;
          if (attempt.detached) {
            if (attempt.recoveryOwner) {
              notifyImageImportRecovery(attempt.recoveryOwner);
            }
          } else {
            publishLatestAttachmentAttemptError(attempt.nodeId);
          }
        }
        return;
      } finally {
        attempt.enqueueCompletionSettled = true;
        releaseFinalizedDetachedAttachmentUploadAttempts(attempt.record);
      }
      if (
        outcome !== "committed" &&
        !attempt.started &&
        attempt.unknownOutcome
      ) {
        attempt.status = "failed";
        attempt.error ??= retainedUnknownError;
        if (attempt.detached) {
          if (attempt.recoveryOwner) {
            notifyImageImportRecovery(attempt.recoveryOwner);
          }
        } else {
          publishLatestAttachmentAttemptError(attempt.nodeId);
        }
      } else if (
        outcome !== "committed" &&
        !attempt.started &&
        !attempt.unknownOutcome
      ) {
        discardPendingAttachmentUploadAttempt(attempt);
      }
    },
    [
      discardHistoryEntry,
      discardPendingAttachmentUploadAttempt,
      publishLatestAttachmentAttemptError,
      rememberHistoryAfter,
      releaseFinalizedDetachedAttachmentUploadAttempts,
      removeAttachmentUploadAttempt,
      runStructuralCommand,
      setAttachmentUploadError
    ]
  );

  const importImagePaths = useCallback(
    async (
      nodeId: NoteId,
      paths: readonly string[],
      initialMaxDisplayWidth: number,
      capturedAnchor?: ImageNodeInsertionAnchor
    ): Promise<void> => {
      if (paths.length === 0) return;
      if (!repository.importImageNodePaths) {
        setAttachmentUploadError(
          nodeId,
          "Image upload failed: Image node path import is unavailable."
        );
        return;
      }
      if (
        !Number.isSafeInteger(initialMaxDisplayWidth) ||
        initialMaxDisplayWidth <= 0
      ) {
        setAttachmentUploadError(nodeId, "Image area is not ready.");
        return;
      }
      try {
        const currentAnchor = imageNodeInsertionAnchor(stateRef.current, nodeId);
        if (capturedAnchor) {
          if (
            currentAnchor === null ||
            !sameImageNodeInsertionAnchor(currentAnchor, capturedAnchor)
          ) {
            return;
          }
        }
        const anchor = capturedAnchor ?? currentAnchor;
        if (anchor === null) {
          return;
        }
        const request: ImageNodeImportRequest = {
          kind: "paths",
          anchor,
          items: imageNodePathItems(paths, createImageNodeIdPairs(paths.length))
        };
        const attempt = createAttachmentUploadAttempt(
          nodeId,
          request,
          initialMaxDisplayWidth
        );
        if (attempt) await executeAttachmentUploadAttempt(attempt);
      } catch (cause) {
        setAttachmentUploadError(nodeId, errorMessage(cause));
      }
    },
    [
      createAttachmentUploadAttempt,
      executeAttachmentUploadAttempt,
      repository,
      setAttachmentUploadError
    ]
  );

  const importClipboardImages = useCallback(
    async (
      nodeId: NoteId,
      items: readonly PendingImageNodeByteItem[]
    ): Promise<void> => {
      if (items.length === 0) return;
      if (!repository.importImageNodeBytes) {
        setAttachmentUploadError(
          nodeId,
          "Image upload failed: Image node byte import is unavailable."
        );
        return;
      }
      const retainedByteSize = clipboardImageBatchByteSize(items);
      if (retainedByteSize === null) {
        setAttachmentUploadError(nodeId, "Invalid clipboard image batch.");
        return;
      }
      const initialMaxDisplayWidth = imageImportMaxDisplayWidthRef.current ?? 0;
      if (
        !Number.isSafeInteger(initialMaxDisplayWidth) ||
        initialMaxDisplayWidth <= 0
      ) {
        setAttachmentUploadError(nodeId, "Image area is not ready.");
        return;
      }
      try {
        const anchor = imageNodeInsertionAnchor(stateRef.current, nodeId);
        if (anchor === null) {
          return;
        }
        if (!admitAttachmentUploadBytes(retainedByteSize)) {
          setAttachmentUploadError(
            nodeId,
            "Clipboard image retry data exceeds the 64 MiB memory limit."
          );
          return;
        }
        const request: ImageNodeImportRequest = {
          kind: "bytes",
          anchor,
          items: imageNodeByteItems(
            items,
            createImageNodeIdPairs(items.length)
          )
        };
        const attempt = createAttachmentUploadAttempt(
          nodeId,
          request,
          initialMaxDisplayWidth,
          retainedByteSize
        );
        if (attempt) await executeAttachmentUploadAttempt(attempt);
      } catch (cause) {
        setAttachmentUploadError(nodeId, errorMessage(cause));
      }
    },
    [
      admitAttachmentUploadBytes,
      createAttachmentUploadAttempt,
      executeAttachmentUploadAttempt,
      repository,
      setAttachmentUploadError
    ]
  );

  const importDroppedImagePaths = useCallback(
    async (nodeId: NoteId, paths: readonly string[]): Promise<void> => {
      await importImagePaths(
        nodeId,
        paths,
        imageImportMaxDisplayWidthRef.current ?? 0
      );
    },
    [importImagePaths]
  );

  const uploadImage = useCallback(
    async (nodeId: NoteId): Promise<void> => {
      if (vaultRoot.trim().length === 0) {
        return;
      }
      const invocationRecord = sessionRecordRef.current;
      const initialMaxDisplayWidth =
        imageImportMaxDisplayWidthRef.current ?? 0;
      const capturedAnchor = imageNodeInsertionAnchor(
        stateRef.current,
        nodeId
      );
      if (capturedAnchor === null) {
        return;
      }
      try {
        const sourcePaths = await attachmentUi.openImageFiles();
        if (
          !invocationRecord ||
          invocationRecord.closing ||
          sessionRecordRef.current !== invocationRecord ||
          invocationRecord.repository !== repository ||
          invocationRecord.vaultRoot !== vaultRoot
        ) {
          return;
        }
        if (sourcePaths === null || sourcePaths.length === 0) return;
        await importImagePaths(
          nodeId,
          sourcePaths,
          initialMaxDisplayWidth,
          capturedAnchor
        );
      } catch (cause) {
        if (
          !invocationRecord ||
          invocationRecord.closing ||
          sessionRecordRef.current !== invocationRecord
        ) {
          return;
        }
        setAttachmentUploadError(
          nodeId,
          `Image picker failed: ${errorMessage(cause)}`
        );
      }
    },
    [
      attachmentUi,
      importImagePaths,
      repository,
      setAttachmentUploadError,
      vaultRoot
    ]
  );

  const retryImageUpload = useCallback(
    async (nodeId: NoteId, attemptId?: string): Promise<void> => {
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(nodeId);
      const failedAttempt = attemptId
        ? attempts?.get(attemptId)
        : undefined;
      if (attemptId) {
        if (failedAttempt?.status === "failed") {
          const record = sessionRecordRef.current;
          if (
            !record ||
            record.closing ||
            record.repository !== repository ||
            record.vaultRoot !== vaultRoot
          ) {
            return;
          }
          if (
            failedAttempt.recoveryOwner &&
            (failedAttempt.recoveryOwner.repository !== repository ||
              failedAttempt.recoveryOwner.vaultRoot !== vaultRoot)
          ) {
            return;
          }
          failedAttempt.record = record;
          if (failedAttempt.historyContext) {
            registerHistoryOwner(
              failedAttempt.historyContext,
              record.session
            );
          }
          failedAttempt.scope = cloneWorkspaceScope(activeScopeRef.current);
          await executeAttachmentUploadAttempt(failedAttempt);
        }
        return;
      }
      await uploadImage(nodeId);
    },
    [
      executeAttachmentUploadAttempt,
      registerHistoryOwner,
      repository,
      uploadImage,
      vaultRoot
    ]
  );

  const currentAttachmentActionRecord = useCallback(
    (): NotesWorkspaceSessionRecord | null => {
      if (
        attachmentActionGenerationRef.current !==
          attachmentActionGeneration ||
        closedRef.current ||
        isNotesDataDeletionInProgress(
          attachmentActionGeneration.repository,
          attachmentActionGeneration.vaultRoot
        )
      ) {
        return null;
      }
      const record = sessionRecordRef.current;
      return record &&
        !record.closing &&
        record.repository === attachmentActionGeneration.repository &&
        record.vaultRoot === attachmentActionGeneration.vaultRoot &&
        sessionRef.current === record.session
        ? record
        : null;
    },
    [attachmentActionGeneration]
  );

  const loadAttachmentBytes = useCallback(
    async (attachmentId: string): Promise<Uint8Array> => {
      const record = currentAttachmentActionRecord();
      const readAttachmentBytes = record?.repository.readAttachmentBytes;
      if (!record || !readAttachmentBytes) {
        throw new Error("Image loading is unavailable.");
      }
      return readAttachmentBytes(record.vaultRoot, attachmentId);
    },
    [currentAttachmentActionRecord]
  );

  const viewImageOriginal = useCallback(
    async (attachmentId: string): Promise<void> => {
      const record = currentAttachmentActionRecord();
      if (!record) {
        return;
      }

      const openAttachmentOriginal = record.repository.openAttachmentOriginal;
      if (!openAttachmentOriginal) {
        throw new Error("Opening image originals is unavailable.");
      }
      await openAttachmentOriginal(record.vaultRoot, attachmentId);
    },
    [currentAttachmentActionRecord]
  );

  const downloadImage = useCallback(
    async (
      attachmentId: string,
      _originalName: string,
      _mimeType: NoteAttachment["mimeType"]
    ): Promise<void> => {
      const record = currentAttachmentActionRecord();
      if (!record) {
        return;
      }

      const downloadAttachment = record.repository.downloadAttachment;
      if (!downloadAttachment) {
        throw new Error("Image download is unavailable.");
      }

      await downloadAttachment(record.vaultRoot, attachmentId);
    },
    [currentAttachmentActionRecord]
  );

  const resizeImage = useCallback(
    async (attachmentId: string, displayWidth: number): Promise<void> =>
      runStructuralCommand(
        "attachment-resize",
        async (context, historyContext) => {
          const attachmentExists = Object.values(
            confirmedState(context).attachmentsByNodeId
          ).some((attachments) =>
            attachments.some((attachment) => attachment.id === attachmentId)
          );
          if (!attachmentExists || !context.repository.resizeAttachment) {
            return { kind: "skipped" };
          }
          const mutation = unwrapNotesMutation(
            await context.repository.resizeAttachment(
              context.vaultRoot,
              { id: attachmentId, displayWidth },
              ...historyArguments(historyContext)
            )
          );
          const projection = await projectNotesMutation(
            context,
            mutation,
            activeScopeRef.current
          );
          rememberHistoryAfter(
            appliedHistoryContext(historyContext, mutation),
            projection.workspace
          );
          return directMutationResult(mutation, projection);
        }
      ).then(() => undefined),
    [rememberHistoryAfter, runStructuralCommand]
  );

  const removeImage = useCallback(
    async (attachmentId: string): Promise<void> =>
      runStructuralCommand(
        "attachment-remove",
        async (context, historyContext) => {
          const attachmentExists = Object.values(
            confirmedState(context).attachmentsByNodeId
          ).some((attachments) =>
            attachments.some((attachment) => attachment.id === attachmentId)
          );
          if (!attachmentExists || !context.repository.removeAttachment) {
            return { kind: "skipped" };
          }
          const mutation = unwrapNotesMutation(
            await context.repository.removeAttachment(
              context.vaultRoot,
              attachmentId,
              ...historyArguments(historyContext)
            )
          );
          const projection = await projectNotesMutation(
            context,
            mutation,
            activeScopeRef.current
          );
          rememberHistoryAfter(
            appliedHistoryContext(historyContext, mutation),
            projection.workspace
          );
          return directMutationResult(mutation, projection);
        }
      ).then(() => undefined),
    [rememberHistoryAfter, runStructuralCommand]
  );

  const actions = useMemo<NotesWorkspaceActions>(() => {
    const deletionInProgress = (): boolean =>
      isNotesDataDeletionInProgress(repository, vaultRoot);
    const gate = <Args extends unknown[]>(
      action: (...args: Args) => Promise<void>
    ) =>
      (...args: Args): Promise<void> =>
        deletionInProgress() ? Promise.resolve() : action(...args);

    // Structural actions report their settlement, so the data-deletion
    // short-circuit resolves to "skipped" (the command never reached the queue).
    const gateOutcome = <Args extends unknown[]>(
      action: (...args: Args) => Promise<NotesWorkspaceCommandOutcome>
    ) =>
      (...args: Args): Promise<NotesWorkspaceCommandOutcome> =>
        deletionInProgress()
          ? Promise.resolve("skipped")
          : action(...args);

    return {
      acknowledgeFocus: gate(acknowledgeFocus),
      focusNode: gate(focusNode),
      markEditingFocus: (nodeId, field) => {
        if (!deletionInProgress()) {
          markEditingFocus(nodeId, field);
        }
      },
      getNavigationVersion,
      createRoot: gateOutcome(createRoot),
      createNextTextSibling: gateOutcome(createNextTextSibling),
      splitNode: gateOutcome(splitNode),
      createChild: gateOutcome(createChild),
      updateNode: gateOutcome(updateNode),
      updateNodeDraft: (nodeId, patch, field) => {
        if (!deletionInProgress()) {
          updateNodeDraft(nodeId, patch, field);
        }
      },
      flushNodeDraft: (nodeId) =>
        deletionInProgress()
          ? Promise.resolve(false)
          : flushNodeDraft(nodeId),
      flushAllDrafts: () =>
        deletionInProgress()
          ? Promise.resolve(false)
          : flushAllDraftsBeforeStructural(),
      moveNode: gateOutcome(moveNode),
      applyBatch: gateOutcome(applyBatch),
      importSubtree: gateOutcome(importSubtree),
      toggleComplete: gateOutcome(toggleComplete),
      toggleCollapsed: gateOutcome(toggleCollapsed),
      expandAll: gateOutcome(expandAll),
      collapseAll: gateOutcome(collapseAll),
      sortSubtreeAscending: gateOutcome(sortSubtreeAscending),
      sortSubtreeDescending: gateOutcome(sortSubtreeDescending),
      toggleStar: gateOutcome(toggleStar),
      duplicateNode: gateOutcome(duplicateNode),
      removeEmptyNode: gateOutcome(removeEmptyNode),
      deleteNode: gateOutcome(deleteNode),
      restoreNode: gateOutcome(restoreNode),
      archiveNode: gateOutcome(archiveNode),
      unarchiveNode: gateOutcome(unarchiveNode),
      emptyTrash: gateOutcome(emptyTrash),
      selectLibraryView: gate(selectLibraryView),
      toggleTagFilter: gate(toggleTagFilter),
      searchNotes: (query) =>
        deletionInProgress()
          ? Promise.resolve([])
          : searchNotes(query),
      openSearchResult: gate(openSearchResult),
      deleteAllNotesData,
      zoomTo: gate(zoomTo),
      uploadImage: gate(uploadImage),
      importDroppedImagePaths: gate(importDroppedImagePaths),
      importClipboardImages: gate(importClipboardImages),
      retryImageUpload: gate(retryImageUpload),
      setImageImportMaxDisplayWidth,
      loadAttachmentBytes,
      viewImageOriginal: gate(viewImageOriginal),
      downloadImage: gate(downloadImage),
      resizeImage: gate(resizeImage),
      removeImage: gate(removeImage),
      undo: gate(undo),
      redo: gate(redo),
      setSelectionAnchor,
      extendSelectionTo,
      clearSelection,
      replaceSelection,
      getSelectionSnapshot
    };
  }, [
    repository,
    vaultRoot,
    acknowledgeFocus,
    focusNode,
    markEditingFocus,
    getNavigationVersion,
    createRoot,
    createNextTextSibling,
    splitNode,
    createChild,
    updateNode,
    updateNodeDraft,
    flushNodeDraft,
    flushAllDraftsBeforeStructural,
    moveNode,
    applyBatch,
    importSubtree,
    toggleComplete,
    toggleCollapsed,
    expandAll,
    collapseAll,
    sortSubtreeAscending,
    sortSubtreeDescending,
    toggleStar,
    duplicateNode,
    removeEmptyNode,
    deleteNode,
    restoreNode,
    archiveNode,
    unarchiveNode,
    emptyTrash,
    selectLibraryView,
    toggleTagFilter,
    searchNotes,
    openSearchResult,
    deleteAllNotesData,
    zoomTo,
    uploadImage,
    importDroppedImagePaths,
    importClipboardImages,
    retryImageUpload,
    setImageImportMaxDisplayWidth,
    loadAttachmentBytes,
    viewImageOriginal,
    downloadImage,
    resizeImage,
    removeImage,
    undo,
    redo,
    setSelectionAnchor,
    extendSelectionTo,
    clearSelection,
    replaceSelection,
    getSelectionSnapshot
  ]);

  const isPreparedSelectionAuthorityCurrent = useCallback(
    (prepared: NotesPreparedSelectionAuthority): boolean => {
      const record = sessionRecordRef.current;
      return (
        prepared.token === selectionPreparationTokenRef.current &&
        prepared.vaultRoot === vaultRootRef.current &&
        sameScope(prepared.scope, activeScopeRef.current) &&
        prepared.generation === activeWorkspaceGenerationRef.current &&
        prepared.selectionRevision === selectionRevisionRef.current &&
        prepared.session === sessionRef.current &&
        record !== null &&
        !record.closing &&
        record.session === prepared.session &&
        prepared.selectedNodeIds.length > 0 &&
        prepared.selectedNodeIds.every(
          (nodeId) => prepared.workspace.nodesById[nodeId] !== undefined
        )
      );
    },
    []
  );

  const prepareSelectionAuthority = useCallback(
    async (
      selectedNodeIds: readonly NoteId[]
    ): Promise<NotesPreparedSelectionAuthority> => {
      const ids = [...selectedNodeIds];
      if (ids.length === 0 || new Set(ids).size !== ids.length) {
        throw new Error("A valid selected range is required.");
      }
      const record = sessionRecordRef.current;
      const session = sessionRef.current;
      if (
        !record ||
        record.closing ||
        !session ||
        record.session !== session
      ) {
        throw new Error("Notes are not ready.");
      }
      // This token is a session/lifecycle epoch, not a "latest request wins"
      // counter. Preview hydration and command preparation may legitimately
      // overlap; vault/session resets increment the epoch and invalidate both.
      const token = selectionPreparationTokenRef.current;
      const preparedVaultRoot = vaultRoot;
      const scope = cloneWorkspaceScope(activeScopeRef.current);
      if (scope.kind === "tags") {
        for (const filter of scope.tags) {
          Object.freeze(filter);
        }
        Object.freeze(scope.tags);
      }
      Object.freeze(scope);
      const generation = activeWorkspaceGenerationRef.current;
      const selectionRevision = selectionRevisionRef.current;
      const activeWorkspace = freezeActiveAuthorityWorkspace(
        await repository.loadWorkspace(preparedVaultRoot, { kind: "active" })
      );
      if (
        token !== selectionPreparationTokenRef.current ||
        vaultRootRef.current !== preparedVaultRoot ||
        !sameScope(activeScopeRef.current, scope) ||
        activeWorkspaceGenerationRef.current !== generation ||
        selectionRevisionRef.current !== selectionRevision ||
        sessionRef.current !== session ||
        sessionRecordRef.current !== record ||
        record.closing
      ) {
        throw new Error("Notes changed while preparing the selection.");
      }
      if (ids.some((nodeId) => activeWorkspace.nodesById[nodeId] === undefined)) {
        throw new Error("A selected note is no longer active.");
      }
      return Object.freeze({
        token,
        vaultRoot: preparedVaultRoot,
        scope,
        generation,
        session,
        selectionRevision,
        selectedNodeIds: Object.freeze(ids),
        workspace: activeWorkspace
      });
    },
    [repository, vaultRoot]
  );

  const applyPreparedSelectionBatch = useCallback(
    (
      prepared: NotesPreparedSelectionAuthority,
      op: NotesBatchOp,
      options?: NotesPreparedSelectionBatchOptions
    ): Promise<NotesBatchCommandSettlement> =>
      applyPreparedSelectionBatchCommand(
        commandCtx,
        prepared,
        op,
        focusedUiUpdate(options?.focusNodeId),
        options?.expandNodeId,
        options?.expectedNavigationVersion ?? navigationVersionRef.current
      ),
    [commandCtx]
  );

  const loadActiveNodesForMove = useCallback(
    async (): Promise<readonly NoteNode[]> =>
      (await repository.loadWorkspace(vaultRoot, { kind: "active" })).nodes,
    [repository, vaultRoot]
  );

  const prepareMoveNode = useCallback(
    async (nodeId: NoteId): Promise<NotesPreparedMove> => {
      const token = movePreparationTokenRef.current + 1;
      movePreparationTokenRef.current = token;
      const preparedVaultRoot = vaultRoot;
      const preparedScope = cloneWorkspaceScope(activeScopeRef.current);
      const generation = activeWorkspaceGenerationRef.current;
      const nodes = (await loadActiveNodesForMove()).map((node) => ({
        ...node
      }));
      if (
        token !== movePreparationTokenRef.current ||
        vaultRootRef.current !== preparedVaultRoot ||
        !sameScope(activeScopeRef.current, preparedScope) ||
        activeWorkspaceGenerationRef.current !== generation
      ) {
        throw new Error("Notes changed while Move To was opening.");
      }
      const nodesById = Object.fromEntries(
        nodes.map((node) => [node.id, node])
      ) as Record<NoteId, NoteNode>;
      if (!isActiveMoveNode(nodesById[nodeId])) {
        throw new Error("This note is no longer active.");
      }
      return {
        token,
        vaultRoot: preparedVaultRoot,
        scope: preparedScope,
        generation,
        sourceId: nodeId,
        nodes
      };
    },
    [loadActiveNodesForMove, vaultRoot]
  );

  const commitPreparedMove = useCallback(
    (
      prepared: NotesPreparedMove,
      destinationId: NoteId | null
    ): Promise<NotesPreparedMoveCommitResult> =>
      commitPreparedMoveCommand(commandCtx, prepared, destinationId),
    [commandCtx]
  );

  const stateSlice = useMemo<NotesStateSlice>(
    () => ({
      state,
      deletingNotesData,
      libraryView,
      activeTagFilters,
      tagSummaries,
      locallyExpandedNodeIds,
      status: state.status,
      loading: state.status === "loading",
      error: state.error,
      canUndo: historyStatus.canUndo,
      canRedo: historyStatus.canRedo
    }),
    [
      state,
      deletingNotesData,
      libraryView,
      activeTagFilters,
      tagSummaries,
      locallyExpandedNodeIds,
      historyStatus
    ]
  );

  const draftsSlice = useMemo<NotesDraftsSlice>(
    () => ({
      draftsByNodeId,
      writeError: currentWriteError,
      attachmentUploadErrorsByNodeId,
      attachmentUploadRetryAttemptIdsByNodeId,
      selection,
      selectionRevision: selectionRevisionRef.current
    }),
    [
      draftsByNodeId,
      currentWriteError,
      attachmentUploadErrorsByNodeId,
      attachmentUploadRetryAttemptIdsByNodeId,
      selection
    ]
  );

  const actionsSlice = useMemo<NotesActionsSlice>(
    () => ({
      actions,
      retryFailedDraft,
      retryLastFailedWrite,
      loadActiveNodesForMove,
      prepareMoveNode,
      commitPreparedMove,
      prepareSelectionAuthority,
      isPreparedSelectionAuthorityCurrent,
      applyPreparedSelectionBatch
    }),
    [
      actions,
      retryFailedDraft,
      retryLastFailedWrite,
      loadActiveNodesForMove,
      prepareMoveNode,
      commitPreparedMove,
      prepareSelectionAuthority,
      isPreparedSelectionAuthorityCurrent,
      applyPreparedSelectionBatch
    ]
  );

  return {
    ...stateSlice,
    ...draftsSlice,
    ...actionsSlice,
    stateSlice,
    draftsSlice,
    actionsSlice
  };
}
