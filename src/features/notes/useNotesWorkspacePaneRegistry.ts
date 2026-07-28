import { useCallback, useMemo, useRef } from "react";
import {
  notesSelectionReducer,
  type NormalizedNotesWorkspace,
  type NotesSelection,
  type NotesSelectionAction
} from "./notesWorkspaceReducer";
import type {
  NotesActionsSlice,
  NotesDraftsSlice,
  NotesPaneRegistrySlice,
  NotesPaneRuntimeSlice,
  NotesPendingPrimarySelection,
  NotesStateSlice,
  NotesWorkspaceActions
} from "./notesWorkspaceTypes";
import type {
  NotesPaneSessionState
} from "./notesPaneSession";
import type { OptimisticKeyboardInsertion } from "./notesLocalStructure";
import type { NotesPaneSessionsController } from "./useNotesPaneSessions";
import type { NotesEditingLeaseController } from "./useNotesEditingLease";
import {
  cloneOwnedHistorySnapshot,
  type NavigationIntent
} from "./notesWorkspaceNavigationSupport";

const EMPTY_OPTIMISTIC_KEYBOARD_INSERTIONS:
  readonly OptimisticKeyboardInsertion[] = [];

interface UseNotesWorkspacePaneRegistryOptions {
  readonly sessions: NotesPaneSessionsController;
  readonly state: NormalizedNotesWorkspace;
  readonly stateSlice: NotesStateSlice;
  readonly draftsSlice: NotesDraftsSlice;
  readonly actionsSlice: NotesActionsSlice;
  readonly editingLease: NotesEditingLeaseController;
  readonly retirePendingPrimarySelection: () => void;
  readonly navigateWithHistory: (
    intent: NavigationIntent,
    workspaceGeneration?: number,
    originPaneId?: "primary" | "secondary"
  ) => Promise<void>;
  readonly primary: {
    readonly pendingPrimarySelection: NotesPendingPrimarySelection | null;
    readonly locallyExpandedNodeIds: ReadonlySet<string>;
    readonly selection: NotesSelection | null;
    readonly selectionRevision: number;
    readonly navigationVersion: number;
  };
}

