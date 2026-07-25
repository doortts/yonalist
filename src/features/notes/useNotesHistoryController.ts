import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";
import type {
  NoteId,
  NotesHistoryContext,
  NotesHistoryStatus,
  NotesStore,
  NotesWorkspace
} from "../../domain/notes";
import type {
  NotesPendingSelectionPolicy,
  NotesWorkspaceCommandOutcome,
  NotesWorkspaceCoordinatorSession,
  NotesWorkspaceQueueContext,
  NotesWorkspaceQueueResult,
  NotesWorkspaceQueueWork,
  NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import { isNotesDataDeletionInProgress } from "./notesDataDeletionRegistry";
import {
  notesExpansionSnapshotPool,
  normalizeHistoryPrimarySelection,
  type NotesHistoryFocus,
  type NotesHistoryOwnerRegistry,
  type NotesHistorySnapshot
} from "./notesHistory";
import {
  normalizeWorkspace,
  reconcileUiState,
  type NormalizedNotesWorkspace,
  type NotesSelection,
  type NotesWorkspaceReducerAction
} from "./notesWorkspaceReducer";
import { canonicalizeTagFilters, sameScope } from "./notesWorkspaceScope";
import type { NotesDraftEngine, NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import type { NotesCommandContext } from "./notesCommands";
import {
  authoritative,
  type UnwrappedNotesMutation
} from "./notesWorkspaceProjection";
import { bindCommittedMutationReloadRecovery, emptyHistoryState } from "./notesWorkspaceCommandSupport";
import {
  cloneOwnedHistorySnapshot,
  cloneWorkspaceScope,
  errorMessage,
  historyProjectionOptions,
  libraryStateForScope,
  releaseOwnedHistorySnapshot,
  sameHistorySnapshot,
  type NavigationIntent,
  type ResolvedHistoryLocation
} from "./notesWorkspaceNavigationSupport";
import type {
  LiveNotesNavigation,
  NotesKeyboardInsertionPreparation,
  NotesKeyboardInsertionRequest,
  NotesPendingPrimarySelection,
  ProjectedNotesMutation,
  StructuralCommandOptions,
  UseNotesWorkspaceOptions
} from "./notesWorkspaceTypes";
import type { NotesSelectionStateController } from "./useNotesSelectionController";
import { useNotesDraftWorkflow } from "./useNotesDraftWorkflow";
import type { NotesPaneSessionsController } from "./useNotesPaneSessions";
import type { NotesPaneId } from "./notesPaneSession";
import {
  applySecondaryPaneHistory,
  captureNotesHistorySnapshot,
  isSecondaryPaneHistoryValid,
  mergeNavigationPaneHistory,
  resolveSecondaryPaneHistory
} from "./notesPaneHistory";

interface LiveRef<T> {
  current: T;
}

export interface BufferedWorkspaceCommand {
  work: NotesWorkspaceQueueWork;
  structural?: boolean;
  selectionPolicy?: NotesPendingSelectionPolicy;
  resolve(outcome: NotesWorkspaceCommandOutcome): void;
}

export interface NotesHistoryControllerDependencies {
  readonly repository: NotesStore;
  readonly vaultRoot: string;
  readonly publishFeedback: UseNotesWorkspaceOptions["publishFeedback"];
  readonly stateRef: LiveRef<NormalizedNotesWorkspace>;
  readonly activeScopeRef: NotesCommandContext["activeScopeRef"];
  readonly activeWorkspaceGenerationRef: NotesCommandContext["activeWorkspaceGenerationRef"];
  readonly sessionRecordRef: NotesCommandContext["sessionRecordRef"];
  readonly sessionRef: NotesCommandContext["sessionRef"];
  readonly vaultRootRef: NotesCommandContext["vaultRootRef"];
  readonly libraryViewRef: NotesCommandContext["libraryViewRef"];
  readonly requestedTagFiltersRef: NotesCommandContext["requestedTagFiltersRef"];
  readonly tagFilterOriginRef: NotesCommandContext["tagFilterOriginRef"];
  readonly tagFilterRequestRef: NotesCommandContext["tagFilterRequestRef"];
  readonly movePreparationTokenRef: NotesCommandContext["movePreparationTokenRef"];
  readonly selectionPreparationTokenRef: NotesCommandContext["selectionPreparationTokenRef"];
  readonly selectionRevisionRef: NotesCommandContext["selectionRevisionRef"];
  readonly locallyExpandedNodeIdsRef: NotesCommandContext["locallyExpandedNodeIdsRef"];
  readonly navigationVersionRef: NotesCommandContext["navigationVersionRef"];
  readonly setLibraryView: NotesCommandContext["setLibraryView"];
  readonly setActiveTagFilters: NotesCommandContext["setActiveTagFilters"];
  readonly setLocallyExpandedNodeIds: Dispatch<SetStateAction<ReadonlySet<NoteId>>>;
  readonly editingFocusRef: LiveRef<NotesHistoryFocus | null>;
  readonly pendingPrimarySelectionRef: LiveRef<NotesPendingPrimarySelection | null>;
  readonly nextPrimarySelectionRequestIdRef: LiveRef<number>;
  readonly outlineCompositionActiveRef: LiveRef<boolean>;
  readonly pendingNavigationRef: LiveRef<{
    session: NotesWorkspaceCoordinatorSession;
    ownerToken: number;
    workspaceGeneration: number;
    intent: NavigationIntent;
    originPaneId: NotesPaneId;
  } | null>;
  readonly historyOwnerByEntryIdRef: LiveRef<
    NotesHistoryOwnerRegistry<NotesWorkspaceCoordinatorSession>
  >;
  readonly recoveredHistoryResultByEntryIdRef: LiveRef<
    Map<string, NotesWorkspaceQueueResult>
  >;
  readonly historyStatusRef: LiveRef<NotesHistoryStatus>;
  readonly captureHistoryLocationRef: LiveRef<() => NotesHistorySnapshot>;
  readonly applyHistoryLocationRef: LiveRef<
    (
      workspace: NormalizedNotesWorkspace,
      snapshot: NotesHistorySnapshot
    ) => boolean
  >;
  readonly bufferedCommandsRef: LiveRef<BufferedWorkspaceCommand[]>;
  readonly selectionRef: LiveRef<NotesSelection | null>;
  readonly updateSelection: NotesSelectionStateController["updateSelection"];
  readonly applyAction: (action: NotesWorkspaceReducerAction) => void;
  readonly currentNavigation: () => LiveNotesNavigation;
  readonly currentEditingFocus: () => NotesHistoryFocus | null;
  readonly draftEngineRef: LiveRef<NotesDraftEngine | null>;
  readonly closedRef: LiveRef<boolean>;
  readonly retirePendingPrimarySelection: () => void;
  readonly imageImportMaxDisplayWidthRef: LiveRef<number | null>;
  readonly isImageAtomCutAuthorityCurrentAtQueueTurn:
    NotesCommandContext["isImageAtomCutAuthorityCurrentAtQueueTurn"];
  readonly isImageAtomPasteAuthorityCurrentAtQueueTurn:
    NotesCommandContext["isImageAtomPasteAuthorityCurrentAtQueueTurn"];
  readonly paneSessions: NotesPaneSessionsController;
}

function asCoordinatorSession(
  session: NotesWorkspaceSessionRecord["session"]
): NotesWorkspaceCoordinatorSession {
  return session as NotesWorkspaceCoordinatorSession;
}

export function useNotesHistoryController({
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
  paneSessions
}: NotesHistoryControllerDependencies) {
  const replaceLocalExpansions = useCallback(
    (nodeIds: ReadonlySet<NoteId>): void => {
      navigationVersionRef.current += 1;
      locallyExpandedNodeIdsRef.current = nodeIds;
      setLocallyExpandedNodeIds(nodeIds);
    },
    [locallyExpandedNodeIdsRef, navigationVersionRef, setLocallyExpandedNodeIds]
  );

  const buildHistorySnapshot = useCallback(
    (
      navigation: LiveNotesNavigation,
      expandedNodeIds: ReadonlySet<NoteId>,
      focus?: NotesHistoryFocus | null
    ): NotesHistorySnapshot => {
      return captureNotesHistorySnapshot({
        navigation,
        expandedNodeIds,
        focus,
        scope: activeScopeRef.current,
        libraryView: libraryViewRef.current,
        activeTagFilters: requestedTagFiltersRef.current,
        tagFilterOrigin: tagFilterOriginRef.current,
        paneSessions
      });
    },
    [
      activeScopeRef,
      libraryViewRef,
      requestedTagFiltersRef,
      tagFilterOriginRef,
      paneSessions
    ]
  );

  const captureHistorySnapshot = useCallback(
    (focus?: NotesHistoryFocus | null): NotesHistorySnapshot =>
      buildHistorySnapshot(
        currentNavigation(),
        locallyExpandedNodeIdsRef.current,
        focus
      ),
    [buildHistorySnapshot, currentNavigation, locallyExpandedNodeIdsRef]
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
      if (!isSecondaryPaneHistoryValid(snapshot.secondaryPane, workspace)) {
        return false;
      }
      const origin = snapshot.tagFilterOrigin ?? null;
      if (origin?.libraryView === "tags") return false;
      // Replay supersedes any uncommitted DOM request before publishing its fresh request.
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
      applySecondaryPaneHistory(snapshot.secondaryPane, paneSessions);
      paneSessions.setActivePaneId(snapshot.activePaneId ?? "primary");
      return true;
    },
    [
      activeScopeRef,
      activeWorkspaceGenerationRef,
      applyAction,
      editingFocusRef,
      libraryViewRef,
      locallyExpandedNodeIdsRef,
      navigationVersionRef,
      nextPrimarySelectionRequestIdRef,
      pendingPrimarySelectionRef,
      paneSessions,
      requestedTagFiltersRef,
      selectionRef,
      setActiveTagFilters,
      setLibraryView,
      setLocallyExpandedNodeIds,
      stateRef,
      tagFilterOriginRef,
      updateSelection
    ]
  );
  // Resolution has no presentation side effects; callers own revisions until cursor/coordinator settlement.
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
      const secondaryPane = resolveSecondaryPaneHistory(
        requested.secondaryPane,
        workspace
      );
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
          ...(secondaryPane ? { secondaryPane } : {}),
          ...(requested.activePaneId
            ? { activePaneId: requested.activePaneId }
            : {}),
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
    [historyOwnerByEntryIdRef]
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
  }, [sessionRef]);

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
  const prepareKeyboardInsertion = useCallback(
    (input: NotesKeyboardInsertionRequest): NotesKeyboardInsertionPreparation | null => {
      const session = sessionRef.current;
      const preparation = session?.prepareKeyboardInsertion(input) ?? null;
      if (preparation && session) {
        registerHistoryOwner(preparation.historyContext, session);
      }
      return preparation;
    },
    [registerHistoryOwner, sessionRef]);
  const cancelKeyboardInsertion = useCallback(
    (preparation: NotesKeyboardInsertionPreparation): void => {
      sessionRef.current?.cancelKeyboardInsertion(preparation);
      historyOwnerByEntryIdRef.current.discard(preparation.historyContext.entryId);
    },
    [historyOwnerByEntryIdRef, sessionRef]
  );
  const completeHistoryOwner = useCallback((entryId: string): void => {
    historyOwnerByEntryIdRef.current.complete(entryId);
  }, [historyOwnerByEntryIdRef]);
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
      rejectedHistoryState?: NotesHistoryStatus,
      applyToCurrentOwner = false
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
      // Reducer reconciliation solely derives post-mutation navigation; no parallel owner advances.
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
        owner.history.rememberAfter(context.entryId, after);
      }
      owner.settleAuthoritativePresentation(
        settledWorkspace,
        after,
        applyToCurrentOwner ? { applyToCurrentOwner: true } : undefined
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
      historyOwnerByEntryIdRef,
      historyStatusRef,
      locallyExpandedNodeIdsRef,
      publishFeedback,
      recoveredHistoryResultByEntryIdRef,
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
        applyToCurrentOwner?: boolean;
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
          options?.recoverySource,
          undefined,
          undefined,
          options?.applyToCurrentOwner
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
        rejected ? recoveryState : undefined,
        options?.applyToCurrentOwner
      );
    },
    [historyOwnerByEntryIdRef, rememberHistoryAfter]
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
    [historyOwnerByEntryIdRef]
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
    [
      completeHistoryOwner,
      discardHistoryEntry,
      historyOwnerByEntryIdRef,
      sessionRef
    ]
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
          if (bindCommittedMutationReloadRecovery(cause, historyContext))
            completeHistoryOwner(historyContext!.entryId);
          else if (!options?.retainHistoryOnFailure)
            discardHistoryEntry(historyContext);
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
          selectionPolicy: options?.selectionPolicy,
          keyboardInsertion: options?.keyboardInsertion
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
      bufferedCommandsRef,
      captureHistorySnapshot, closedRef, completeHistoryOwner,
      discardHistoryEntry,
      historyOwnerByEntryIdRef,
      recoveredHistoryResultByEntryIdRef,
      repository,
      sessionRecordRef,
      vaultRoot
    ]
  );

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
      isImageAtomCutAuthorityCurrentAtQueueTurn,
      isImageAtomPasteAuthorityCurrentAtQueueTurn,
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
      closeTextBurst,
      cancelKeyboardInsertion
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
      cancelKeyboardInsertion,
      activeScopeRef,
      activeWorkspaceGenerationRef,
      imageImportMaxDisplayWidthRef,
      isImageAtomCutAuthorityCurrentAtQueueTurn,
      isImageAtomPasteAuthorityCurrentAtQueueTurn,
      libraryViewRef,
      locallyExpandedNodeIdsRef,
      movePreparationTokenRef,
      navigationVersionRef,
      recoveredHistoryResultByEntryIdRef,
      requestedTagFiltersRef,
      sessionRecordRef,
      sessionRef,
      setActiveTagFilters,
      setLibraryView,
      stateRef,
      tagFilterOriginRef,
      tagFilterRequestRef,
      selectionPreparationTokenRef,
      selectionRevisionRef,
      vaultRootRef
    ]
  );

  const {
    persistDraftMutation,
    markEditingFocus,
    setDraftEditingNavigation,
    getNavigationVersion,
    updateNodeDraft,
    flushNodeDraft,
    beginBackspaceDraftLease,
    registerImageAtomFlushAdapter,
    retryFailedDraft,
    retryLastFailedWrite,
    flushAllDraftsBeforeStructural
  } = useNotesDraftWorkflow({
    repository,
    vaultRoot,
    activeScopeRef,
    draftEngineRef,
    editingFocusRef,
    navigationVersionRef,
    selectionRef,
    updateSelection,
    retirePendingPrimarySelection,
    settleAtomicMutation
  });

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
          const live = captureHistorySnapshot();
          const replayTarget = mergeNavigationPaneHistory(
            target, live, candidate.originPaneId
          );
          releaseOwnedHistorySnapshot(live);
          const resolved = await resolveHistoryLocation(replayTarget);
          releaseOwnedHistorySnapshot(replayTarget);
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
            // Canonical presentation takes the retain; this resolver lease only bridges commit.
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
      activeScopeRef,
      captureHistorySnapshot,
      publishFeedback,
      resolveHistoryLocation,
      sessionRecordRef,
      sessionRef
    ]
  );

  const undo = useCallback(() => replayHistory("undo"), [replayHistory]);
  const redo = useCallback(() => replayHistory("redo"), [replayHistory]);

  const navigateWithHistory = useCallback(
    async (
      intent: NavigationIntent,
      workspaceGeneration = activeWorkspaceGenerationRef.current,
      originPaneId: NotesPaneId = "primary"
    ): Promise<void> => {
      const session = sessionRef.current;
      if (!session) return;
      const ownerToken = session.ownerToken();
      if (ownerToken === 0 || !session.isCurrentOwner(ownerToken)) return;
      if (originPaneId === "primary") navigationVersionRef.current += 1;
      if (outlineCompositionActiveRef.current) {
        pendingNavigationRef.current = {
          session,
          ownerToken,
          workspaceGeneration,
          intent,
          originPaneId
        };
        return;
      }

      await session.enqueueStructural(
        async (context) => {
          if (!session.isCurrentOwner(ownerToken)) {
            return { kind: "skipped" };
          }
          session.history.closeTextBurst();
          const lease =
            session.reserveAdmittedNavigation(undefined, originPaneId);
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
            const projectionOptions = historyProjectionOptions(
              resolved.snapshot, resolved.tagSummaries
            );
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
              projectionOptions
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
    [
      activeWorkspaceGenerationRef,
      captureHistorySnapshot,
      outlineCompositionActiveRef,
      pendingNavigationRef, navigationVersionRef,
      publishFeedback,
      resolveHistoryLocation,
      sessionRef
    ]
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
      void navigateWithHistory(pending.intent, pending.workspaceGeneration,
        pending.originPaneId);
    },
    [
      navigateWithHistory,
      outlineCompositionActiveRef,
      pendingNavigationRef,
      sessionRef
    ]
  );

  return {
    replaceLocalExpansions,
    captureHistorySnapshot,
    applyHistoryLocation,
    resolveHistoryLocation,
    registerHistoryOwner,
    beginTextEntry,
    beginStandaloneTextEntry,
    closeTextBurst,
    beginStructuralEntry,
    prepareKeyboardInsertion,
    cancelKeyboardInsertion,
    completeHistoryOwner,
    rememberHistoryAfter,
    settleAtomicMutation,
    discardHistoryEntry,
    settleInlineTextEntry,
    runStructuralCommand,
    commandCtx,
    persistDraftMutation,
    markEditingFocus,
    setDraftEditingNavigation,
    getNavigationVersion,
    updateNodeDraft,
    flushNodeDraft,
    beginBackspaceDraftLease,
    registerImageAtomFlushAdapter,
    retryFailedDraft,
    retryLastFailedWrite,
    flushAllDraftsBeforeStructural,
    undo,
    redo,
    navigateWithHistory,
    setOutlineCompositionActive
  };
}
