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
import type { NotesPaneSessionState } from "./notesPaneSession";
import type { NotesPaneSessionsController } from "./useNotesPaneSessions";
import type { NotesEditingLeaseController } from "./useNotesEditingLease";
import {
  cloneOwnedHistorySnapshot,
  type NavigationIntent
} from "./notesWorkspaceNavigationSupport";

interface UseNotesWorkspacePaneRegistryOptions {
  readonly sessions: NotesPaneSessionsController;
  readonly state: NormalizedNotesWorkspace;
  readonly stateSlice: NotesStateSlice;
  readonly draftsSlice: NotesDraftsSlice;
  readonly actionsSlice: NotesActionsSlice;
  readonly editingLease: NotesEditingLeaseController;
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
  const primaryBaseActionsRef = useRef(actionsSlice.actions);
  const primaryBaseActionsSliceRef = useRef(actionsSlice);
  if (activePaneId === "primary") {
    primaryBaseActionsRef.current = actionsSlice.actions;
    primaryBaseActionsSliceRef.current = actionsSlice;
  }
  const primaryBaseActions = primaryBaseActionsRef.current;
  const primaryBaseActionsSlice = primaryBaseActionsSliceRef.current;
  const primaryNavigationVersionRef = useRef(primary.navigationVersion);
  primaryNavigationVersionRef.current = primary.navigationVersion;
  const claimEditing = useCallback(
    async (
      paneId: "primary" | "secondary",
      nodeId: string,
      field: "title" | "note"
    ): Promise<boolean> => {
      const claimed = await claim(
        { paneId, nodeId, field },
        actionsRef.current.flushNodeDraft
      );
      if (!claimed) return false;
      setActivePaneId(paneId);
      if (paneId === "primary") {
        actionsRef.current.markEditingFocus?.(nodeId, field);
      } else {
        dispatchPane("secondary", {
          type: "setNavigation",
          patch: {
            selectedId: nodeId,
            editingNoteId: nodeId,
            pendingFocusField: field
          }
        });
      }
      return true;
    },
    [claim, dispatchPane, setActivePaneId]
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
  const primaryActions = useMemo<NotesWorkspaceActions>(
    () => ({
      ...primaryBaseActions,
      moveNodeAcrossPanes,
      applyPreparedSelectionBatchAcrossPanes,
      acknowledgeFocus: async (nodeId, requestId) => {
        if (
          await claimEditing(
            "primary",
            nodeId,
            state.pendingFocusField ?? "title"
          )
        ) {
          await primaryBaseActions.acknowledgeFocus(nodeId, requestId);
        }
      },
      claimEditingFocus: (nodeId, field) =>
        claimEditing("primary", nodeId, field),
      releaseEditingFocus: (nodeId) => release("primary", nodeId),
      setOutlineCompositionActive: (active) =>
        setPaneComposition("primary", active),
      markEditingFocus: (nodeId, field) => {
        if (canEdit({ paneId: "primary", nodeId, field })) {
          primaryBaseActions.markEditingFocus?.(nodeId, field);
        }
      },
      updateNodeDraft: (nodeId, patch, field) => {
        if (!field || canEdit({ paneId: "primary", nodeId, field })) {
          primaryBaseActions.updateNodeDraft(nodeId, patch, field);
        }
      }
    }),
    [
      applyPreparedSelectionBatchAcrossPanes,
      canEdit,
      claimEditing,
      primaryBaseActions,
      release,
      setPaneComposition,
      state.pendingFocusField,
      moveNodeAcrossPanes
    ]
  );
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
        if (
          !(await claimEditing(
            "secondary",
            nodeId,
            current.pendingFocusField ?? "title"
          ))
        ) {
          return;
        }
        if (
          current.pendingPrimarySelection !== null &&
          (current.pendingPrimarySelection.nodeId !== nodeId ||
            current.pendingPrimarySelection.requestId !== requestId)
        ) {
          return;
        }
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
      projectionPublication: stateSlice.projectionPublication,
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
      stateSlice.projectionPublication,
      stateSlice.retryAuthorityRecovery,
      stateSlice.status,
      stateSlice.tagSummaries
    ]
  );
  const secondaryDraftsSlice = useMemo<NotesDraftsSlice>(
    () => ({
      draftsByNodeId: draftsSlice.draftsByNodeId,
      writeError: draftsSlice.writeError,
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
      secondaryPane.selection,
      secondaryPane.selectionRevision
    ]
  );
  const secondaryActionsSlice = useMemo<NotesActionsSlice>(
    () => ({ ...actionsSlice, actions: secondaryActions }),
    [actionsSlice, secondaryActions]
  );
  const primaryActionsSlice = useMemo<NotesActionsSlice>(
    () => ({ ...primaryBaseActionsSlice, actions: primaryActions }),
    [primaryActions, primaryBaseActionsSlice]
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
      draftsSlice,
      actionsSlice: primaryActionsSlice
    }),
    [draftsSlice, primaryActionsSlice, stateSlice]
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