export function useNotesWorkspacePaneRegistry({
  sessions,
  state,
  stateSlice,
  draftsSlice,
  actionsSlice,
  editingLease,
  retirePendingPrimarySelection,
  navigateWithHistory,
  primary
}: UseNotesWorkspacePaneRegistryOptions): NotesPaneRegistrySlice {
  const {
    activePaneId,
    panes,
    setActivePaneId,
    dispatchPane,
    getPaneSession
  } = sessions;
  const {
    canEdit,
    claim,
    release,
    setCompositionActive,
    structuralCommandsAllowed
  } = editingLease;
  const actionsRef = useRef(actionsSlice.actions);
  actionsRef.current = actionsSlice.actions;
  const actionsSliceRef = useRef(actionsSlice);
  actionsSliceRef.current = actionsSlice;
  const stateRef = useRef(state);
  stateRef.current = state;
  const primaryActionOverridesRef = useRef<
    Partial<NotesWorkspaceActions>
  >({});
  const primaryActionDispatchersRef = useRef(
    new Map<PropertyKey, (...args: unknown[]) => unknown>()
  );
  const primaryActionsRef = useRef<NotesWorkspaceActions | null>(null);
  if (primaryActionsRef.current === null) {
    primaryActionsRef.current = new Proxy(
      primaryActionOverridesRef.current as NotesWorkspaceActions,
      {
        get(target, property, receiver) {
          const override = Reflect.get(target, property, receiver);
          if (override !== undefined) return override;
          const action = Reflect.get(actionsRef.current, property);
          if (typeof action !== "function") return action;
          let dispatch = primaryActionDispatchersRef.current.get(property);
          if (!dispatch) {
            dispatch = (...args: unknown[]) => {
              const current = Reflect.get(actionsRef.current, property);
              return typeof current === "function"
                ? Reflect.apply(current, actionsRef.current, args)
                : undefined;
            };
            primaryActionDispatchersRef.current.set(property, dispatch);
          }
          return dispatch;
        }
      }
    );
  }
  const primaryActionsSliceDispatchersRef = useRef(
    new Map<PropertyKey, (...args: unknown[]) => unknown>()
  );
  const primaryActionsSliceRef = useRef<NotesActionsSlice | null>(null);
  if (primaryActionsSliceRef.current === null) {
    primaryActionsSliceRef.current = new Proxy({} as NotesActionsSlice, {
      get(_target, property) {
        if (property === "actions") return primaryActionsRef.current;
        const action = Reflect.get(actionsSliceRef.current, property);
        if (typeof action !== "function") return action;
        let dispatch = primaryActionsSliceDispatchersRef.current.get(property);
        if (!dispatch) {
          dispatch = (...args: unknown[]) => {
            const current = Reflect.get(actionsSliceRef.current, property);
            return typeof current === "function"
              ? Reflect.apply(current, actionsSliceRef.current, args)
              : undefined;
          };
          primaryActionsSliceDispatchersRef.current.set(property, dispatch);
        }
        return dispatch;
      }
    });
  }
  const primaryActionsSlice = primaryActionsSliceRef.current;
  const primaryNavigationVersionRef = useRef(primary.navigationVersion);
  primaryNavigationVersionRef.current = primary.navigationVersion;
  const primaryPendingSelectionRef = useRef(
    primary.pendingPrimarySelection
  );
  primaryPendingSelectionRef.current = primary.pendingPrimarySelection;
  const claimEditing = useCallback(
    async (
      paneId: "primary" | "secondary",
      nodeId: string,
      field: "title" | "note",
      isCurrent: () => boolean = () => true
    ): Promise<boolean> => {
      const claimed = await claim(
        { paneId, nodeId, field },
        actionsRef.current.flushNodeDraft,
        isCurrent
      );
      if (!claimed || !isCurrent()) return false;
      setActivePaneId(paneId);
      if (paneId === "primary") {
        actionsRef.current.markEditingFocus?.(nodeId, field);
      } else {
        dispatchPane("secondary", {
          type: "setPendingPrimarySelection",
          request: null
        });
        dispatchPane("secondary", {
          type: "setSelection",
          selection: null
        });
        dispatchPane("secondary", {
          type: "setNavigation",
          patch: {
            selectedId: nodeId,
            editingNoteId: nodeId,
            pendingFocusId: null,
            pendingFocusField: null
          }
        });
      }
      return true;
    },
    [
      claim,
      dispatchPane,
      setActivePaneId,
    ]
  );
  const setPaneComposition = useCallback(
    (paneId: "primary" | "secondary", active: boolean): void => {
      setCompositionActive(paneId, active);
      actionsRef.current.setOutlineCompositionActive?.(
        !structuralCommandsAllowed()
      );
    },
    [setCompositionActive, structuralCommandsAllowed]
  );
  const settleCrossPaneMove = useCallback(
    (
      sourcePaneId: "primary" | "secondary",
      destinationPaneId: "primary" | "secondary",
      focusNodeId: string
    ): void => {
      if (sourcePaneId === "primary") {
        actionsRef.current.clearSelection?.();
      } else {
        dispatchPane("secondary", {
          type: "setSelection",
          selection: null
        });
      }
      setActivePaneId(destinationPaneId);
      if (destinationPaneId === "secondary") {
        dispatchPane("secondary", {
          type: "setNavigation",
          patch: {
            selectedId: focusNodeId,
            editingNoteId: focusNodeId,
            pendingFocusId: focusNodeId,
            pendingFocusField: "title"
          }
        });
      }
    },
    [dispatchPane, setActivePaneId]
  );
  const moveNodeAcrossPanes = useCallback<
    NonNullable<NotesWorkspaceActions["moveNodeAcrossPanes"]>
  >(
    (input, sourcePaneId, destinationPaneId, expandNodeId) =>
      actionsRef.current.moveNode(
        input,
        destinationPaneId === "primary" ? input.id : undefined,
        {
          ...(expandNodeId === undefined ? {} : { expandNodeId }),
          beforeHistoryCapture: () =>
            settleCrossPaneMove(sourcePaneId, destinationPaneId, input.id)
        }
      ),
    [settleCrossPaneMove]
  );
  const applyPreparedSelectionBatchAcrossPanes = useCallback<
    NonNullable<NotesWorkspaceActions["applyPreparedSelectionBatchAcrossPanes"]>
  >(
    async (prepared, op, sourcePaneId, destinationPaneId, expandNodeId) => {
      const focusNodeId = prepared.selectedNodeIds[0];
      const apply = actionsSliceRef.current.applyPreparedSelectionBatch;
      if (!focusNodeId || !apply) {
        return { outcome: "skipped", mutationCommitted: false };
      }
      return apply(prepared, op, {
        focusNodeId: destinationPaneId === "primary" ? focusNodeId : undefined,
        expectedNavigationVersion:
          actionsRef.current.getNavigationVersion?.() ??
          primaryNavigationVersionRef.current,
        ...(expandNodeId === undefined ? {} : { expandNodeId }),
        beforeHistoryCapture: () =>
          settleCrossPaneMove(sourcePaneId, destinationPaneId, focusNodeId)
      });
    },
    [settleCrossPaneMove]
  );
  const primaryAcknowledgeFocus = useCallback(
    async (nodeId: string, requestId?: number) => {
      const pendingSelection = primaryPendingSelectionRef.current;
      const expectedRequestId = requestId ?? pendingSelection?.requestId;
      const requestIsCurrent = () => {
        if (pendingSelection === null) {
          return (
            primaryPendingSelectionRef.current === null &&
            stateRef.current.pendingFocusId === nodeId
          );
        }
        return (
          pendingSelection.nodeId === nodeId &&
          pendingSelection.requestId === expectedRequestId &&
          primaryPendingSelectionRef.current?.nodeId === nodeId &&
          primaryPendingSelectionRef.current.requestId ===
            expectedRequestId &&
          (pendingSelection.expectedUserInteractionRevision === undefined ||
            actionsRef.current.getUserInteractionRevision?.() ===
              pendingSelection.expectedUserInteractionRevision)
        );
      };
      const claimed = await claimEditing(
        "primary",
        nodeId,
        stateRef.current.pendingFocusField ?? "title",
        requestIsCurrent
      );
      if (!claimed) {
        if (
          pendingSelection !== null &&
          primaryPendingSelectionRef.current?.nodeId === nodeId &&
          primaryPendingSelectionRef.current.requestId ===
            expectedRequestId
        ) {
          retirePendingPrimarySelection();
        }
        return;
      }
      await actionsRef.current.acknowledgeFocus(nodeId, expectedRequestId);
    },
    [claimEditing, retirePendingPrimarySelection]
  );
  const primaryClaimEditingFocus = useCallback(
    (nodeId: string, field: "title" | "note") =>
      claimEditing("primary", nodeId, field),
    [claimEditing]
  );
  const primaryReleaseEditingFocus = useCallback(
    (nodeId?: string) => release("primary", nodeId),
    [release]
  );
  const primarySetOutlineCompositionActive = useCallback(
    (active: boolean) => setPaneComposition("primary", active),
    [setPaneComposition]
  );
  const primaryMarkEditingFocus = useCallback(
    (nodeId: string, field: "title" | "note") => {
      if (canEdit({ paneId: "primary", nodeId, field })) {
        actionsRef.current.markEditingFocus?.(nodeId, field);
      }
    },
    [canEdit]
  );
  const primaryUpdateNodeDraft = useCallback<
    NotesWorkspaceActions["updateNodeDraft"]
  >(
    (nodeId, patch, field) => {
      if (!field || canEdit({ paneId: "primary", nodeId, field })) {
        actionsRef.current.updateNodeDraft(nodeId, patch, field);
      }
    },
    [canEdit]
  );
  Object.assign(primaryActionOverridesRef.current, {
    moveNodeAcrossPanes,
    applyPreparedSelectionBatchAcrossPanes,
    acknowledgeFocus: primaryAcknowledgeFocus,
    claimEditingFocus: primaryClaimEditingFocus,
    releaseEditingFocus: primaryReleaseEditingFocus,
    setOutlineCompositionActive: primarySetOutlineCompositionActive,
    markEditingFocus: primaryMarkEditingFocus,
    updateNodeDraft: primaryUpdateNodeDraft
  });
  const updateSecondarySelection = useCallback(
    (action: NotesSelectionAction): void => {
      const current = getPaneSession("secondary");
      dispatchPane("secondary", {
        type: "setSelection",
        selection: notesSelectionReducer(current.selection, action)
      });
    },
    [dispatchPane, getPaneSession]
  );
  const secondaryActions = useMemo<NotesWorkspaceActions>(
    () => ({
      ...actionsSlice.actions,
      moveNodeAcrossPanes,
      applyPreparedSelectionBatchAcrossPanes,
      claimEditingFocus: (nodeId, field) =>
        claimEditing("secondary", nodeId, field),
      releaseEditingFocus: (nodeId) => release("secondary", nodeId),
      setOutlineCompositionActive: (active) =>
        setPaneComposition("secondary", active),
      updateNodeDraft: (nodeId, patch, field) => {
        if (
          !field ||
          canEdit({ paneId: "secondary", nodeId, field })
        ) {
          actionsSlice.actions.updateNodeDraft(nodeId, patch, field);
        }
      },
      acknowledgeFocus: async (nodeId, requestId) => {
        const current = getPaneSession("secondary");
        const pendingSelection = current.pendingPrimarySelection;
        const expectedRequestId = requestId ?? pendingSelection?.requestId;
        const requestIsCurrent = () => {
          const live = getPaneSession("secondary");
          if (pendingSelection === null) {
            return (
              live.pendingPrimarySelection === null &&
              live.pendingFocusId === nodeId
            );
          }
          return (
            pendingSelection.nodeId === nodeId &&
            pendingSelection.requestId === expectedRequestId &&
            live.pendingPrimarySelection?.nodeId === nodeId &&
            live.pendingPrimarySelection?.requestId === expectedRequestId &&
            (pendingSelection.expectedUserInteractionRevision === undefined ||
              pendingSelection.expectedUserInteractionRevision ===
                actionsSlice.actions.getUserInteractionRevision?.())
          );
        };
        if (
          !(await claimEditing(
            "secondary",
            nodeId,
            current.pendingFocusField ?? "title",
            requestIsCurrent
          ))
        ) {
          const failed = getPaneSession("secondary");
          if (
            pendingSelection !== null &&
            failed.pendingPrimarySelection?.nodeId === nodeId &&
            failed.pendingPrimarySelection.requestId ===
              expectedRequestId
          ) {
            dispatchPane("secondary", {
              type: "setPendingPrimarySelection",
              request: null
            });
            if (failed.pendingFocusId === nodeId) {
              dispatchPane("secondary", {
                type: "setNavigation",
                patch: { pendingFocusId: null, pendingFocusField: null }
              });
            }
          }
          return;
        }
        await actionsSlice.actions.acknowledgeFocus(
          nodeId,
          expectedRequestId
        );
        dispatchPane("secondary", {
          type: "setPendingPrimarySelection",
          request: null
        });
        dispatchPane("secondary", {
          type: "setNavigation",
          patch: {
            pendingFocusId: null,
            pendingFocusField: null,
            editingNoteId: nodeId,
            selectedId: nodeId
          }
        });
      },
      focusNode: async (nodeId, primarySelection) => {
        const current = getPaneSession("secondary");
        setActivePaneId("secondary");
        dispatchPane("secondary", {
          type: "setPendingPrimarySelection",
          request: primarySelection
            ? {
                requestId:
                  (current.pendingPrimarySelection?.requestId ?? 0) + 1,
                nodeId,
                field: "title",
                selection: { ...primarySelection }
              }
            : null
        });
        dispatchPane("secondary", {
          type: "setNavigation",
          patch: {
            selectedId: nodeId,
            editingNoteId: nodeId,
            pendingFocusId: nodeId,
            pendingFocusField: "title"
          }
        });
      },
      markEditingFocus: (nodeId, field) => {
        if (!canEdit({ paneId: "secondary", nodeId, field })) {
          return;
        }
        setActivePaneId("secondary");
        dispatchPane("secondary", {
          type: "setNavigation",
          patch: {
            selectedId: nodeId,
            editingNoteId: nodeId,
            pendingFocusField: field
          }
        });
      },
      getNavigationVersion: () =>
        getPaneSession("secondary").navigationVersion,
      zoomTo: async (nodeId) => {
        if (nodeId !== null && state.nodesById[nodeId] === undefined) return;
        await navigateWithHistory(
          async ({ workspace, snapshot }) => {
            const destination = cloneOwnedHistorySnapshot(snapshot);
            return {
              workspace,
              snapshot: {
                ...destination,
                activePaneId: "secondary",
                secondaryPane: {
                  ...destination.secondaryPane!,
                  selectedId: nodeId,
                  zoomRootId: nodeId,
                  focus: null
                }
              }
            };
          },
          undefined,
          "secondary"
        );
      },
      setSelectionAnchor: (anchorId) =>
        updateSecondarySelection({
          type: "setSelectionAnchor",
          anchorId
        }),
      extendSelectionTo: (headId) =>
        updateSecondarySelection({ type: "extendSelectionTo", headId }),
      toggleSelectionNode: (nodeId, visibleNodeIds) =>
        updateSecondarySelection({
          type: "toggleSelectionNode",
          nodeId,
          visibleNodeIds
        }),
      clearSelection: () =>
        updateSecondarySelection({ type: "clearSelection" }),
      replaceSelection: (nextSelection, expectedRevision) => {
        const current = getPaneSession("secondary");
        if (
          expectedRevision !== undefined &&
          expectedRevision !== current.selectionRevision
        ) {
          return false;
        }
        updateSecondarySelection({
          type: "replaceSelection",
          selection: nextSelection
        });
        return true;
      },
      getSelectionSnapshot: () => {
        const current = getPaneSession("secondary");
        return {
          selection: current.selection,
          revision: current.selectionRevision
        };
      }
    }),
    [
      actionsSlice.actions,
      applyPreparedSelectionBatchAcrossPanes,
      canEdit,
      claimEditing,
      dispatchPane,
      getPaneSession,
      navigateWithHistory,
      setPaneComposition,
      setActivePaneId,
      state.nodesById,
      updateSecondarySelection,
      moveNodeAcrossPanes,
      release
    ]
  );
  const secondaryPane = panes.secondary;
  const secondaryState = useMemo<NormalizedNotesWorkspace>(
    () => ({
      nodesById: state.nodesById,
      childIdsByParent: state.childIdsByParent,
      rootIds: state.rootIds,
      attachmentsByNodeId: state.attachmentsByNodeId,
      selectedId: secondaryPane.selectedId,
      zoomRootId: secondaryPane.zoomRootId,
      editingNoteId: secondaryPane.editingNoteId,
      pendingFocusId: secondaryPane.pendingFocusId,
      pendingFocusField: secondaryPane.pendingFocusField,
      status: state.status,
      error: state.error
    }),
    [
      secondaryPane.editingNoteId,
      secondaryPane.pendingFocusField,
      secondaryPane.pendingFocusId,
      secondaryPane.selectedId,
      secondaryPane.zoomRootId,
      state.attachmentsByNodeId,
      state.childIdsByParent,
      state.error,
      state.nodesById,
      state.rootIds,
      state.status
    ]
  );
  const secondaryStateSlice = useMemo<NotesStateSlice>(
    () => ({
      state: secondaryState,
      deletingNotesData: stateSlice.deletingNotesData,
      libraryView: stateSlice.libraryView,
      activeTagFilters: stateSlice.activeTagFilters,
      tagSummaries: stateSlice.tagSummaries,
      locallyExpandedNodeIds: secondaryPane.locallyExpandedNodeIds,
      status: stateSlice.status,
      loading: stateSlice.loading,
      error: stateSlice.error,
      canUndo: stateSlice.canUndo,
      canRedo: stateSlice.canRedo,
      authorityRecovery: stateSlice.authorityRecovery,
      retryAuthorityRecovery: stateSlice.retryAuthorityRecovery,
      pendingPrimarySelection: secondaryPane.pendingPrimarySelection
    }),
    [
      secondaryPane.locallyExpandedNodeIds,
      secondaryPane.pendingPrimarySelection,
      secondaryState,
      stateSlice.activeTagFilters,
      stateSlice.authorityRecovery,
      stateSlice.canRedo,
      stateSlice.canUndo,
      stateSlice.deletingNotesData,
      stateSlice.error,
      stateSlice.libraryView,
      stateSlice.loading,
      stateSlice.retryAuthorityRecovery,
      stateSlice.status,
      stateSlice.tagSummaries
    ]
  );
  const primaryOptimisticKeyboardInsertions = useMemo(
    () => {
      const owned =
        draftsSlice.optimisticKeyboardInsertions?.filter(
          (insertion) => insertion.pending.ownerPaneId === "primary"
        ) ?? EMPTY_OPTIMISTIC_KEYBOARD_INSERTIONS;
      return owned.length === 0
        ? EMPTY_OPTIMISTIC_KEYBOARD_INSERTIONS
        : owned;
    },
    [draftsSlice.optimisticKeyboardInsertions]
  );
  const secondaryOptimisticKeyboardInsertions = useMemo(
    () => {
      const owned =
        draftsSlice.optimisticKeyboardInsertions?.filter(
          (insertion) => insertion.pending.ownerPaneId === "secondary"
        ) ?? EMPTY_OPTIMISTIC_KEYBOARD_INSERTIONS;
      return owned.length === 0
        ? EMPTY_OPTIMISTIC_KEYBOARD_INSERTIONS
        : owned;
    },
    [draftsSlice.optimisticKeyboardInsertions]
  );
  const primaryOptimisticInsertionFailure =
    draftsSlice.optimisticInsertionFailure?.insertion.pending.ownerPaneId ===
    "primary"
      ? draftsSlice.optimisticInsertionFailure
      : null;
  const secondaryOptimisticInsertionFailure =
    draftsSlice.optimisticInsertionFailure?.insertion.pending.ownerPaneId ===
    "secondary"
      ? draftsSlice.optimisticInsertionFailure
      : null;
  const optimisticBackspaceGesture =
    draftsSlice.optimisticBackspaceGesture ?? null;
  const primaryDraftsSlice = useMemo<NotesDraftsSlice>(
    () => ({
      draftsByNodeId: draftsSlice.draftsByNodeId,
      writeError: draftsSlice.writeError,
      optimisticBackspaceGesture,
      optimisticKeyboardInsertions: primaryOptimisticKeyboardInsertions,
      optimisticInsertionFailure: primaryOptimisticInsertionFailure,
      attachmentUploadErrorsByNodeId:
        draftsSlice.attachmentUploadErrorsByNodeId,
      attachmentUploadRetryAttemptIdsByNodeId:
        draftsSlice.attachmentUploadRetryAttemptIdsByNodeId,
      selection: primary.selection,
      selectionRevision: primary.selectionRevision
    }),
    [
      draftsSlice.attachmentUploadErrorsByNodeId,
      draftsSlice.attachmentUploadRetryAttemptIdsByNodeId,
      draftsSlice.draftsByNodeId,
      draftsSlice.writeError,
      primary.selection,
      primary.selectionRevision,
      optimisticBackspaceGesture,
      primaryOptimisticInsertionFailure,
      primaryOptimisticKeyboardInsertions
    ]
  );
  const secondaryDraftsSlice = useMemo<NotesDraftsSlice>(
    () => ({
      draftsByNodeId: draftsSlice.draftsByNodeId,
      writeError: draftsSlice.writeError,
      optimisticBackspaceGesture,
      optimisticKeyboardInsertions: secondaryOptimisticKeyboardInsertions,
      optimisticInsertionFailure: secondaryOptimisticInsertionFailure,
      attachmentUploadErrorsByNodeId:
        draftsSlice.attachmentUploadErrorsByNodeId,
      attachmentUploadRetryAttemptIdsByNodeId:
        draftsSlice.attachmentUploadRetryAttemptIdsByNodeId,
      selection: secondaryPane.selection,
      selectionRevision: secondaryPane.selectionRevision
    }),
    [
      draftsSlice.attachmentUploadErrorsByNodeId,
      draftsSlice.attachmentUploadRetryAttemptIdsByNodeId,
      draftsSlice.draftsByNodeId,
      draftsSlice.writeError,
      optimisticBackspaceGesture,
      secondaryOptimisticInsertionFailure,
      secondaryOptimisticKeyboardInsertions,
      secondaryPane.selection,
      secondaryPane.selectionRevision
    ]
  );
  const secondaryActionsSlice = useMemo<NotesActionsSlice>(
    () => ({ ...actionsSlice, actions: secondaryActions }),
    [actionsSlice, secondaryActions]
  );
  const primaryPaneSession = useMemo<NotesPaneSessionState>(
    () => ({
      ...panes.primary,
      selectedId: state.selectedId,
      zoomRootId: state.zoomRootId,
      editingNoteId: state.editingNoteId,
      pendingFocusId: state.pendingFocusId,
      pendingFocusField: state.pendingFocusField,
      pendingPrimarySelection: primary.pendingPrimarySelection,
      locallyExpandedNodeIds: primary.locallyExpandedNodeIds,
      selection: primary.selection,
      selectionRevision: primary.selectionRevision,
      navigationVersion: primary.navigationVersion
    }),
    [panes.primary, primary, state]
  );
  const paneSessionRef = useRef({
    primary: primaryPaneSession,
    secondary: panes.secondary
  });
  paneSessionRef.current = {
    primary: primaryPaneSession,
    secondary: panes.secondary
  };
  const primaryPaneSlice = useMemo<NotesPaneRuntimeSlice>(
    () => ({
      paneId: "primary",
      stateSlice,
      draftsSlice: primaryDraftsSlice,
      actionsSlice: primaryActionsSlice
    }),
    [primaryActionsSlice, primaryDraftsSlice, stateSlice]
  );
  const secondaryPaneSlice = useMemo<NotesPaneRuntimeSlice>(
    () => ({
      paneId: "secondary",
      stateSlice: secondaryStateSlice,
      draftsSlice: secondaryDraftsSlice,
      actionsSlice: secondaryActionsSlice
    }),
    [secondaryActionsSlice, secondaryDraftsSlice, secondaryStateSlice]
  );
  return useMemo(
    () => ({
      activePaneId,
      panes: {
        primary: primaryPaneSlice,
        secondary: secondaryPaneSlice
      },
      setActivePaneId,
      getPaneSession: (paneId) => paneSessionRef.current[paneId],
      dispatchPane
    }),
    [
      activePaneId,
      dispatchPane,
      primaryPaneSlice,
      secondaryPaneSlice,
      setActivePaneId
    ]
  );
}
