import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  NoteId,
  NotesHistoryStatus,
} from "../../domain/notes";
import { createNotesWriteQueue } from "../../services/notesWriteQueue";
import { connectNotesSyncRuntime } from "../../services/notesSyncListener";
import {
  notesWorkspaceCoordinatorRegistry,
  type NotesWorkspaceCommandOutcome,
  type NotesWorkspaceCoordinatorSession,
  type NotesWorkspaceDrainEnqueue,
  type NotesWorkspaceQueueContext,
  type NotesWorkspaceQueueResult,
} from "./notesWorkspaceCoordinator";
import {
  adoptNotesWriteAuthority,
  type NotesWriteAuthority,
} from "./notesAuthorityRecovery";
import {
  createNotesHistoryOwnerRegistry,
  type NotesHistoryFocus,
  type NotesHistoryPrimarySelection,
  type NotesHistorySnapshot,
} from "./notesHistory";
import {
  normalizeWorkspace,
  notesWorkspaceReducer,
  type NormalizedNotesWorkspace,
  type NotesWorkspaceReducerAction,
} from "./notesWorkspaceReducer";
import {
  canonicalizeTagFilters,
  sameScope,
  tagFilterKey,
} from "./notesWorkspaceScope";
import { nativeNotesAttachmentUi } from "./notesAttachmentController";
import {
  NotesDraftEngine,
  type NotesDraftEngineHost,
  type NotesWorkspaceSessionRecord,
} from "./notesDraftEngine";
import { notesDraftsFlushFailedError } from "./notesDraftErrors";
import {
  isNotesDataDeletionInProgress,
  registerNotesDataDeletionParticipant,
} from "./notesDataDeletionRegistry";
import {
  capturedImageAtomAuthority,
  imageAtomAuthorityMatches,
  type NotesImageAtomAuthority,
} from "./notesImageAtomAuthority";
import type { NotesCommandContext } from "./notesCommands";
import { emptyHistoryState } from "./notesWorkspaceCommandSupport";
import type { OptimisticInsertionSnapshot } from "./notesKeyboardInsertion";
import type { OptimisticBackspaceGesture } from "./notesBackspaceGesture";
import * as settlementRuntime from "./notesWorkspaceSettlementRuntime";
import { useNotesDirectCaretReconciliation } from "./useNotesDirectCaretReconciliation";
import type {
  LiveNotesNavigation,
  NotesActionsSlice,
  NotesDraftsSlice,
  NotesPendingPrimarySelection,
  NotesProjectionPublication,
  NotesStateSlice,
  NotesWorkspaceActions,
  UseNotesWorkspaceHookResult,
  UseNotesWorkspaceOptions,
} from "./notesWorkspaceTypes";
import type { NavigationIntent } from "./notesWorkspaceNavigationSupport";
import { subscribeToImageImportRecovery } from "./notesImageImportRecovery";
import {
  useNotesSelectionAuthority,
  useNotesSelectionState,
} from "./useNotesSelectionController";
import { useNotesPaneSessions } from "./useNotesPaneSessions";
import type { NotesPaneId } from "./notesPaneSession";
import { useNotesEditingLease } from "./useNotesEditingLease";
import { useNotesWorkspacePaneRegistry } from "./useNotesWorkspacePaneRegistry";
import {
  useNotesLibraryActions,
  useNotesLibraryState,
} from "./useNotesLibraryController";
import { useNotesCommandActions } from "./useNotesCommandActions";
import {
  useNotesAttachmentWorkflow,
  useNotesAttachmentWorkflowState,
} from "./useNotesAttachmentWorkflow";
import {
  enqueueBufferedWorkspaceCommands,
  resolveBufferedWorkspaceCommands,
} from "./notesBufferedWorkspaceCommands";
import {
  useNotesHistoryController,
  type BufferedWorkspaceCommand,
} from "./useNotesHistoryController";
import {
  registerCoordinatorSessionForDraftEngine,
  shutdownAfterBackspaceDrain,
} from "./notesBackspaceRuntime";
import {
  useNotesDataDeletionExternalStore,
  useNotesDraftExternalStore,
} from "./useNotesWorkspaceExternalStores";
import {
  useNotesImageAtomAuthorityLifecycle,
  useNotesImageAtomEditorRuntime,
} from "./useNotesImageAtomRuntime";

export type { ResolvedHistoryLocation } from "./notesWorkspaceNavigationSupport";
export { resetImageImportRecoveryForTests } from "./notesImageImportRecovery";
export {
  authoritative,
  scopedActiveDelta,
  unwrapNotesMutation,
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
  workspaceForScope,
} from "./notesWorkspaceCommandSupport";
export type {
  RawNotesMutationDelta,
  UnwrappedNotesMutation,
} from "./notesWorkspaceProjection";
export type * from "./notesWorkspaceTypes";
export {
  isNotesDraftsFlushFailedError,
  NOTES_DRAFTS_FLUSH_FAILED_CODE,
} from "./notesDraftErrors";

