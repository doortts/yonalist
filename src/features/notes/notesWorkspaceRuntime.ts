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
import { MAX_NOTE_ATTACHMENT_BATCH_BYTES } from "../../domain/notes";
import type {
  ImageAtomEdit,
  LogicalSelection,
  MoveNoteNodeInput,
  NoteAttachment,
  NoteId,
  NoteImportNode,
  NoteNode,
  NotesHistoryContext,
  NotesHistoryStatus,
  NoteSearchResult,
  NoteTagFilter,
  NoteTagSummary,
  NotesStoreError,
  NotesWorkspace,
  NotesWorkspaceScope,
  PendingImageNodeByteItem
} from "../../domain/notes";
import { createNotesWriteQueue } from "../../services/notesWriteQueue";
import {
  notesWorkspaceCoordinatorRegistry,
  type NotesDraftEngineCoordinatorSession,
  type NotesPendingSelectionPolicy,
  type NotesWorkspaceCommandOutcome,
  type NotesWorkspaceCoordinatorSession,
  type NotesWorkspaceQueueContext,
  type NotesWorkspaceQueueResult,
  type NotesWorkspaceQueueWork,
  type NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import {
  createNotesHistoryOwnerRegistry,
  notesExpansionSnapshotPool,
  type NotesHistoryFocus,
  type NotesHistoryFocusField,
  type NotesHistoryLocationSnapshot,
  type NotesHistorySnapshot,
  normalizeHistoryPrimarySelection
} from "./notesHistory";
import {
  normalizeWorkspace,
  notesSelectionReducer,
  notesWorkspaceReducer,
  reconcileUiState,
  type NormalizedNotesWorkspace,
  type NotesSelection,
  type NotesSelectionAction,
  type NotesWorkspaceReducerAction
} from "./notesWorkspaceReducer";
import {
  canonicalizeTagFilters,
  sameScope,
  tagFilterKey
} from "./notesWorkspaceScope";
import { parseAndValidateNoteSearchQuery } from "./noteSearchQuery";
import {
  nativeNotesAttachmentUi
} from "./notesAttachmentController";
import { isActiveMoveNode } from "./notesMoveTargets";
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
  isNotesDataDeletionInProgress,
  notesDataDeletionParticipants,
  registerNotesDataDeletionParticipant,
  releaseNotesDataDeletion,
  reserveNotesDataDeletion,
  subscribeToNotesDataDeletion
} from "./notesDataDeletionRegistry";
import {
  createNotesImageAtomEditorRegistry,
  type ActiveImageAtomEditor,
  type ImageAtomEditorSelectionAuthority,
  type NotesImageAtomEditorAuthority,
  type NotesImageAtomFlushAdapter
} from "./notesImageAtomEditorRegistry";
import {
  applyBatchCommand,
  applyPreparedSelectionBatchCommand,
  commitPreparedMoveCommand,
  createChildCommand,
  createNextTextSiblingCommand,
  createRootCommand,
  applyImageAtomEditCommand,
  applyImageAtomPasteCommand,
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
import type { ParsedImageAtomPaste } from "./notesImageAtomClipboard";
import {
  authoritative,
  unwrapNotesMutation,
  type UnwrappedNotesMutation
} from "./notesWorkspaceProjection";
import {
  confirmedState,
  directMutationResult,
  emptyHistoryState,
  expansionsOutsideSubtree,
  focusedUiUpdate,
  historyArguments,
  projectNotesMutation
} from "./notesWorkspaceCommandSupport";
import type {
  LiveNotesNavigation,
  NotesActionsSlice,
  NotesDeleteAllOptions,
  NotesDeleteAllResult,
  NotesDraftsSlice,
  NotesImageAtomPasteAuthority,
  NotesLibraryView,
  NotesNodeDraft,
  NotesPendingPrimarySelection,
  NotesPreparedMove,
  NotesPreparedMoveCommitResult,
  NotesPreparedSelectionAuthority,
  NotesPreparedSelectionBatchOptions,
  NotesStateSlice,
  NotesWorkspaceActions,
  NotesWorkspaceCompoundOptions,
  ProjectedNotesMutation,
  StructuralCommandOptions,
  TagFilterOrigin,
  UseNotesWorkspaceHookResult,
  UseNotesWorkspaceOptions
} from "./notesWorkspaceTypes";
import {
  cloneOwnedHistorySnapshot,
  cloneWorkspaceScope,
  errorMessage,
  freezeActiveAuthorityWorkspace,
  libraryStateForScope,
  releaseOwnedHistorySnapshot,
  restoredTagFilterNavigation,
  sameHistorySnapshot,
  scopeForLibraryView,
  searchNavigation,
  snapshotForTagFilterOrigin,
  tagFilterOriginFromHistoryLocation,
  type NavigationIntent,
  type ResolvedHistoryLocation
} from "./notesWorkspaceNavigationSupport";
import {
  attachmentUploadAttempts,
  clipboardImageBatchByteSize,
  finalizeAttachmentUploadAttempt,
  notifyImageImportRecovery,
  notifyImageImportRecoveryFor,
  recoveredAttachmentUploadAttempts,
  releaseAttachmentUploadRecovery,
  releaseImageImportReservation,
  reserveImageImportOrderingTurn,
  retainAttachmentUploadAttemptForRecovery,
  retainedAttachmentUploadByteAttempts,
  subscribeToImageImportRecovery,
  type AttachmentUploadAttempt,
  type ImageNodeImportRequest
} from "./notesImageImportRecovery";

export type { ResolvedHistoryLocation } from "./notesWorkspaceNavigationSupport";
export { resetImageImportRecoveryForTests } from "./notesImageImportRecovery";

export {
  authoritative,
  scopedActiveDelta,
  unwrapNotesMutation
} from "./notesWorkspaceProjection";
export {
  confirmedState,
  directMutationResult,
  duplicateRootId,
  expansionsOutsideSubtree,
  focusedUiUpdate,
  hasMoveDependencies,
  historyArguments,
  notifySuccess,
  projectNotesMutation,
  resolveRootLifecycleNavigation,
  rootIdForNode,
  runCompoundQueueWork,
  samePreparedMoveNode,
  workspaceForScope
} from "./notesWorkspaceCommandSupport";
export type {
  RawNotesMutationDelta,
  UnwrappedNotesMutation
} from "./notesWorkspaceProjection";
export type * from "./notesWorkspaceTypes";

// The draft engine deliberately sees only its lifecycle subset. Records
// created by this hook always receive the registry's full public session.
function asCoordinatorSession(
  session: NotesDraftEngineCoordinatorSession
): NotesWorkspaceCoordinatorSession {
  return session as NotesWorkspaceCoordinatorSession;
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

interface CapturedImageAtomPasteAuthority
  extends NotesImageAtomPasteAuthority {
  readonly vaultRoot: string;
  readonly scope: NotesWorkspaceScope;
  readonly generation: number;
  readonly session: NotesWorkspaceCoordinatorSession;
  readonly record: NotesWorkspaceSessionRecord;
  readonly nodeId: NoteId;
  readonly nodeKind: NoteNode["nodeKind"];
  readonly nodeUpdatedAt: string;
  readonly nodeTitle: string;
  readonly nodeNote: string;
  readonly nodeImageOffsetUtf16: number;
  readonly attachmentId: string;
  readonly attachmentUpdatedAt: string;
  readonly attachmentContentHash: string;
  readonly draftRevision: number | null;
  readonly draftTitle: string;
  readonly draftNote: string;
  readonly draftImageOffsetUtf16: number;
  readonly editorAuthority: NotesImageAtomEditorAuthority;
}

function capturedImageAtomPasteAuthority(
  opaque: NotesImageAtomPasteAuthority
): CapturedImageAtomPasteAuthority {
  return opaque as CapturedImageAtomPasteAuthority;
}

function imageAtomPasteAuthorityMatches(
  opaque: NotesImageAtomPasteAuthority,
  current: {
    readonly vaultRoot: string;
    readonly scope: NotesWorkspaceScope;
    readonly generation: number;
    readonly session: NotesWorkspaceCoordinatorSession | null;
    readonly record: NotesWorkspaceSessionRecord | null;
    readonly workspace: NormalizedNotesWorkspace;
  }
): boolean {
  const authority = opaque as CapturedImageAtomPasteAuthority;
  const { record } = current;
  const node = current.workspace.nodesById[authority.nodeId];
  const attachments =
    current.workspace.attachmentsByNodeId?.[authority.nodeId] ?? [];
  const attachment = attachments.length === 1 ? attachments[0]! : null;
  const draft = record?.drafts.get(authority.nodeId);
  return Boolean(
    record &&
      !record.closing &&
      record === authority.record &&
      current.session === authority.session &&
      record.session === authority.session &&
      current.vaultRoot === authority.vaultRoot &&
      sameScope(current.scope, authority.scope) &&
      current.generation === authority.generation &&
      node &&
      node.id === authority.nodeId &&
      node.nodeKind === authority.nodeKind &&
      node.updatedAt === authority.nodeUpdatedAt &&
      node.title === authority.nodeTitle &&
      node.note === authority.nodeNote &&
      node.imageOffsetUtf16 === authority.nodeImageOffsetUtf16 &&
      attachment &&
      attachment.id === authority.attachmentId &&
      attachment.updatedAt === authority.attachmentUpdatedAt &&
      attachment.contentHash === authority.attachmentContentHash &&
      (draft?.revision ?? null) === authority.draftRevision &&
      (draft?.title ?? node.title) === authority.draftTitle &&
      (draft?.note ?? node.note) === authority.draftNote &&
      (draft?.imageOffsetUtf16 ?? node.imageOffsetUtf16) ===
        authority.draftImageOffsetUtf16
  );
}

const EMPTY_DRAFTS: Readonly<Record<NoteId, NotesNodeDraft>> = {};

interface BufferedWorkspaceCommand {
  work: NotesWorkspaceQueueWork;
  structural?: boolean;
  selectionPolicy?: NotesPendingSelectionPolicy;
  resolve(outcome: NotesWorkspaceCommandOutcome): void;
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

// Scope equality and tag-filter canonicalization live in one module so the
// coordinator and this hook compare scopes the same, key-order-independent way.
// Re-exported (below) because existing consumers (notesCommands, tests) import
// these names from the hook module.
export { canonicalizeTagFilters, sameScope, tagFilterKey };

export function useNotesWorkspace({
  vaultRoot,
  repository,
  attachmentUi = nativeNotesAttachmentUi,
  publishFeedback
}: UseNotesWorkspaceOptions): UseNotesWorkspaceHookResult {
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
  const [historyStatus, setHistoryStatus] =
    useState<NotesHistoryStatus>(emptyHistoryState);
  // The backend status only validates the mixed cursor. Availability itself is
  // owned by the session timeline, so a navigation-only entry re-renders every
  // sibling without being overwritten by backend mutation booleans.
  const [historyTimelineVersion, setHistoryTimelineVersion] = useState(0);
  const historyStatusRef = useRef(historyStatus);
  historyStatusRef.current = historyStatus;
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
  const imageAtomEditorRegistryRef = useRef({
    repository,
    vaultRoot,
    registry: createNotesImageAtomEditorRegistry()
  });
  if (
    imageAtomEditorRegistryRef.current.repository !== repository ||
    imageAtomEditorRegistryRef.current.vaultRoot !== vaultRoot
  ) {
    imageAtomEditorRegistryRef.current = {
      repository,
      vaultRoot,
      registry: createNotesImageAtomEditorRegistry()
    };
  }
  const imageAtomEditorRegistry = imageAtomEditorRegistryRef.current.registry;
  const registerActiveImageAtomEditor = useCallback(
    (editor: ActiveImageAtomEditor): (() => void) =>
      imageAtomEditorRegistry.register(editor),
    [imageAtomEditorRegistry]
  );
  const claimActiveImageAtomPaste = useCallback(
    (event: ClipboardEvent): boolean => imageAtomEditorRegistry.claimPaste(event),
    [imageAtomEditorRegistry]
  );
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
  // Selection replay is intentionally ref-owned: it is a one-shot DOM effect,
  // not durable navigation state. The authoritative reducer update that causes
  // a replay also causes the render which exposes this request to its target.
  const pendingPrimarySelectionRef =
    useRef<NotesPendingPrimarySelection | null>(null);
  const nextPrimarySelectionRequestIdRef = useRef(0);
  const navigationVersionRef = useRef(0);
  const sessionRef = useRef<NotesWorkspaceCoordinatorSession | null>(
    null
  );
  const outlineCompositionActiveRef = useRef(false);
  const pendingNavigationRef = useRef<{
    session: NotesWorkspaceCoordinatorSession;
    ownerToken: number;
    workspaceGeneration: number;
    intent: NavigationIntent;
  } | null>(null);
  const historyOwnerByEntryIdRef = useRef(
    createNotesHistoryOwnerRegistry<NotesWorkspaceCoordinatorSession>(
      200
    )
  );
  const recoveredHistoryResultByEntryIdRef = useRef(
    new Map<string, NotesWorkspaceQueueResult>()
  );
  const sessionRecordRef = useRef<NotesWorkspaceSessionRecord | null>(null);
  const draftEngineRef = useRef<NotesDraftEngine | null>(null);
  const captureActiveImageAtomEditorAuthority = useCallback(
    (
      nodeId: NoteId,
      selectionAuthority: ImageAtomEditorSelectionAuthority
    ): NotesImageAtomEditorAuthority | null =>
      imageAtomEditorRegistry.capturePasteAuthority(
        nodeId,
        selectionAuthority
      ),
    [imageAtomEditorRegistry]
  );
  const captureImageAtomPasteAuthority = useCallback(
    (
      nodeId: NoteId,
      editorAuthority: NotesImageAtomEditorAuthority
    ): NotesImageAtomPasteAuthority | null => {
      const record = sessionRecordRef.current;
      const session = sessionRef.current;
      const node = stateRef.current.nodesById[nodeId];
      const attachments = stateRef.current.attachmentsByNodeId?.[nodeId] ?? [];
      if (
        !record ||
        record.closing ||
        !session ||
        record.session !== session ||
        record.drafts.has(nodeId) ||
        !imageAtomEditorRegistry.isPasteAuthorityCurrent(editorAuthority) ||
        !node ||
        node.nodeKind !== "image" ||
        attachments.length !== 1
      ) {
        return null;
      }
      const attachment = attachments[0]!;
      const draft = record.drafts.get(nodeId);
      return {
        vaultRoot: vaultRootRef.current,
        scope: cloneWorkspaceScope(activeScopeRef.current),
        generation: activeWorkspaceGenerationRef.current,
        session,
        record,
        nodeId,
        nodeKind: node.nodeKind,
        nodeUpdatedAt: node.updatedAt,
        nodeTitle: node.title,
        nodeNote: node.note,
        nodeImageOffsetUtf16: node.imageOffsetUtf16,
        attachmentId: attachment.id,
        attachmentUpdatedAt: attachment.updatedAt,
        attachmentContentHash: attachment.contentHash,
        draftRevision: draft?.revision ?? null,
        draftTitle: draft?.title ?? node.title,
        draftNote: draft?.note ?? node.note,
        draftImageOffsetUtf16:
          draft?.imageOffsetUtf16 ?? node.imageOffsetUtf16,
        editorAuthority
      } as unknown as CapturedImageAtomPasteAuthority;
    },
    [imageAtomEditorRegistry]
  );
  const isImageAtomPasteAuthorityCurrent = useCallback(
    (authority: NotesImageAtomPasteAuthority): boolean =>
      imageAtomEditorRegistry.isPasteAuthorityCurrent(
        capturedImageAtomPasteAuthority(authority).editorAuthority
      ) &&
      imageAtomPasteAuthorityMatches(authority, {
        vaultRoot: vaultRootRef.current,
        scope: activeScopeRef.current,
        generation: activeWorkspaceGenerationRef.current,
        session: sessionRef.current,
        record: sessionRecordRef.current,
        workspace: stateRef.current
      }),
    [imageAtomEditorRegistry]
  );
  const draftsListenersRef = useRef(new Set<() => void>());
  const writeErrorListenersRef = useRef(new Set<() => void>());
  const bufferedCommandsRef = useRef<BufferedWorkspaceCommand[]>([]);
  const finalCleanupTokenRef = useRef<object | null>(null);
  const attachmentRecoveryChangeRef = useRef<() => void>(() => undefined);
  const closedRef = useRef(false);
  const captureHistoryLocationRef = useRef<() => NotesHistorySnapshot>(() => {
    throw new Error("Notes history presentation is not ready.");
  });
  const applyHistoryLocationRef = useRef<
    (workspace: NormalizedNotesWorkspace, snapshot: NotesHistorySnapshot) => boolean
  >(() => false);

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
      const pendingPrimarySelection = pendingPrimarySelectionRef.current;
      const invalidatesPrimarySelection =
        action.type === "focusNode" ||
        action.type === "setZoomRoot" ||
        action.type === "startWorkspaceLoad" ||
        action.type === "setLoading" ||
        (pendingPrimarySelection !== null &&
          (next.pendingFocusId !== pendingPrimarySelection.nodeId ||
            next.pendingFocusField !==
              pendingPrimarySelection.field ||
            next.nodesById[pendingPrimarySelection.nodeId] === undefined));
      if (invalidatesPrimarySelection) {
        pendingPrimarySelectionRef.current = null;
      }
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

  // A real user focus/edit supersedes an unconsumed replay range. This stays
  // ref-only, but uses the existing reducer acknowledgement so the next
  // low-volatility slice cannot re-publish a stale request.
  const retirePendingPrimarySelection = useCallback((): void => {
    const pendingPrimarySelection = pendingPrimarySelectionRef.current;
    if (pendingPrimarySelection === null) return;
    pendingPrimarySelectionRef.current = null;
    applyAction({
      type: "acknowledgePendingFocus",
      nodeId: pendingPrimarySelection.nodeId
    });
  }, [applyAction]);

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
    outlineCompositionActiveRef.current = false;
    pendingNavigationRef.current = null;
    const previousEngine = draftEngineRef.current;
    if (previousEngine) {
      prepareAttachmentUploadAttemptsForTeardown();
      void previousEngine.beginShutdown().finally(() => previousEngine.dispose());
    }
    applyAction({ type: "startWorkspaceLoad" });
    setAttachmentUploadErrorsByNodeId({});
    setAttachmentUploadRetryAttemptIdsByNodeId({});
    discardAttachmentUploadAttempts();
    const resetHistoryStatus = emptyHistoryState();
    historyStatusRef.current = resetHistoryStatus;
    setHistoryStatus(resetHistoryStatus);
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
      presentation: "writable",
      captureHistoryLocation: () => captureHistoryLocationRef.current(),
      applyHistoryLocation: (workspace, snapshot) =>
        applyHistoryLocationRef.current(workspace, snapshot),
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
          historyStatusRef.current = event.result.historyStatus;
          setHistoryStatus(event.result.historyStatus);
        }
        if (event.result.kind !== "skipped") {
          setHistoryTimelineVersion((version) => version + 1);
        }
        if (
          event.result.kind === "authoritative" &&
          event.result.tagSummaries !== undefined
        ) {
          setTagSummaries(event.result.tagSummaries);
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
          void session.enqueue(
            async (context) => {
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
            },
            { observer: true }
          );
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
      onWriteErrorChanged: notifyWriteErrorListeners,
      onCompositionInterrupted: () =>
        publishFeedback?.({
          kind: "error",
          message: "Text composition was interrupted. Try the action again."
        })
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
      outlineCompositionActiveRef.current = false;
      pendingNavigationRef.current = null;
      unregisterNotesDataDeletionParticipant();
      unsubscribeImageImportRecovery();
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
        void engine.beginShutdown().finally(() => engine.dispose());
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
            libraryView: origin.libraryView,
            activeTagFilters: [],
            selectedId: origin.navigation.selectedId,
            zoomRootId: origin.navigation.zoomRootId,
            expansion: notesExpansionSnapshotPool.acquire([
              ...origin.locallyExpandedNodeIds
            ]),
            focus: origin.navigation.editingNoteId
              ? {
                  nodeId: origin.navigation.editingNoteId,
                  field: origin.navigation.pendingFocusField ?? "title"
                }
              : null
          }
        : null;
      return {
        scope: cloneWorkspaceScope(activeScopeRef.current),
        libraryView: libraryViewRef.current,
        activeTagFilters:
          libraryViewRef.current === "tags"
            ? canonicalizeTagFilters(requestedTagFiltersRef.current)
            : [],
        selectedId: navigation.selectedId,
        zoomRootId: navigation.zoomRootId,
        expansion: notesExpansionSnapshotPool.acquire([...expandedNodeIds]),
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

  const applyHistoryLocation = useCallback(
    (
      workspace: NormalizedNotesWorkspace,
      snapshot: NotesHistorySnapshot
    ): boolean => {
      const exists = (nodeId: NoteId | null): boolean =>
        nodeId === null || Boolean(workspace.nodesById[nodeId]);
      if (
        !exists(snapshot.selectedId) ||
        !exists(snapshot.zoomRootId) ||
        !exists(snapshot.focus?.nodeId ?? null) ||
        snapshot.expansion.nodeIds.some((nodeId) => !workspace.nodesById[nodeId])
      ) {
        return false;
      }
      const origin = snapshot.tagFilterOrigin ?? null;
      if (origin?.libraryView === "tags") return false;

      // A replay supersedes any DOM request which has not yet committed. The
      // fresh request is published below only after the reducer commits this
      // location, so a stale effect can never consume it by node id alone.
      pendingPrimarySelectionRef.current = null;

      const activeTags =
        snapshot.libraryView === "tags"
          ? canonicalizeTagFilters(snapshot.activeTagFilters)
          : [];
      activeScopeRef.current = cloneWorkspaceScope(snapshot.scope);
      requestedTagFiltersRef.current = activeTags;
      tagFilterOriginRef.current = origin
        ? {
            scope: cloneWorkspaceScope(origin.scope),
            libraryView: origin.libraryView,
            navigation: {
              selectedId: origin.selectedId,
              zoomRootId: origin.zoomRootId,
              editingNoteId: origin.focus?.nodeId ?? null,
              pendingFocusId: origin.focus?.nodeId ?? null,
              pendingFocusField: origin.focus?.field ?? null
            },
            locallyExpandedNodeIds: new Set(origin.expansion.nodeIds)
          }
        : null;
      const expansion = new Set(snapshot.expansion.nodeIds);
      locallyExpandedNodeIdsRef.current = expansion;
      const replayFocus = snapshot.focus ? { ...snapshot.focus } : null;
      const replaySelection =
        replayFocus?.field === "title" ? replayFocus.primarySelection : undefined;
      const focusAlreadyAcknowledged =
        replaySelection === undefined &&
        replayFocus !== null &&
        editingFocusRef.current?.nodeId === replayFocus.nodeId &&
        editingFocusRef.current.field === replayFocus.field &&
        stateRef.current.pendingFocusId === null;
      editingFocusRef.current = replayFocus;
      navigationVersionRef.current += 1;
      activeWorkspaceGenerationRef.current += 1;
      libraryViewRef.current = snapshot.libraryView;
      setLibraryView(snapshot.libraryView);
      setActiveTagFilters(canonicalizeTagFilters(activeTags));
      setLocallyExpandedNodeIds(expansion);
      if (selectionRef.current !== null) {
        updateSelection({ type: "clearSelection" });
      }
      applyAction({
        type: "settleQueueWork",
        result: {
          kind: "authoritative",
          workspace: {
            nodes: Object.values(workspace.nodesById),
            attachmentsByNodeId: workspace.attachmentsByNodeId
          },
          uiUpdate: {
            selectedId: snapshot.selectedId,
            zoomRootId: snapshot.zoomRootId,
            editingNoteId: replayFocus?.nodeId ?? null,
            pendingFocusId: focusAlreadyAcknowledged
              ? null
              : replayFocus?.nodeId ?? null,
            pendingFocusField: focusAlreadyAcknowledged
              ? null
              : replayFocus?.field ?? null
          }
        },
        hasPendingWork: stateRef.current.status === "loading"
      });
      if (replayFocus?.field === "title" && replaySelection) {
        pendingPrimarySelectionRef.current = {
          requestId: ++nextPrimarySelectionRequestIdRef.current,
          nodeId: replayFocus.nodeId,
          field: "title",
          selection: { ...replaySelection }
        };
      }
      return true;
    },
    [applyAction, updateSelection]
  );

  // Resolving a replay target intentionally has no presentation side effects.
  // The caller owns the returned expansion revisions and transfers them only
  // after the cursor and coordinator canonical presentation have both settled.
  const resolveHistoryLocation = useCallback(
    async (
      requested: NotesHistorySnapshot,
      loadedWorkspace?: NotesWorkspace
    ): Promise<ResolvedHistoryLocation | null> => {
      const requestedLibrary = libraryStateForScope(requested.scope);
      const scope =
        requestedLibrary.view === "tags"
          ? { kind: "tags" as const, tags: [...requestedLibrary.filters] }
          : cloneWorkspaceScope(requested.scope);
      let workspace: NormalizedNotesWorkspace;
      try {
        workspace = normalizeWorkspace(
          loadedWorkspace ?? await repository.loadWorkspace(vaultRoot, scope)
        );
      } catch {
        return null;
      }
      const existing = (nodeId: NoteId | null): NoteId | null =>
        nodeId !== null && workspace.nodesById[nodeId] ? nodeId : null;
      const focus = requested.focus && workspace.nodesById[requested.focus.nodeId]
        ? {
            ...requested.focus,
            ...(requested.focus.field === "title" &&
            requested.focus.primarySelection
              ? {
                  primarySelection: normalizeHistoryPrimarySelection(
                    workspace.nodesById[requested.focus.nodeId],
                    requested.focus.primarySelection
                  )
                }
              : {})
          }
        : null;
      const origin = requested.tagFilterOrigin;
      const originLibrary = origin
        ? libraryStateForScope(origin.scope)
        : null;
      const resolvedOrigin = origin
        ? {
            scope:
              originLibrary?.view === "tags"
                ? {
                    kind: "tags" as const,
                    tags: [...originLibrary.filters]
                  }
                : cloneWorkspaceScope(origin.scope),
            // A tag filter always returns to an ordinary library source. Do
            // not validate those origin ids against this filtered projection.
            libraryView:
              originLibrary?.view === "tags" ? "all" : originLibrary!.view,
            activeTagFilters: [],
            selectedId: origin.selectedId,
            zoomRootId: origin.zoomRootId,
            expansion: notesExpansionSnapshotPool.acquire(
              origin.expansion.nodeIds
            ),
            focus: origin.focus ? { ...origin.focus } : null
          }
        : null;
      return {
        workspace,
        snapshot: {
          scope,
          libraryView: requestedLibrary.view,
          activeTagFilters: requestedLibrary.filters,
          selectedId: existing(requested.selectedId),
          zoomRootId: existing(requested.zoomRootId),
          expansion: notesExpansionSnapshotPool.acquire(
            requested.expansion.nodeIds.filter((nodeId) =>
              Boolean(workspace.nodesById[nodeId])
            )
          ),
          focus,
          tagFilterOrigin: resolvedOrigin
        }
      };
    },
    [repository, vaultRoot]
  );

  captureHistoryLocationRef.current = captureHistorySnapshot;
  applyHistoryLocationRef.current = applyHistoryLocation;

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
    ): NotesHistoryContext =>
      registerHistoryOwner(
        record.session.history.beginTextBurst(
          nodeId,
          captureHistorySnapshot(focus)
        ),
        asCoordinatorSession(record.session)
      ),
    [captureHistorySnapshot, registerHistoryOwner]
  );

  const beginStandaloneTextEntry = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      nodeId: NoteId,
      focus: NotesHistoryFocus
    ): NotesHistoryContext => {
      record.session.history.closeTextBurst();
      const context = registerHistoryOwner(
        record.session.history.beginTextBurst(
          nodeId,
          captureHistorySnapshot(focus)
        ),
        asCoordinatorSession(record.session)
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
      commandKind: string,
      before = captureHistorySnapshot()
    ): NotesHistoryContext => {
      return registerHistoryOwner(
        record.session.history.beginStructuralEntry(
          commandKind,
          before
        ),
        asCoordinatorSession(record.session)
      );
    },
    [captureHistorySnapshot, registerHistoryOwner]
  );

  const completeHistoryOwner = useCallback((entryId: string): void => {
    historyOwnerByEntryIdRef.current.complete(entryId);
  }, []);

  const rememberHistoryAfter = useCallback(
    async (
      context: NotesHistoryContext | null | undefined,
      workspace: NotesWorkspace,
      uiUpdate?: NotesWorkspaceUiUpdate,
      focus?: NotesHistoryFocus | null,
      expandedNodeIds?: ReadonlySet<NoteId>,
      requestedLocation?: NotesHistorySnapshot,
      recoveryLocation?: NotesHistorySnapshot,
      recoverySource?: Pick<
        NotesWorkspaceSessionRecord,
        "repository" | "vaultRoot"
      >,
      returnedHistoryState?: NotesHistoryStatus,
      rejectedHistoryState?: NotesHistoryStatus
    ): Promise<NotesWorkspaceQueueResult | null> => {
      if (!context) {
        return null;
      }
      const owner = historyOwnerByEntryIdRef.current.owner(context.entryId);
      if (!owner) {
        historyOwnerByEntryIdRef.current.discard(context.entryId);
        return null;
      }
      const recoverMutationMismatch = async (
        state: NotesHistoryStatus
      ): Promise<NotesWorkspaceQueueResult> => {
        const current = recoveryLocation
          ? cloneOwnedHistorySnapshot(recoveryLocation)
          : captureHistorySnapshot();
        try {
          const recovered = await owner.recoverHistoryMismatch(state, async () => {
            const recoveryWorkspace = recoverySource
              ? await recoverySource.repository.loadWorkspace(
                  recoverySource.vaultRoot,
                  current.scope
                )
              : undefined;
            const resolved = await resolveHistoryLocation(
              current,
              recoveryWorkspace
            );
            if (!resolved) {
              throw new Error("Notes history recovery could not reload its location.");
            }
            return resolved;
          });
          const result = recovered
            ? authoritative({
                nodes: Object.values(recovered.workspace.nodesById),
                attachmentsByNodeId: recovered.workspace.attachmentsByNodeId
              })
            : {
                kind: "failure" as const,
                error:
                  "Notes history could not be synchronized. Close and reopen this Vault."
              };
          recoveredHistoryResultByEntryIdRef.current.set(
            context.entryId,
            result
          );
          publishFeedback?.(
            recovered
              ? {
                  kind: "status",
                  message:
                    "Notes history was reset to recover synchronization."
                }
              : {
                  kind: "error",
                  message:
                    "Notes history could not be synchronized. Close and reopen this Vault."
              }
          );
          return result;
        } finally {
          releaseOwnedHistorySnapshot(current);
        }
      };
      if (rejectedHistoryState) {
        owner.history.discard(context.entryId);
        historyOwnerByEntryIdRef.current.discard(context.entryId);
        return recoverMutationMismatch(rejectedHistoryState);
      }
      // The post-mutation navigation is computed with the reducer's own
      // reconciler against the settled navigation — the exact value the reducer
      // will settle to when this result flows through settleQueueWork. No
      // parallel navigation ref is advanced; the snapshot is a pure derivation.
      let settledWorkspace = normalizeWorkspace(workspace);
      let after: NotesHistorySnapshot;
      if (requestedLocation) {
        const resolved = await resolveHistoryLocation(
          requestedLocation,
          workspace
        );
        if (!resolved) {
          owner.history.discard(context.entryId);
          historyOwnerByEntryIdRef.current.discard(context.entryId);
          return recoverMutationMismatch(historyStatusRef.current);
        }
        settledWorkspace = resolved.workspace;
        after = resolved.snapshot;
      } else {
        const afterNavigation = reconcileUiState(
          workspace,
          currentNavigation(),
          uiUpdate
        );
        after = buildHistorySnapshot(
          afterNavigation,
          expandedNodeIds ?? locallyExpandedNodeIdsRef.current,
          focus
        );
      }
      const returnedState = returnedHistoryState;
      if (returnedState) {
        const acceptance = owner.history.acceptMutationResult(
          context.entryId,
          after,
          returnedState
        );
        if (!acceptance.accepted) {
          historyOwnerByEntryIdRef.current.discard(context.entryId);
          return recoverMutationMismatch(returnedState);
        }
        owner.queueHistoryCleanup(acceptance.unreachableEntryIds);
      } else {
        // Legacy raw-workspace test stores do not return history state.
        owner.history.rememberAfter(context.entryId, after);
      }
      owner.settleAuthoritativePresentation(
        settledWorkspace,
        after
      );
      if (context.commandKind !== "text") {
        completeHistoryOwner(context.entryId);
      }
      return null;
    },
    [
      buildHistorySnapshot,
      completeHistoryOwner,
      captureHistorySnapshot,
      currentNavigation,
      publishFeedback,
      resolveHistoryLocation
    ]
  );

  const settleAtomicMutation = useCallback(
    async (
      context: NotesHistoryContext | null | undefined,
      mutation: UnwrappedNotesMutation,
      projection: ProjectedNotesMutation,
      options?: {
        uiUpdate?: NotesWorkspaceUiUpdate;
        focus?: NotesHistoryFocus | null;
        expandedNodeIds?: ReadonlySet<NoteId>;
        requestedLocation?: NotesHistorySnapshot;
        recoveryLocation?: NotesHistorySnapshot;
        recoverySource?: Pick<
          NotesWorkspaceSessionRecord,
          "repository" | "vaultRoot"
        >;
      }
    ): Promise<NotesWorkspaceQueueResult | null> => {
      if (!context) return null;
      if (!mutation.atomic) {
        return rememberHistoryAfter(
          context,
          projection.workspace,
          options?.uiUpdate,
          options?.focus,
          options?.expandedNodeIds,
          options?.requestedLocation,
          options?.recoveryLocation,
          options?.recoverySource
        );
      }
      const owner = historyOwnerByEntryIdRef.current.owner(context.entryId);
      if (mutation.historyEntryId === null) {
        owner?.history.discard(context.entryId);
        historyOwnerByEntryIdRef.current.discard(context.entryId);
        return null;
      }
      const state = mutation.historyStatus;
      const rejected =
        projection.projectionError !== undefined ||
        mutation.historyEntryId !== context.entryId ||
        state?.historyEpoch !== context.historyEpoch ||
        state?.nextUndoEntryId !== context.entryId ||
        state?.nextRedoEntryId !== null ||
        state?.canUndo !== true ||
        state?.canRedo !== false;
      const recoveryState =
        state ?? { ...emptyHistoryState(), historyEpoch: context.historyEpoch };
      return rememberHistoryAfter(
        context,
        projection.workspace,
        options?.uiUpdate,
        options?.focus,
        options?.expandedNodeIds,
        options?.requestedLocation,
        options?.recoveryLocation,
        options?.recoverySource,
        rejected ? undefined : state,
        rejected ? recoveryState : undefined
      );
    },
    [rememberHistoryAfter]
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
            : beginStructuralEntry(
                record,
                commandKind,
                options?.historyFocus === undefined
                  ? undefined
                  : captureHistorySnapshot(options.historyFocus)
              );
        try {
          const result = await work(context, historyContext, record);
          const recovered = historyContext
            ? recoveredHistoryResultByEntryIdRef.current.get(
                historyContext.entryId
              )
            : undefined;
          if (historyContext && recovered) {
            recoveredHistoryResultByEntryIdRef.current.delete(
              historyContext.entryId
            );
            return recovered;
          }
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
    [
      beginStructuralEntry,
      captureHistorySnapshot,
      discardHistoryEntry,
      repository,
      vaultRoot
    ]
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
      captureHistorySnapshot: () => captureHistorySnapshot(),
      resolveHistoryLocation,
      releaseHistorySnapshot: releaseOwnedHistorySnapshot,
      publishFeedback,
      consumeRecoveredHistoryResult: (entryId) => {
        recoveredHistoryResultByEntryIdRef.current.delete(entryId);
      },
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
      currentImageAtomPasteMaxDisplayWidth: () =>
        imageImportMaxDisplayWidthRef.current ?? 0,
      isImageAtomPasteAuthorityCurrentAtQueueTurn: (
        authority,
        context,
        record,
        workspace
      ) =>
        sessionRecordRef.current === record &&
        sessionRef.current === record.session &&
        context.repository === record.repository &&
        sameScope(activeScopeRef.current, context.sourceScope) &&
        imageAtomEditorRegistry.isPasteAuthorityCurrent(
          capturedImageAtomPasteAuthority(authority).editorAuthority
        ) &&
        imageAtomPasteAuthorityMatches(authority, {
          vaultRoot: context.vaultRoot,
          scope: context.sourceScope,
          generation: activeWorkspaceGenerationRef.current,
          session: sessionRef.current,
          record,
          workspace
        }),
      setLibraryView,
      setActiveTagFilters,
      runStructuralCommand,
      rememberHistoryAfter: (
        context,
        workspace,
        uiUpdate,
        focus,
        expandedNodeIds,
        returnedHistoryState,
        historyRejectionState
      ) =>
        rememberHistoryAfter(
          context,
          workspace,
          uiUpdate,
          focus,
          expandedNodeIds,
          undefined,
          undefined,
          undefined,
          returnedHistoryState,
          historyRejectionState
        ),
      settleAtomicMutation,
      replaceLocalExpansions,
      beginTextEntry,
      settleInlineTextEntry,
      closeTextBurst
    }),
    [
      currentNavigation,
      currentEditingFocus,
      captureHistorySnapshot,
      resolveHistoryLocation,
      publishFeedback,
      runStructuralCommand,
      rememberHistoryAfter,
      settleAtomicMutation,
      replaceLocalExpansions,
      beginTextEntry,
      settleInlineTextEntry,
      closeTextBurst,
      imageAtomEditorRegistry
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
              note: draft.note,
              imageOffsetUtf16: draft.imageOffsetUtf16
            },
            ...historyArguments(historyContext)
          )
        );
        const projection = await projectNotesMutation(
          context,
          mutation,
          activeScopeRef.current
        );
        const settlement = await settleAtomicMutation(
          historyContext,
          mutation,
          projection,
          { focus: attempt.focus }
        );
        if (settlement) return settlement;
        return directMutationResult(mutation, projection);
      } catch (cause) {
        return { kind: "failure", error: errorMessage(cause) };
      }
    },
    [settleAtomicMutation]
  );

  const markEditingFocus = useCallback(
    (nodeId: NoteId, field: NotesHistoryFocusField): void => {
      // A real DOM focus event is a new navigation gesture even when the user
      // returns to the same node/field after focusing outside the editor.
      retirePendingPrimarySelection();
      navigationVersionRef.current += 1;
      editingFocusRef.current = { nodeId, field };
    },
    [retirePendingPrimarySelection]
  );
  const setDraftEditingNavigation = useCallback(
    (nodeId: NoteId, field: NotesHistoryFocusField): void => {
      // Draft updates are only a fallback for non-DOM callers. Repeated typing
      // in one field must not manufacture a navigation gesture per keystroke.
      retirePendingPrimarySelection();
      const current = editingFocusRef.current;
      if (current?.nodeId === nodeId && current.field === field) {
        return;
      }
      navigationVersionRef.current += 1;
      editingFocusRef.current = { nodeId, field };
    },
    [retirePendingPrimarySelection]
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
  const toggleSelectionNode = useCallback(
    (nodeId: NoteId, visibleNodeIds: readonly NoteId[]): void => {
      updateSelection({
        type: "toggleSelectionNode",
        nodeId,
        visibleNodeIds
      });
    },
    [updateSelection]
  );
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
      patch: Pick<NoteNode, "title" | "note" | "imageOffsetUtf16">,
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

  const registerImageAtomFlushAdapter = useCallback(
    (adapter: NotesImageAtomFlushAdapter): (() => void) => {
      const engine = draftEngineRef.current;
      if (
        !engine ||
        engine.record.closing ||
        engine.record.repository !== repository ||
        engine.record.vaultRoot !== vaultRoot ||
        isNotesDataDeletionInProgress(repository, vaultRoot)
      ) {
        return () => undefined;
      }
      return engine.registerImageAtomFlushAdapter(adapter);
    },
    [repository, vaultRoot]
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

  const replayHistory = useCallback(
    async (direction: "undo" | "redo"): Promise<void> => {
      const record = sessionRecordRef.current;
      const session = sessionRef.current;
      if (!record || !session || record.session !== session) {
        return;
      }
      const ownerToken = session.ownerToken();
      if (!session.isCurrentOwner(ownerToken)) {
        return;
      }
      await session.enqueueStructural(async (context) => {
        if (!session.isCurrentOwner(ownerToken)) {
          return { kind: "skipped" };
        }
        const recoverReplayMismatch = async (
          state: NotesHistoryStatus
        ): Promise<NotesWorkspaceQueueResult> => {
          const current = captureHistorySnapshot();
          try {
            const recovered = await session.recoverHistoryMismatch(
              state,
              async () => {
                const resolved = await resolveHistoryLocation(current);
                if (!resolved) {
                  throw new Error("Notes history recovery could not reload its location.");
                }
                return resolved;
              }
            );
            if (!recovered) {
              publishFeedback?.({
                kind: "error",
                message:
                  "Undo/Redo history could not be synchronized. Close and reopen this Vault."
              });
              return {
                kind: "failure",
                error:
                  "Undo/Redo history could not be synchronized. Close and reopen this Vault."
              };
            }
            publishFeedback?.({
              kind: "status",
              message: "Undo/Redo history was reset to recover synchronization."
            });
            return authoritative(
              {
                nodes: Object.values(recovered.workspace.nodesById),
                attachmentsByNodeId: recovered.workspace.attachmentsByNodeId
              }
            );
          } finally {
            releaseOwnedHistorySnapshot(current);
          }
        };
        let status: NotesHistoryStatus;
        try {
          if (!context.repository.historyStatus) {
            throw new Error("Notes history status is unavailable.");
          }
          status = await context.repository.historyStatus(
            context.vaultRoot,
            session.history.sessionId
          );
        } catch {
          publishFeedback?.({
            kind: "error",
            message: "Undo/Redo history status is unavailable."
          });
          return { kind: "failure", error: "Undo/Redo history status is unavailable." };
        }
        if (!session.history.accepts(status)) {
          return recoverReplayMismatch(status);
        }
        const candidate = session.history.next(direction);
        if (!candidate) {
          return { kind: "skipped" };
        }
        const target = direction === "undo" ? candidate.before : candidate.after;
        if (candidate.kind === "navigation") {
          const resolved = await resolveHistoryLocation(target);
          if (!resolved) {
            publishFeedback?.({
              kind: "error",
              message: "Undo/Redo history could not restore its saved location."
            });
            return {
              kind: "failure",
              error: "Undo/Redo history could not restore its saved location."
            };
          }
          try {
            session.history.commitReplay(direction);
            session.settleAuthoritativePresentation(
              resolved.workspace,
              resolved.snapshot
            );
            if (!applyHistoryLocation(resolved.workspace, resolved.snapshot)) {
              return recoverReplayMismatch(status);
            }
            return authoritative(
              {
                nodes: Object.values(resolved.workspace.nodesById),
                attachmentsByNodeId: resolved.workspace.attachmentsByNodeId
              },
              undefined,
              status
            );
          } finally {
            // `settleAuthoritativePresentation` takes the canonical retain;
            // this resolver lease only bridges the synchronous commit.
            releaseOwnedHistorySnapshot(resolved.snapshot);
          }
        }
        const replay =
          direction === "undo" ? context.repository.undo : context.repository.redo;
        if (!replay) {
          return { kind: "skipped" };
        }
        const currentScope = activeScopeRef.current;
        const result = await replay(
          context.vaultRoot,
          {
            sessionId: session.history.sessionId,
            historyEpoch: session.history.historyEpoch,
            expectedEntryId: candidate.entryId,
            scope: currentScope
          }
        );
        if (result.kind !== "applied") {
          return recoverReplayMismatch(result);
        }
        let replayWorkspace: NotesWorkspace;
        try {
          replayWorkspace = sameScope(target.scope, currentScope)
            ? result.workspace
            : await context.repository.loadWorkspace(
                context.vaultRoot,
                target.scope
              );
        } catch {
          return recoverReplayMismatch(result);
        }
        const resolved = await resolveHistoryLocation(target, replayWorkspace);
        if (!resolved) {
          return recoverReplayMismatch(result);
        }
        try {
          if (
            result.replayedEntryId !== candidate.entryId ||
            !session.history.acceptReplayResult(
              result,
              direction,
              candidate.entryId
            )
          ) {
            return recoverReplayMismatch(result);
          }
          session.settleAuthoritativePresentation(
            resolved.workspace,
            resolved.snapshot
          );
          if (!applyHistoryLocation(resolved.workspace, resolved.snapshot)) {
            return recoverReplayMismatch(result);
          }
          return authoritative(
            {
              nodes: Object.values(resolved.workspace.nodesById),
              attachmentsByNodeId: resolved.workspace.attachmentsByNodeId
            },
            undefined,
            result,
            { invalidatesTagSummaries: true }
          );
        } finally {
          releaseOwnedHistorySnapshot(resolved.snapshot);
        }
      });
    },
    [
      applyHistoryLocation,
      captureHistorySnapshot,
      publishFeedback,
      resolveHistoryLocation
    ]
  );

  const undo = useCallback(() => replayHistory("undo"), [replayHistory]);
  const redo = useCallback(() => replayHistory("redo"), [replayHistory]);

  const navigateWithHistory = useCallback(
    async (
      intent: NavigationIntent,
      workspaceGeneration = activeWorkspaceGenerationRef.current
    ): Promise<void> => {
      const session = sessionRef.current;
      if (!session) return;
      const ownerToken = session.ownerToken();
      if (ownerToken === 0 || !session.isCurrentOwner(ownerToken)) return;
      if (outlineCompositionActiveRef.current) {
        pendingNavigationRef.current = {
          session,
          ownerToken,
          workspaceGeneration,
          intent
        };
        return;
      }

      await session.enqueueStructural(
        async (context) => {
          if (!session.isCurrentOwner(ownerToken)) {
            return { kind: "skipped" };
          }
          session.history.closeTextBurst();
          const lease = session.reserveAdmittedNavigation();
          if (!lease.beforeSnapshot()) return { kind: "skipped" };
          let resolved: ResolvedHistoryLocation | null = null;
          try {
            const recoverMismatch = async (
              state: NotesHistoryStatus
            ): Promise<NotesWorkspaceQueueResult> => {
              const current = captureHistorySnapshot();
              try {
                const recovered = await session.recoverHistoryMismatch(
                  state,
                  async () => {
                    const resolved = await resolveHistoryLocation(current);
                    if (!resolved) {
                      throw new Error(
                        "Notes navigation history recovery could not reload its location."
                      );
                    }
                    return resolved;
                  }
                );
                if (!recovered) {
                  const error =
                    "Notes navigation history could not be synchronized. Close and reopen this Vault.";
                  publishFeedback?.({ kind: "error", message: error });
                  return { kind: "skipped" };
                }
                publishFeedback?.({
                  kind: "status",
                  message: "Notes history was reset to recover synchronization."
                });
                return authoritative({
                  nodes: Object.values(recovered.workspace.nodesById),
                  attachmentsByNodeId: recovered.workspace.attachmentsByNodeId
                });
              } finally {
                releaseOwnedHistorySnapshot(current);
              }
            };

            let status: NotesHistoryStatus;
            try {
              if (!context.repository.historyStatus) {
                throw new Error("Notes navigation history status is unavailable.");
              }
              status = await context.repository.historyStatus(
                context.vaultRoot,
                session.history.sessionId
              );
            } catch {
              const error = "Notes navigation history status is unavailable.";
              publishFeedback?.({ kind: "error", message: error });
              return { kind: "skipped" };
            }
            if (!session.history.accepts(status)) {
              return recoverMismatch(status);
            }

            if (activeWorkspaceGenerationRef.current === workspaceGeneration) {
              const liveBefore = captureHistorySnapshot();
              try {
                lease.replaceBefore(liveBefore);
              } finally {
                releaseOwnedHistorySnapshot(liveBefore);
              }
            }
            const before = lease.beforeSnapshot();
            if (!before) return { kind: "skipped" };
            resolved = await intent({
              workspace: normalizeWorkspace(context.confirmedWorkspace),
              snapshot: before
            });
            if (!resolved || sameHistorySnapshot(before, resolved.snapshot)) {
              return { kind: "skipped" };
            }

            const destinationWorkspace = resolved.workspace;
            const destinationTagSummaries = resolved.tagSummaries;
            lease.setDestination(destinationWorkspace, resolved.snapshot);
            releaseOwnedHistorySnapshot(resolved.snapshot);
            resolved = null;

            const invalidatedRedoIds =
              session.history.unreachableRedoMutationIds();
            let guard: NotesHistoryStatus;
            try {
              if (!context.repository.prepareNavigation) {
                throw new Error("Notes navigation guard is unavailable.");
              }
              guard = await context.repository.prepareNavigation(
                context.vaultRoot,
                {
                  sessionId: session.history.sessionId,
                  historyEpoch: session.history.historyEpoch,
                  unreachableRedoEntryIds: invalidatedRedoIds
                }
              );
            } catch {
              const error = "Notes navigation could not be prepared.";
              publishFeedback?.({ kind: "error", message: error });
              return { kind: "skipped" };
            }
            if (
              !session.history.acceptPreparedNavigation(
                guard,
                invalidatedRedoIds
              )
            ) {
              lease.cancel();
              return recoverMismatch(guard);
            }

            session.queueHistoryCleanup(lease.commit());
            return authoritative(
              {
                nodes: Object.values(destinationWorkspace.nodesById),
                attachmentsByNodeId: destinationWorkspace.attachmentsByNodeId
              },
              undefined,
              guard,
              destinationTagSummaries !== undefined
                ? { tagSummaries: destinationTagSummaries }
                : undefined
            );
          } catch (cause) {
            const error = `Notes navigation failed: ${errorMessage(cause)}`;
            publishFeedback?.({ kind: "error", message: error });
            return { kind: "skipped" };
          } finally {
            lease.cancel();
            if (resolved) releaseOwnedHistorySnapshot(resolved.snapshot);
          }
        },
        {
          requireAllBarriers: true,
          selectionPolicy: "preserve",
          settleFailure: (error) =>
            publishFeedback?.({
              kind: "error",
              message: `Notes navigation failed: ${error}`
            })
        }
      );
    },
    [captureHistorySnapshot, publishFeedback, resolveHistoryLocation]
  );

  const setOutlineCompositionActive = useCallback(
    (active: boolean): void => {
      if (active) {
        outlineCompositionActiveRef.current = true;
        return;
      }
      if (!outlineCompositionActiveRef.current) return;
      outlineCompositionActiveRef.current = false;
      const pending = pendingNavigationRef.current;
      pendingNavigationRef.current = null;
      if (
        !pending ||
        sessionRef.current !== pending.session ||
        !pending.session.isCurrentOwner(pending.ownerToken)
      ) {
        return;
      }
      void navigateWithHistory(
        pending.intent,
        pending.workspaceGeneration
      );
    },
    [navigateWithHistory]
  );

  const loadLibraryScope = useCallback(
    async (
      view: NotesLibraryView,
      scope: NotesWorkspaceScope
    ): Promise<void> => {
      await navigateWithHistory(async () => {
        const requested: NotesHistorySnapshot = {
          scope: cloneWorkspaceScope(scope),
          libraryView: view,
          activeTagFilters: [],
          selectedId: null,
          zoomRootId: null,
          expansion: notesExpansionSnapshotPool.acquire([]),
          focus: null,
          tagFilterOrigin: null
        };
        try {
          const resolved = await resolveHistoryLocation(requested);
          if (!resolved) {
            throw new Error("The requested Notes library could not be loaded.");
          }
          return resolved;
        } finally {
          releaseOwnedHistorySnapshot(requested);
        }
      });
    },
    [navigateWithHistory, resolveHistoryLocation]
  );

  const selectLibraryView = useCallback(
    async (view: NotesLibraryView): Promise<void> => {
      if (view !== "tags") {
        await loadLibraryScope(view, scopeForLibraryView(view));
        return;
      }
      await navigateWithHistory(async ({ snapshot }) => {
        const currentFilters =
          snapshot.libraryView === "tags"
            ? canonicalizeTagFilters(snapshot.activeTagFilters)
            : [];
        if (currentFilters.length > 0) return null;
        const origin = tagFilterOriginFromHistoryLocation(
          snapshot.tagFilterOrigin ?? snapshot
        );
        const scope: NotesWorkspaceScope = { kind: "tags", tags: [] };
        const [loaded, summaries] = await Promise.all([
          repository.loadWorkspace(vaultRoot, scope),
          repository.listTagsWithCounts(vaultRoot)
        ]);
        const requested: NotesHistorySnapshot = {
          scope,
          libraryView: "tags",
          activeTagFilters: [],
          selectedId: null,
          zoomRootId: null,
          expansion: notesExpansionSnapshotPool.acquire([]),
          focus: null,
          tagFilterOrigin: snapshotForTagFilterOrigin(origin)
        };
        try {
          const resolved = await resolveHistoryLocation(requested, loaded);
          if (!resolved) {
            throw new Error("The Tags chooser could not be loaded.");
          }
          return { ...resolved, tagSummaries: summaries };
        } finally {
          releaseOwnedHistorySnapshot(requested);
        }
      });
    }, [
      loadLibraryScope,
      navigateWithHistory,
      repository,
      resolveHistoryLocation,
      vaultRoot
    ]
  );

  const toggleTagFilter = useCallback(
    async (filter: NoteTagFilter): Promise<void> => {
      await navigateWithHistory(async ({ snapshot }) => {
        const currentFilters =
          snapshot.libraryView === "tags"
            ? canonicalizeTagFilters(snapshot.activeTagFilters)
            : [];
        const key = tagFilterKey(filter);
        const exists = currentFilters.some(
          (candidate) => tagFilterKey(candidate) === key
        );
        const nextFilters = canonicalizeTagFilters(
          exists
            ? currentFilters.filter(
                (candidate) => tagFilterKey(candidate) !== key
              )
            : [...currentFilters, filter]
        );
        const savedOrigin = snapshot.tagFilterOrigin
          ? tagFilterOriginFromHistoryLocation(snapshot.tagFilterOrigin)
          : null;
        const origin =
          currentFilters.length === 0
            ? savedOrigin ?? tagFilterOriginFromHistoryLocation(snapshot)
            : savedOrigin;
        const nextScope: NotesWorkspaceScope =
          nextFilters.length > 0
            ? { kind: "tags", tags: nextFilters }
            : cloneWorkspaceScope(origin?.scope ?? { kind: "active" });
        const [loaded, summaries] = await Promise.all([
          repository.loadWorkspace(vaultRoot, nextScope),
          repository.listTagsWithCounts(vaultRoot)
        ]);
        const restoration =
          nextFilters.length === 0 && origin
            ? restoredTagFilterNavigation(loaded, origin)
            : null;
        const requestedOrigin: NotesHistoryLocationSnapshot | null =
          nextFilters.length > 0 && origin
            ? snapshotForTagFilterOrigin(origin)
            : null;
        const requested: NotesHistorySnapshot = {
          scope: cloneWorkspaceScope(nextScope),
          libraryView:
            nextFilters.length > 0 ? "tags" : origin?.libraryView ?? "all",
          activeTagFilters: nextFilters,
          selectedId: restoration?.uiUpdate.selectedId ?? null,
          zoomRootId: restoration?.uiUpdate.zoomRootId ?? null,
          expansion: notesExpansionSnapshotPool.acquire(
            restoration ? [...restoration.expandedNodeIds] : []
          ),
          focus: restoration?.uiUpdate.editingNoteId
            ? {
                nodeId: restoration.uiUpdate.editingNoteId,
                field:
                  restoration.uiUpdate.pendingFocusField ?? "title"
              }
            : null,
          tagFilterOrigin: requestedOrigin
        };
        try {
          const resolved = await resolveHistoryLocation(requested, loaded);
          if (!resolved) {
            throw new Error("The requested tag filter could not be loaded.");
          }
          return { ...resolved, tagSummaries: summaries };
        } finally {
          releaseOwnedHistorySnapshot(requested);
        }
      });
    },
    [
      navigateWithHistory,
      repository,
      resolveHistoryLocation,
      vaultRoot
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
    (nodeId: NoteId): Promise<void> =>
      navigateWithHistory(async () => {
        const loaded = await repository.loadWorkspace(vaultRoot, {
          kind: "active"
        });
        const navigation = searchNavigation(loaded, nodeId);
        const requested: NotesHistorySnapshot = {
          scope: { kind: "active" },
          libraryView: "all",
          activeTagFilters: [],
          selectedId: navigation ? nodeId : null,
          zoomRootId: navigation?.rootId ?? null,
          expansion: notesExpansionSnapshotPool.acquire(
            navigation ? [...navigation.expandedNodeIds] : []
          ),
          focus: navigation ? { nodeId, field: "title" } : null,
          tagFilterOrigin: null
        };
        try {
          const resolved = await resolveHistoryLocation(requested, loaded);
          if (!resolved) {
            throw new Error("The requested note could not be opened.");
          }
          return resolved;
        } finally {
          releaseOwnedHistorySnapshot(requested);
        }
      }),
    [
      navigateWithHistory,
      repository,
      resolveHistoryLocation,
      vaultRoot
    ]
  );

  const acknowledgeFocus = useCallback(
    async (nodeId: NoteId, requestId?: number) => {
      const pendingPrimarySelection = pendingPrimarySelectionRef.current;
      if (
        pendingPrimarySelection !== null &&
        (pendingPrimarySelection.nodeId !== nodeId ||
          pendingPrimarySelection.requestId !== requestId)
      ) {
        return;
      }
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
      if (pendingPrimarySelection !== null) {
        pendingPrimarySelectionRef.current = null;
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

  const applyImageAtomEdit = useCallback(
    (nodeId: NoteId, selection: LogicalSelection, edit: ImageAtomEdit) =>
      applyImageAtomEditCommand(commandCtx, nodeId, selection, edit),
    [commandCtx]
  );

  const applyImageAtomPaste = useCallback(
    (nodeId: NoteId, selection: LogicalSelection, fragment: ParsedImageAtomPaste) =>
      applyImageAtomPasteCommand(commandCtx, nodeId, selection, fragment),
    [commandCtx]
  );

  const applyImageAtomPasteWithAuthority = useCallback(
    (
      authority: NotesImageAtomPasteAuthority,
      nodeId: NoteId,
      selection: LogicalSelection,
      fragment: ParsedImageAtomPaste
    ) =>
      applyImageAtomPasteCommand(
        commandCtx,
        nodeId,
        selection,
        fragment,
        authority
      ),
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
    (nodeId: NoteId | null): Promise<void> =>
      navigateWithHistory(async ({ workspace, snapshot }) => {
        const zoomRootId =
          nodeId !== null && workspace.nodesById[nodeId] ? nodeId : null;
        const destination = cloneOwnedHistorySnapshot(snapshot);
        return {
          workspace,
          snapshot: { ...destination, zoomRootId }
        };
      }),
    [navigateWithHistory]
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
      const historyLocation = captureHistorySnapshot();
      const attempt: AttachmentUploadAttempt = {
        attemptId: globalThis.crypto.randomUUID(),
        order: ++attachmentUploadAttemptOrderRef.current,
        nodeId,
        request,
        retainedByteSize,
        scope: cloneWorkspaceScope(activeScopeRef.current),
        initialMaxDisplayWidth,
        historyContext: beginStructuralEntry(
          record,
          "attachment-import",
          historyLocation
        ),
        historyLocation: cloneOwnedHistorySnapshot(historyLocation),
        record,
        orderingTurn: reserveImageImportOrderingTurn(
          repository,
          vaultRoot,
          request.anchor
        ),
        reservation:
          asCoordinatorSession(record.session).reserveImageImportInsertion?.(
            request.anchor
          ) ?? null,
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
      captureHistorySnapshot,
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
      let finishMutationSettlement!: () => void;
      const mutationSettlement = new Promise<void>((resolve) => {
        finishMutationSettlement = resolve;
      });
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
            const importedTailId = mutation.importedRootIds?.at(-1);
            if (importedTailId) {
              attempt.reservation?.commit(importedTailId);
            }
            const projection = await projectNotesMutation(
              context,
              mutation,
              attempt.scope
            );
            // A vault replacement is a different coordinator generation. Settle
            // against the old session's captured location so the surviving
            // old-vault owner receives both workspace and timeline authority.
            if (
              !isCurrent() &&
              vaultRootRef.current !== attempt.record.vaultRoot
            ) {
              const settlement = await settleAtomicMutation(
                historyContext,
                mutation,
                projection,
                {
                  requestedLocation: attempt.historyLocation ?? undefined,
                  recoveryLocation: attempt.historyLocation ?? undefined,
                  recoverySource: attempt.record
                }
              );
              removeAttachmentUploadAttempt(attempt);
              if (settlement) {
                return settlement;
              }
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
            const settlement = await settleAtomicMutation(
              historyContext,
              mutation,
              projection,
              {
                uiUpdate,
                recoveryLocation: attempt.historyLocation ?? undefined,
                recoverySource: attempt.record
              }
            );
            if (settlement) {
              removeAttachmentUploadAttempt(attempt);
              return settlement;
            }
            if (!isCurrent()) {
              removeAttachmentUploadAttempt(attempt);
              return directMutationResult(
                mutation,
                projection,
                undefined,
                attempt.scope
              );
            }
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
            finishMutationSettlement();
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
        try {
          outcome = await completion;
        } finally {
          if (attempt.started) {
            await mutationSettlement;
          }
        }
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
      releaseFinalizedDetachedAttachmentUploadAttempts,
      removeAttachmentUploadAttempt,
      runStructuralCommand,
      settleAtomicMutation,
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
              asCoordinatorSession(record.session)
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
          const settlement = await settleAtomicMutation(
            historyContext,
            mutation,
            projection
          );
          if (settlement) return settlement;
          return directMutationResult(mutation, projection);
        }
      ).then(() => undefined),
    [runStructuralCommand, settleAtomicMutation]
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
          const settlement = await settleAtomicMutation(
            historyContext,
            mutation,
            projection
          );
          if (settlement) return settlement;
          return directMutationResult(mutation, projection);
        }
      ).then(() => undefined),
    [runStructuralCommand, settleAtomicMutation]
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
      setOutlineCompositionActive,
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
      applyImageAtomEdit: gateOutcome(applyImageAtomEdit),
      applyImageAtomPaste: gateOutcome(applyImageAtomPaste),
      updateNodeDraft: (nodeId, patch, field) => {
        if (!deletionInProgress()) {
          updateNodeDraft(nodeId, patch, field);
        }
      },
      registerImageAtomFlushAdapter,
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
      toggleSelectionNode,
      clearSelection,
      replaceSelection,
      getSelectionSnapshot
    };
  }, [
    repository,
    vaultRoot,
    setOutlineCompositionActive,
    acknowledgeFocus,
    focusNode,
    markEditingFocus,
    getNavigationVersion,
    createRoot,
    createNextTextSibling,
    splitNode,
    createChild,
    updateNode,
    applyImageAtomEdit,
    applyImageAtomPaste,
    updateNodeDraft,
    registerImageAtomFlushAdapter,
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
    toggleSelectionNode,
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
    () => {
      // Version is bumped for every shared-timeline settlement; reading it
      // here makes a navigation-only cursor move observable to every slice.
      const sessionHistory =
        historyTimelineVersion >= 0 ? sessionRef.current?.history : undefined;
      return {
        state,
        deletingNotesData,
        libraryView,
        activeTagFilters,
        tagSummaries,
        locallyExpandedNodeIds,
        status: state.status,
        loading: state.status === "loading",
        error: state.error,
        canUndo: sessionHistory?.canUndo() ?? false,
        canRedo: sessionHistory?.canRedo() ?? false,
        pendingPrimarySelection: pendingPrimarySelectionRef.current
      };
    },
    [
      state,
      deletingNotesData,
      libraryView,
      activeTagFilters,
      tagSummaries,
      locallyExpandedNodeIds,
      historyTimelineVersion
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
      registerActiveImageAtomEditor,
      claimActiveImageAtomPaste,
      captureActiveImageAtomEditorAuthority,
      captureImageAtomPasteAuthority,
      isImageAtomPasteAuthorityCurrent,
      applyImageAtomPasteWithAuthority,
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
      registerActiveImageAtomEditor,
      claimActiveImageAtomPaste,
      captureActiveImageAtomEditorAuthority,
      captureImageAtomPasteAuthority,
      isImageAtomPasteAuthorityCurrent,
      applyImageAtomPasteWithAuthority,
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