function currentNotesNavigation(
  state: NormalizedNotesWorkspace,
  editing: NotesHistoryFocus | null,
): LiveNotesNavigation {
  return {
    selectedId: editing ? editing.nodeId : state.selectedId,
    zoomRootId: state.zoomRootId,
    editingNoteId: editing ? editing.nodeId : state.editingNoteId,
    pendingFocusId: state.pendingFocusId,
    pendingFocusField: editing ? editing.field : state.pendingFocusField,
  };
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
  publishFeedback,
}: UseNotesWorkspaceOptions): UseNotesWorkspaceHookResult {
  const paneSessions = useNotesPaneSessions();
  const editingLease = useNotesEditingLease();
  const [state, dispatch] = useReducer(
    notesWorkspaceReducer,
    undefined,
    (): NormalizedNotesWorkspace => ({
      ...normalizeWorkspace({ nodes: [] }),
      status: "loading",
    }),
  );
  const {
    selection,
    selectionRef,
    selectionRevisionRef,
    selectionPreparationTokenRef,
    updateSelection,
    setSelectionAnchor,
    extendSelectionTo,
    toggleSelectionNode,
    clearSelection,
    replaceSelection,
    getSelectionSnapshot,
  } = useNotesSelectionState();
  const [locallyExpandedNodeIds, setLocallyExpandedNodeIds] = useState<
    ReadonlySet<NoteId>
  >(() => new Set());
  const deletingNotesData = useNotesDataDeletionExternalStore(
    repository,
    vaultRoot,
  );
  const [historyStatus, setHistoryStatus] =
    useState<NotesHistoryStatus>(emptyHistoryState);
  const [authorityRecovery, setAuthorityRecovery] =
    useState<NotesWriteAuthority>({ kind: "known" });
  const [projectionPublication, setProjectionPublication] =
    useState<NotesProjectionPublication | null>(null);
  const [optimisticInsertionSnapshot, setOptimisticInsertionSnapshot] =
    useState<OptimisticInsertionSnapshot>({
      insertions: [],
      failure: null,
    });
  const optimisticInsertionSnapshotRef =
    useRef<OptimisticInsertionSnapshot>(optimisticInsertionSnapshot);
  const [optimisticBackspaceGesture, setOptimisticBackspaceGesture] =
    useState<OptimisticBackspaceGesture | null>(null);
  const pendingOptimisticTitleFlushesRef = useRef(new Map<NoteId, string>());
  // Backend status validates the mixed cursor; the session timeline owns availability.
  const [historyTimelineVersion, setHistoryTimelineVersion] = useState(0);
  const historyStatusRef = useRef(historyStatus);
  historyStatusRef.current = historyStatus;
  const activeWorkspaceGenerationRef = useRef(0);
  const movePreparationTokenRef = useRef(0);
  const vaultRootRef = useRef(vaultRoot);
  vaultRootRef.current = vaultRoot;
  const {
    registry: imageAtomEditorRegistry,
    registerActiveEditor: registerActiveImageAtomEditor,
    claimActivePaste: claimActiveImageAtomPaste,
  } = useNotesImageAtomEditorRuntime(repository, vaultRoot);
  const locallyExpandedNodeIdsRef = useRef<ReadonlySet<NoteId>>(new Set());
  // The reducer owns settled navigation; this mirror prevents stale pre-render reads.
  const stateRef = useRef(state);
  stateRef.current = state;
  // The ref-owned caret avoids per-keystroke renders and overlays history focus.
  const editingFocusRef = useRef<NotesHistoryFocus | null>(null);
  // Selection replay is a one-shot DOM effect republished by authoritative renders.
  const pendingPrimarySelectionRef =
    useRef<NotesPendingPrimarySelection | null>(null);
  const pendingKeyboardInsertionFocusRef =
    useRef<settlementRuntime.PendingKeyboardInsertionFocus | null>(null);
  const nextPrimarySelectionRequestIdRef = useRef(0);
  const navigationVersionRef = useRef(0);
  const sessionRef = useRef<NotesWorkspaceCoordinatorSession | null>(null);
  const outlineCompositionActiveRef = useRef(false);
  const pendingNavigationRef = useRef<{
    session: NotesWorkspaceCoordinatorSession;
    ownerToken: number;
    workspaceGeneration: number;
    intent: NavigationIntent;
    originPaneId: NotesPaneId;
  } | null>(null);
  const historyOwnerByEntryIdRef = useRef(
    createNotesHistoryOwnerRegistry<NotesWorkspaceCoordinatorSession>(200),
  );
  const recoveredHistoryResultByEntryIdRef = useRef(
    new Map<string, NotesWorkspaceQueueResult>(),
  );
  const sessionRecordRef = useRef<NotesWorkspaceSessionRecord | null>(null);
  const draftEngineRef = useRef<NotesDraftEngine | null>(null);
  const closedRef = useRef(false);
  const attachmentWorkflowState = useNotesAttachmentWorkflowState({
    repository,
    vaultRoot,
    closedRef,
    historyOwnerByEntryIdRef,
  });
  const {
    libraryView,
    libraryViewRef,
    activeTagFilters,
    tagSummaries,
    activeScopeRef,
    requestedTagFiltersRef,
    tagFilterOriginRef,
    tagFilterRequestRef,
    setLibraryView,
    setActiveTagFilters,
    setTagSummaries,
    requestTagSummaryRefresh,
    invalidateTagSummaries,
    resetTagFilterTracking,
  } = useNotesLibraryState(sessionRecordRef, sessionRef);
  const {
    attachmentUploadErrorsByNodeId,
    attachmentUploadRetryAttemptIdsByNodeId,
    imageImportMaxDisplayWidthRef,
    attachmentRecoveryChangeRef,
    setImageImportMaxDisplayWidth,
    releaseFinalizedDetachedAttachmentUploadAttempts,
    prepareAttachmentUploadAttemptsForTeardown,
    discardAttachmentUploadAttempts,
    purgeAttachmentUploadAttemptsAfterDataDeletion,
    clearAttachmentUploadUi,
  } = attachmentWorkflowState;
  const {
    captureActiveEditorAuthority: captureActiveImageAtomEditorAuthority,
    captureCutAuthority: captureImageAtomCutAuthority,
    capturePasteAuthority: captureImageAtomPasteAuthority,
    isPasteAuthorityCurrent: isImageAtomPasteAuthorityCurrent,
  } = useNotesImageAtomAuthorityLifecycle({
    registry: imageAtomEditorRegistry,
    vaultRootRef,
    activeScopeRef,
    generationRef: activeWorkspaceGenerationRef,
    sessionRef,
    sessionRecordRef,
    stateRef,
  });
  const bufferedCommandsRef = useRef<BufferedWorkspaceCommand[]>([]);
  const finalCleanupTokenRef = useRef<object | null>(null);
  const sessionRetirementTokenRef = useRef<object | null>(null);
  const captureHistoryLocationRef = useRef<() => NotesHistorySnapshot>(() => {
    throw new Error("Notes history presentation is not ready.");
  });
  const applyHistoryLocationRef = useRef<
    (
      workspace: NormalizedNotesWorkspace,
      snapshot: NotesHistorySnapshot,
    ) => boolean
  >(() => false);
  // Advance the pure reducer mirror before React and retire superseded live focus.
  const applyAction = useCallback(
    (action: NotesWorkspaceReducerAction): void => {
      const previous = stateRef.current;
      const next = notesWorkspaceReducer(previous, action);
      const pendingPrimarySelection = pendingPrimarySelectionRef.current;
      const invalidatesPrimarySelection =
        action.type === "setZoomRoot" ||
        action.type === "startWorkspaceLoad" ||
        action.type === "setLoading" ||
        (pendingPrimarySelection !== null &&
          (next.pendingFocusId !== pendingPrimarySelection.nodeId ||
            next.pendingFocusField !== pendingPrimarySelection.field ||
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
      // Navigation invalidates any live selection range before the next render.
      if (
        selectionRef.current !== null &&
        (action.type === "focusNode" || action.type === "caretMovedByDom" ||
          action.type === "setZoomRoot" ||
          action.type === "startWorkspaceLoad")
      ) {
        updateSelection({ type: "clearSelection" });
      }
    },
    [selectionRef, updateSelection],
  );
  const { notifyCaretMovedByDom, settleDirectCaretClaim, invalidatePendingCaretMove, cancelPendingCaretMove } =
    useNotesDirectCaretReconciliation({
      pendingPrimarySelectionRef, navigationVersionRef, editingFocusRef,
      selectionRef, selectionRevisionRef, stateRef, closedRef, applyAction, replaceSelection,
    });
  const retirePendingPrimarySelection = useCallback((): void => {
    const pendingPrimarySelection = pendingPrimarySelectionRef.current;
    if (pendingPrimarySelection === null) return;
    pendingPrimarySelectionRef.current = null;
    applyAction({
      type: "acknowledgePendingFocus",
      nodeId: pendingPrimarySelection.nodeId,
    });
  }, [applyAction]);
  // Combine settled navigation with the live caret in one place. applyAction
  // retires the caret as soon as authoritative navigation moves elsewhere.
  const currentNavigation = useCallback(
    (): LiveNotesNavigation =>
      currentNotesNavigation(stateRef.current, editingFocusRef.current),
    [],
  );
  const currentEditingFocus = useCallback(
    (): NotesHistoryFocus | null => editingFocusRef.current,
    [],
  );

  const {
    draftsByNodeId,
    currentWriteError,
    notifyDraftsListeners,
    notifyWriteErrorListeners,
  } = useNotesDraftExternalStore(draftEngineRef);
  const retryAuthorityRecovery = useCallback(async (): Promise<void> => {
    await sessionRef.current?.retryAuthorityRecovery();
  }, []);
  const consumeInsertionMotion = useCallback(
    (intentToken: number, cancelFocusNodeId?: NoteId): void => {
      const focus = pendingKeyboardInsertionFocusRef.current;
      if (
        settlementRuntime.ownsKeyboardInsertionFocus(
          focus,
          vaultRoot,
          intentToken,
          cancelFocusNodeId,
        )
      ) {
        pendingKeyboardInsertionFocusRef.current = null;
        applyAction({
          type: "acknowledgePendingFocus",
          nodeId: cancelFocusNodeId,
        });
      }
      setProjectionPublication((current) =>
        settlementRuntime.consumedInsertionMotion(current, intentToken),
      );
    },
    [applyAction, vaultRoot],
  );
  useLayoutEffect(() => {
    sessionRetirementTokenRef.current = null;
    cancelPendingCaretMove();
    closedRef.current = false;
    outlineCompositionActiveRef.current = false;
    pendingNavigationRef.current = null;
    const previousEngine = draftEngineRef.current;
    if (previousEngine) {
      prepareAttachmentUploadAttemptsForTeardown();
      void shutdownAfterBackspaceDrain(previousEngine);
    }
    applyAction({ type: "startWorkspaceLoad" });
    clearAttachmentUploadUi();
    discardAttachmentUploadAttempts();
    const resetHistoryStatus = emptyHistoryState();
    historyStatusRef.current = resetHistoryStatus;
    setHistoryStatus(resetHistoryStatus);
    setAuthorityRecovery({ kind: "known" });
    setProjectionPublication(null);
    const emptyOptimisticSnapshot = { insertions: [], failure: null };
    optimisticInsertionSnapshotRef.current = emptyOptimisticSnapshot;
    pendingOptimisticTitleFlushesRef.current.clear();
    setOptimisticInsertionSnapshot(emptyOptimisticSnapshot);
    setOptimisticBackspaceGesture(null);
    activeScopeRef.current = { kind: "active" };
    activeWorkspaceGenerationRef.current += 1;
    movePreparationTokenRef.current += 1;
    selectionPreparationTokenRef.current += 1;
    locallyExpandedNodeIdsRef.current = new Set();
    editingFocusRef.current = null;
    setLibraryView("all");
    resetTagFilterTracking();
    invalidateTagSummaries();
    setLocallyExpandedNodeIds(locallyExpandedNodeIdsRef.current);
    let engine!: NotesDraftEngine;
    let session!: NotesWorkspaceCoordinatorSession;
    let disconnectSync: (() => void) | null = null;
    const reloadFromSync = async (): Promise<void> => {
      const refreshScope = activeScopeRef.current;
      await session.enqueue(
        async (context) => {
          const workspace = await context.repository.loadWorkspace(
            context.vaultRoot,
            refreshScope,
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
            suppressSynchronization: true,
            invalidatesTagSummaries: true,
          };
        },
        { observer: true },
      );
    };
    const connectSyncAfterActivation = (): void => {
      if (
        disconnectSync !== null ||
        engine.record.closing ||
        sessionRecordRef.current !== engine.record ||
        sessionRef.current !== session
      ) {
        return;
      }
      disconnectSync = connectNotesSyncRuntime({
        vaultRoot,
        onWorkspaceChanged: reloadFromSync,
      });
    };
    session = notesWorkspaceCoordinatorRegistry.openSession({
      repository,
      vaultRoot,
      presentation: "writable",
      captureHistoryLocation: () => captureHistoryLocationRef.current(),
      applyHistoryLocation: (workspace, snapshot) =>
        applyHistoryLocationRef.current(workspace, snapshot),
      onEvent(event) {
        if (
          engine.record.closing ||
          sessionRecordRef.current !== engine.record
        ) {
          return;
        }
        if (
          event.type === "settled" &&
          event.result.kind === "authoritative"
        ) {
          connectSyncAfterActivation();
        }
        if (event.type === "pending") {
          if (event.showLoading) {
            applyAction({ type: "setLoading" });
          }
          if (
            event.selectionPolicy === "clear" &&
            selectionRef.current !== null
          ) {
            updateSelection({ type: "clearSelection" });
          }
          return;
        }
        if (event.type === "authorityRecovery") {
          adoptNotesWriteAuthority(
            event.authority,
            setAuthorityRecovery,
            engine,
          );
          return;
        }
        if (event.type === "optimisticInsertion") {
          settlementRuntime.recordPendingOptimisticTitles(
            optimisticInsertionSnapshotRef.current,
            event,
            pendingOptimisticTitleFlushesRef.current
          );
          optimisticInsertionSnapshotRef.current = event.snapshot;
          setOptimisticInsertionSnapshot(event.snapshot);
          if (event.rollback) {
            const request = {
              requestId: ++nextPrimarySelectionRequestIdRef.current,
              nodeId: event.rollback.sourceId,
              field: "title" as const,
              selection: { ...event.rollback.selection }
            };
            if (event.rollback.ownerPaneId === "secondary") {
              paneSessions.dispatchPane("secondary", {
                type: "setPendingPrimarySelection",
                request
              });
              paneSessions.dispatchPane("secondary", {
                type: "setNavigation",
                patch: {
                  selectedId: event.rollback.sourceId,
                  editingNoteId: event.rollback.sourceId,
                  pendingFocusId: event.rollback.sourceId,
                  pendingFocusField: "title"
                }
              });
            } else {
              pendingPrimarySelectionRef.current = request;
              applyAction({
                type: "focusNode",
                nodeId: event.rollback.sourceId
              });
            }
          }
          return;
        }
        if (event.type === "optimisticBackspaceGesture") {
          setOptimisticBackspaceGesture(event.snapshot);
          if (event.rollback) {
            const request = {
              requestId: ++nextPrimarySelectionRequestIdRef.current,
              nodeId: event.rollback.nodeId,
              field: "title" as const,
              selection: { ...event.rollback.selection },
            };
            if (event.rollback.ownerPaneId === "secondary") {
              paneSessions.dispatchPane("secondary", {
                type: "setPendingPrimarySelection",
                request,
              });
              paneSessions.dispatchPane("secondary", {
                type: "setNavigation",
                patch: {
                  selectedId: event.rollback.nodeId,
                  editingNoteId: event.rollback.nodeId,
                  pendingFocusId: event.rollback.nodeId,
                  pendingFocusField: "title",
                },
              });
            } else {
              pendingPrimarySelectionRef.current = request;
              applyAction({
                type: "focusNode",
                nodeId: event.rollback.nodeId,
              });
            }
          }
          return;
        }
        const routed =
          settlementRuntime.routeKeyboardInsertionNavigation(event.result);
        if (routed.secondaryNavigation) {
          paneSessions.dispatchPane("secondary", {
            type: "setNavigation",
            patch: routed.secondaryNavigation
          });
        }
        const settledResult = routed.primaryResult;
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
          settledResult.kind !== "skipped" &&
          settledResult.historyStatus
        ) {
          historyStatusRef.current = settledResult.historyStatus;
          setHistoryStatus(settledResult.historyStatus);
        }
        if (settledResult.kind !== "skipped") {
          setHistoryTimelineVersion((version) => version + 1);
        }
        if (
          settledResult.kind === "authoritative" &&
          settledResult.tagSummaries !== undefined
        ) {
          setTagSummaries(settledResult.tagSummaries);
        }
        if (
          settledResult.kind !== "skipped" &&
          settledResult.invalidatesTagSummaries
        ) {
          void requestTagSummaryRefresh();
        }
        pendingKeyboardInsertionFocusRef.current =
          settlementRuntime.settledKeyboardInsertionFocus(
            pendingKeyboardInsertionFocusRef.current,
            settledResult,
            vaultRoot,
          );
        const nextExpansions = settlementRuntime.settledLocalExpansions(
          locallyExpandedNodeIdsRef.current,
          settledResult,
        );
        if (nextExpansions !== locallyExpandedNodeIdsRef.current) {
          locallyExpandedNodeIdsRef.current = nextExpansions;
          setLocallyExpandedNodeIds(nextExpansions);
        }
        if (
          event.type === "synchronized" &&
          (event.sourceScope === null ||
            !sameScope(event.sourceScope, activeScopeRef.current))
        ) {
          void reloadFromSync();
          return;
        }
        setProjectionPublication(
          settledResult.kind === "skipped"
            ? null
            : (settledResult.projectionPublication ?? null),
        );
        // The reducer settles navigation from this same result via its one
        // reconciler; a stale editing caret is naturally ignored once the
        // reducer moves the editing node (see currentNavigation's guard), so
        const settledWorkspace =
          settledResult.kind === "authoritative"
            ? settledResult.workspace
            : settledResult.kind === "failure"
              ? settledResult.workspace
              : undefined;
        if (settledWorkspace) {
          engine.reconcileReadonlyAuthority(settledWorkspace);
        }
        applyAction({
          type: "settleQueueWork",
          result: settledResult,
          hasPendingWork: event.hasPendingWork,
        });
        for (const update of settlementRuntime.confirmedOptimisticTitleUpdates(
          settledResult,
          pendingOptimisticTitleFlushesRef.current
        )) {
          updateNodeDraft(update.nodeId, update, "title");
          void flushNodeDraft(update.nodeId);
        }
      },
      captureDraftCutoff: (publicationOwner) =>
        engine.captureDraftCutoff(publicationOwner),
      beforeStructural: (
        cutoff,
        drainEnqueue?: NotesWorkspaceDrainEnqueue,
      ) => engine.flushDraftBarrier(cutoff, drainEnqueue),
      afterStructural: (cutoff) => {
        engine.releaseDraftBarrier(cutoff);
        releaseFinalizedDetachedAttachmentUploadAttempts(engine.record);
      },
      isCurrent: () =>
        !engine.record.closing &&
        sessionRecordRef.current === engine.record &&
        sessionRef.current === session,
      getScope: () => activeScopeRef.current,
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
          message: "Text composition was interrupted. Try the action again.",
        }),
    };
    engine = new NotesDraftEngine({
      repository,
      vaultRoot,
      session,
      writeQueue: createNotesWriteQueue(),
      host,
    });
    registerCoordinatorSessionForDraftEngine(engine, session);
    adoptNotesWriteAuthority(
      session.writeAuthority(),
      setAuthorityRecovery,
      engine,
    );
    sessionRecordRef.current = engine.record;
    sessionRef.current = session;
    draftEngineRef.current = engine;
    const bufferedCommands = bufferedCommandsRef.current;
    const unregisterNotesDataDeletionParticipant =
      registerNotesDataDeletionParticipant(repository, vaultRoot, engine);
    const unsubscribeImageImportRecovery = subscribeToImageImportRecovery(
      repository,
      vaultRoot,
      () => attachmentRecoveryChangeRef.current(),
    );
    attachmentRecoveryChangeRef.current();
    // Point the drafts external store at the freshly opened engine (empty
    // buffer). The engine wires its own recovery subscription internally.
    notifyDraftsListeners();
    notifyWriteErrorListeners();
    enqueueBufferedWorkspaceCommands(
      session,
      bufferedCommands.splice(0),
    );
    return () => {
      disconnectSync?.();
      outlineCompositionActiveRef.current = false;
      pendingNavigationRef.current = null;
      unregisterNotesDataDeletionParticipant();
      unsubscribeImageImportRecovery();
      if (sessionRef.current === session) {
        const retirementToken = {};
        sessionRetirementTokenRef.current = retirementToken;
        // Descendant layout cleanups may still publish DOM-owned editor buffers.
        // A replaying setup clears this token before the old cleanup can retire
        // the newly opened session.
        queueMicrotask(() => {
          if (
            sessionRetirementTokenRef.current !== retirementToken ||
            sessionRef.current !== session
          ) {
            return;
          }
          sessionRetirementTokenRef.current = null;
          sessionRef.current = null;
          resolveBufferedWorkspaceCommands(bufferedCommands.splice(0));
        });
      }
    };
    // Session subscribe/teardown effect keyed on vault/repository; the engine's
    // host collaborators are stable callbacks invoked from the effect but omitted
    // so a re-render does not tear down and re-open the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    discardAttachmentUploadAttempts,
    clearAttachmentUploadUi,
    cancelPendingCaretMove,
    prepareAttachmentUploadAttemptsForTeardown,
    releaseFinalizedDetachedAttachmentUploadAttempts,
    invalidateTagSummaries,
    repository,
    requestTagSummaryRefresh,
    resetTagFilterTracking,
    vaultRoot,
  ]);
  useEffect(() => {
    finalCleanupTokenRef.current = null;
    return () => {
      const engine = draftEngineRef.current;
      if (engine) {
        prepareAttachmentUploadAttemptsForTeardown();
        void shutdownAfterBackspaceDrain(engine);
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
        resolveBufferedWorkspaceCommands(bufferedCommandsRef.current.splice(0));
      });
    };
  }, [
    discardAttachmentUploadAttempts,
    prepareAttachmentUploadAttemptsForTeardown,
  ]);

  const imageAtomAuthorityCurrentAtQueueTurn = useCallback(
    (
      authority: NotesImageAtomAuthority,
      context: NotesWorkspaceQueueContext,
      record: NotesWorkspaceSessionRecord,
      workspace: NormalizedNotesWorkspace,
    ) =>
      sessionRecordRef.current === record &&
      sessionRef.current === record.session &&
      context.repository === record.repository &&
      sameScope(activeScopeRef.current, context.sourceScope) &&
      imageAtomEditorRegistry.isPasteAuthorityCurrent(
        capturedImageAtomAuthority(authority).editorAuthority,
      ) &&
      imageAtomAuthorityMatches(authority, {
        vaultRoot: context.vaultRoot,
        scope: context.sourceScope,
        generation: activeWorkspaceGenerationRef.current,
        session: sessionRef.current,
        record,
        workspace,
      }),
    [
      activeScopeRef,
      activeWorkspaceGenerationRef,
      imageAtomEditorRegistry,
      sessionRecordRef,
      sessionRef,
    ],
  );
  const isImageAtomCutAuthorityCurrentAtQueueTurn = useCallback<
    NotesCommandContext["isImageAtomCutAuthorityCurrentAtQueueTurn"]
  >(
    (authority, nodeId, context, record, workspace) =>
      capturedImageAtomAuthority(authority).nodeId === nodeId &&
      imageAtomAuthorityCurrentAtQueueTurn(
        authority,
        context,
        record,
        workspace,
      ),
    [imageAtomAuthorityCurrentAtQueueTurn],
  );
  const isImageAtomPasteAuthorityCurrentAtQueueTurn = useCallback<
    NotesCommandContext["isImageAtomPasteAuthorityCurrentAtQueueTurn"]
  >(
    (authority, context, record, workspace) =>
      imageAtomAuthorityCurrentAtQueueTurn(
        authority,
        context,
        record,
        workspace,
      ),
    [imageAtomAuthorityCurrentAtQueueTurn],
  );

  const {
    replaceLocalExpansions,
    captureHistorySnapshot,
    resolveHistoryLocation,
    registerHistoryOwner,
    beginTextEntry,
    beginStandaloneTextEntry,
    beginStructuralEntry,
    prepareKeyboardInsertion,
    completeHistoryOwner,
    settleAtomicMutation,
    discardHistoryEntry,
    runStructuralCommand,
    commandCtx,
    persistDraftMutation,
    markEditingFocus,
    setDraftEditingNavigation,
    getNavigationVersion,
    updateNodeDraft,
    flushNodeDraft,
    beginBackspaceDraftLease,
    registerEditorFlushAdapter,
    retryFailedDraft,
    retryLastFailedWrite,
    flushAllDraftsBeforeStructural,
    undo,
    redo,
    navigateWithHistory,
    setOutlineCompositionActive,
  } = useNotesHistoryController({
    repository,
    vaultRoot,
    publishFeedback,
    stateRef,
    activeScopeRef,
    activeWorkspaceGenerationRef,
    sessionRecordRef,
    sessionRef,
    vaultRootRef,
    libraryViewRef,
    requestedTagFiltersRef,
    tagFilterOriginRef,
    tagFilterRequestRef,
    movePreparationTokenRef,
    selectionPreparationTokenRef,
    selectionRevisionRef,
    locallyExpandedNodeIdsRef,
    navigationVersionRef,
    setLibraryView,
    setActiveTagFilters,
    setLocallyExpandedNodeIds,
    editingFocusRef,
    pendingPrimarySelectionRef,
    nextPrimarySelectionRequestIdRef,
    outlineCompositionActiveRef,
    pendingNavigationRef,
    historyOwnerByEntryIdRef,
    recoveredHistoryResultByEntryIdRef,
    historyStatusRef,
    captureHistoryLocationRef,
    applyHistoryLocationRef,
    bufferedCommandsRef,
    selectionRef,
    updateSelection,
    applyAction,
    currentNavigation,
    currentEditingFocus,
    draftEngineRef,
    closedRef,
    retirePendingPrimarySelection,
    imageImportMaxDisplayWidthRef,
    isImageAtomCutAuthorityCurrentAtQueueTurn,
    isImageAtomPasteAuthorityCurrentAtQueueTurn,
    paneSessions,
  });
  const {
    selectLibraryView,
    toggleTagFilter,
    searchNotes,
    openSearchResult,
    zoomTo,
  } = useNotesLibraryActions({
    repository,
    vaultRoot,
    navigateWithHistory,
    resolveHistoryLocation,
  });

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
          field: pending.pendingFocusField,
        };
      }
      if (pendingPrimarySelection !== null) {
        pendingPrimarySelectionRef.current = null;
      }
      if (pendingKeyboardInsertionFocusRef.current?.nodeId === nodeId) {
        pendingKeyboardInsertionFocusRef.current = null;
      }
      applyAction({ type: "acknowledgePendingFocus", nodeId });
    },
    [applyAction],
  );

  const focusNode = useCallback(
    async (nodeId: NoteId, selection?: NotesHistoryPrimarySelection) => {
      void flushNodeDraft(nodeId);
      navigationVersionRef.current += 1;
      pendingPrimarySelectionRef.current = selection
        ? {
            requestId: ++nextPrimarySelectionRequestIdRef.current,
            nodeId,
            field: "title",
            selection: { ...selection },
          }
        : null;
      // applyAction retires the live caret; the reducer owns the new position.
      applyAction({ type: "focusNode", nodeId });
    },
    [applyAction, flushNodeDraft],
  );

  const {
    createRoot,
    createChild,
    createNextTextSibling,
    materializeGithubNotification,
    refreshMaterializedGithubNotifications,
    markMaterializedGithubNotificationRead,
    setGithubGroupCollapsed,
    splitNode,
    updateNode,
    setReadonly,
    applyImageAtomEdit,
    applyImageAtomCutWithAuthority,
    applyImageAtomPaste,
    applyImageAtomPasteWithAuthority,
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
    archiveNode,
    unarchiveNode,
    beginBackspaceGesture,
    touchBackspaceGesture,
    removeEmptyNodeInBackspaceGesture,
    finishBackspaceGesture,
    cancelBackspaceGesture,
    removeEmptyNode,
    deleteNode,
    deleteNodes,
    restoreNode,
    emptyTrash,
    deleteAllNotesData,
  } = useNotesCommandActions({
    commandCtx,
    repository,
    vaultRoot,
    sessionRecordRef,
    sessionRef,
    beginBackspaceDraftLease,
    activeScopeRef,
    setLibraryView,
    setTagSummaries,
    resetTagFilterTracking,
    replaceLocalExpansions,
    purgeAttachmentUploadAttemptsAfterDataDeletion,
    createDraftFlushFailedError: notesDraftsFlushFailedError,
  });
  const {
    importClipboardImages,
    importDroppedImagePaths,
    uploadImage,
    retryImageUpload,
    loadAttachmentBytes,
    viewImageOriginal,
    downloadImage,
    resizeImage,
    removeImage,
  } = useNotesAttachmentWorkflow({
    repository,
    vaultRoot,
    attachmentUi,
    activeScopeRef,
    activeWorkspaceGenerationRef,
    stateRef,
    sessionRecordRef,
    sessionRef,
    vaultRootRef,
    closedRef,
    captureHistorySnapshot,
    beginStructuralEntry,
    discardHistoryEntry,
    registerHistoryOwner,
    runStructuralCommand,
    settleAtomicMutation,
    workflowState: attachmentWorkflowState,
  });

  const actions = useMemo<NotesWorkspaceActions>(() => {
    const deletionInProgress = (): boolean =>
      isNotesDataDeletionInProgress(repository, vaultRoot);
    const lifecycleDrainInProgress = (): boolean =>
      sessionRef.current?.isLifecycleDraining() === true;
    const writesUnavailable = (): boolean =>
      deletionInProgress() || lifecycleDrainInProgress();
    const gate =
      <Args extends unknown[]>(action: (...args: Args) => Promise<void>) =>
      (...args: Args): Promise<void> =>
        writesUnavailable() ? Promise.resolve() : action(...args);

    // Structural actions report their settlement, so the data-deletion
    // short-circuit resolves to "skipped" (the command never reached the queue).
    const gateOutcome =
      <Args extends unknown[]>(
        action: (...args: Args) => Promise<NotesWorkspaceCommandOutcome>,
      ) =>
      (...args: Args): Promise<NotesWorkspaceCommandOutcome> =>
        writesUnavailable() ? Promise.resolve("skipped") : action(...args);

    return {
      drain: () =>
        sessionRef.current?.drain() ?? Promise.resolve(false),
      releaseDrain: () => {
        sessionRef.current?.releaseDrain();
      },
      setOutlineCompositionActive,
      acknowledgeFocus: gate(acknowledgeFocus),
      focusNode: gate(focusNode),
      markEditingFocus: (nodeId, field) => {
        if (!writesUnavailable()) {
          markEditingFocus(nodeId, field);
        }
      },
      notifyCaretMovedByDom: (nodeId, field, claimAttempt) => {
        if (!writesUnavailable()) {
          notifyCaretMovedByDom(nodeId, field, claimAttempt);
        }
      },
      settleDirectCaretClaim,
      invalidatePendingCaretMove,
      getNavigationVersion,
      prepareKeyboardInsertion: (input) =>
        writesUnavailable() ? null : prepareKeyboardInsertion(input),
      updateOptimisticKeyboardInsertion: (nodeId, title) => {
        if (!writesUnavailable()) {
          sessionRef.current?.updateOptimisticKeyboardInsertion(nodeId, title);
        }
      },
      acknowledgeOptimisticKeyboardInsertionFocus: (nodeId, intentToken) =>
        sessionRef.current?.acknowledgeOptimisticKeyboardInsertionFocus(
          nodeId,
          intentToken
        ),
      dismissOptimisticInsertionFailure: () =>
        sessionRef.current?.dismissOptimisticInsertionFailure(),
      pendingKeyboardInsertionInteractionEpoch: (nodeId) =>
        settlementRuntime.pendingKeyboardInsertionEpoch(
          pendingKeyboardInsertionFocusRef.current,
          vaultRoot,
          nodeId,
        ),
      beginBackspaceGesture: (paneId, nodeId, selection) =>
        writesUnavailable()
          ? null
          : beginBackspaceGesture(paneId, nodeId, selection),
      touchBackspaceGesture: (token, nodeId) => {
        if (!writesUnavailable()) {
          touchBackspaceGesture(token, nodeId);
        }
      },
      removeEmptyNodeInBackspaceGesture: (token, nodeId, focusNodeId) =>
        !writesUnavailable() &&
        removeEmptyNodeInBackspaceGesture(token, nodeId, focusNodeId),
      finishBackspaceGesture,
      cancelBackspaceGesture,
      publishOutlinePaneState: (input) =>
        sessionRef.current?.publishOutlinePaneState(input),
      publishOutlineInteractionEpoch: (input) =>
        sessionRef.current?.publishOutlineInteractionEpoch(input),
      publishOutlineDragState: (input) =>
        sessionRef.current?.publishOutlineDragState(input),
      unregisterOutlinePane: (paneId) =>
        settlementRuntime.unregisterOwnedOutlinePane(
          sessionRecordRef.current,
          sessionRef.current,
          repository,
          vaultRoot,
          paneId,
        ),
      consumeInsertionMotion,
      createRoot: gateOutcome(createRoot),
      createNextTextSibling: gateOutcome(createNextTextSibling),
      materializeGithubNotification: gateOutcome(materializeGithubNotification),
      refreshMaterializedGithubNotifications: gateOutcome(
        refreshMaterializedGithubNotifications,
      ),
      markMaterializedGithubNotificationRead: gateOutcome(
        markMaterializedGithubNotificationRead,
      ),
      setGithubGroupCollapsed: gateOutcome(setGithubGroupCollapsed),
      splitNode: gateOutcome(splitNode),
      createChild: gateOutcome(createChild),
      updateNode: gateOutcome(updateNode),
      setReadonly: gateOutcome(setReadonly),
      applyImageAtomEdit: gateOutcome(applyImageAtomEdit),
      applyImageAtomPaste: gateOutcome(applyImageAtomPaste),
      updateNodeDraft: (nodeId, patch, field) => {
        if (!writesUnavailable()) {
          updateNodeDraft(nodeId, patch, field);
        }
      },
      registerEditorFlushAdapter,
      flushNodeDraft: (nodeId) =>
        writesUnavailable() ? Promise.resolve(false) : flushNodeDraft(nodeId),
      flushAllDrafts: () =>
        writesUnavailable()
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
      deleteNodes,
      restoreNode: gateOutcome(restoreNode),
      archiveNode: gateOutcome(archiveNode),
      unarchiveNode: gateOutcome(unarchiveNode),
      emptyTrash: gateOutcome(emptyTrash),
      selectLibraryView: gate(selectLibraryView),
      toggleTagFilter: gate(toggleTagFilter),
      searchNotes: (query) =>
        writesUnavailable() ? Promise.resolve([]) : searchNotes(query),
      openSearchResult: gate(openSearchResult),
      deleteAllNotesData: (options) =>
        writesUnavailable()
          ? Promise.reject(new Error("The Notes workspace is unavailable."))
          : deleteAllNotesData(options),
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
      getSelectionSnapshot,
    };
  }, [
    repository,
    vaultRoot,
    setOutlineCompositionActive,
    acknowledgeFocus,
    focusNode,
    markEditingFocus,
    notifyCaretMovedByDom, settleDirectCaretClaim, invalidatePendingCaretMove,
    getNavigationVersion,
    prepareKeyboardInsertion,
    beginBackspaceGesture,
    touchBackspaceGesture,
    removeEmptyNodeInBackspaceGesture,
    finishBackspaceGesture,
    cancelBackspaceGesture,
    consumeInsertionMotion,
    createRoot,
    createNextTextSibling,
    materializeGithubNotification,
    refreshMaterializedGithubNotifications,
    markMaterializedGithubNotificationRead,
    setGithubGroupCollapsed,
    splitNode,
    createChild,
    updateNode,
    setReadonly,
    applyImageAtomEdit,
    applyImageAtomPaste,
    updateNodeDraft,
    registerEditorFlushAdapter,
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
    deleteNodes,
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
    getSelectionSnapshot,
  ]);

  const {
    isPreparedSelectionAuthorityCurrent,
    prepareSelectionAuthority,
    applyPreparedSelectionBatch,
    loadActiveNodesForMove,
    prepareMoveNode,
    commitPreparedMove,
  } = useNotesSelectionAuthority({
    repository,
    vaultRoot,
    commandCtx,
    activeScopeRef,
    activeWorkspaceGenerationRef,
    movePreparationTokenRef,
    navigationVersionRef,
    selectionPreparationTokenRef,
    selectionRevisionRef,
    sessionRef,
    sessionRecordRef,
    vaultRootRef,
  });

  const stateSlice = useMemo<NotesStateSlice>(() => {
    // Every shared-timeline settlement bumps the version observed by this slice.
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
      canUndo:
        authorityRecovery.kind === "known" &&
        (sessionHistory?.canUndo() ?? false),
      canRedo:
        authorityRecovery.kind === "known" &&
        (sessionHistory?.canRedo() ?? false),
      authorityRecovery,
      projectionPublication,
      retryAuthorityRecovery,
      pendingPrimarySelection: pendingPrimarySelectionRef.current,
    };
  }, [
    state,
    deletingNotesData,
    libraryView,
    activeTagFilters,
    tagSummaries,
    locallyExpandedNodeIds,
    historyTimelineVersion,
    authorityRecovery,
    projectionPublication,
    retryAuthorityRecovery,
  ]);

  const draftsSlice = useMemo<NotesDraftsSlice>(
    () => ({
      draftsByNodeId,
      writeError: currentWriteError,
      optimisticBackspaceGesture,
      optimisticKeyboardInsertions: optimisticInsertionSnapshot.insertions,
      optimisticInsertionFailure: optimisticInsertionSnapshot.failure,
      attachmentUploadErrorsByNodeId,
      attachmentUploadRetryAttemptIdsByNodeId,
      selection,
      selectionRevision: selectionRevisionRef.current,
    }),
    [
      draftsByNodeId,
      currentWriteError,
      optimisticBackspaceGesture,
      optimisticInsertionSnapshot,
      attachmentUploadErrorsByNodeId,
      attachmentUploadRetryAttemptIdsByNodeId,
      selection,
      selectionRevisionRef,
    ],
  );

  const actionsSlice = useMemo<NotesActionsSlice>(
    () => ({
      actions,
      registerActiveImageAtomEditor,
      claimActiveImageAtomPaste,
      captureActiveImageAtomEditorAuthority,
      captureImageAtomCutAuthority,
      applyImageAtomCutWithAuthority,
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
      applyPreparedSelectionBatch,
    }),
    [
      actions,
      registerActiveImageAtomEditor,
      claimActiveImageAtomPaste,
      captureActiveImageAtomEditorAuthority,
      captureImageAtomCutAuthority,
      applyImageAtomCutWithAuthority,
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
      applyPreparedSelectionBatch,
    ],
  );

  const paneRegistrySlice = useNotesWorkspacePaneRegistry({
    sessions: paneSessions,
    state,
    stateSlice,
    draftsSlice,
    actionsSlice,
    navigateWithHistory,
    editingLease,
    primary: {
      pendingPrimarySelection: pendingPrimarySelectionRef.current,
      locallyExpandedNodeIds,
      selection: selection ?? null,
      selectionRevision: selectionRevisionRef.current,
      navigationVersion: navigationVersionRef.current,
    },
  });

  return {
    ...stateSlice,
    ...draftsSlice,
    ...actionsSlice,
    stateSlice,
    draftsSlice,
    actionsSlice,
    paneRegistrySlice,
  };
}
