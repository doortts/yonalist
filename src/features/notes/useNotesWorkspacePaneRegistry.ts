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
  const claimEditing = useCallback(
    async (
      paneId: "primary" | "secondary",
      nodeId: string,
      field: "title" | "note"
    ): Promise<boolean> => {
      const claimed = await editingLease.claim(
        { paneId, nodeId, field },
        actionsSlice.actions.flushNodeDraft
      );
      if (!claimed) return false;
      setActivePaneId(paneId);
      if (paneId === "primary") {
        actionsSlice.actions.markEditingFocus?.(nodeId, field);
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
    [actionsSlice.actions, dispatchPane, editingLease, setActivePaneId]
  );
  const setPaneComposition = useCallback(
    (paneId: "primary" | "secondary", active: boolean): void => {
      editingLease.setCompositionActive(paneId, active);
      actionsSlice.actions.setOutlineCompositionActive?.(
        !editingLease.structuralCommandsAllowed()
      );
    },
    [actionsSlice.actions, editingLease]
  );
  const settleCrossPaneMove = useCallback(
    (
      sourcePaneId: "primary" | "secondary",
      destinationPaneId: "primary" | "secondary",
      focusNodeId: string
    ): void => {
      if (sourcePaneId === "primary") {
        actionsSlice.actions.clearSelection?.();
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
    [actionsSlice.actions, dispatchPane, setActivePaneId]
  );
  const moveNodeAcrossPanes = useCallback<
    NonNullable<NotesWorkspaceActions["moveNodeAcrossPanes"]>
  >(
    (input, sourcePaneId, destinationPaneId, expandNodeId) =>
      actionsSlice.actions.moveNode(
        input,
        destinationPaneId === "primary" ? input.id : undefined,
        {
          ...(expandNodeId === undefined ? {} : { expandNodeId }),
          beforeHistoryCapture: () =>
            settleCrossPaneMove(sourcePaneId, destinationPaneId, input.id)
        }
      ),
    [actionsSlice.actions, settleCrossPaneMove]
  );
  const applyPreparedSelectionBatchAcrossPanes = useCallback<
    NonNullable<NotesWorkspaceActions["applyPreparedSelectionBatchAcrossPanes"]>
  >(
    async (prepared, op, sourcePaneId, destinationPaneId, expandNodeId) => {
      const focusNodeId = prepared.selectedNodeIds[0];
      const apply = actionsSlice.applyPreparedSelectionBatch;
      if (!focusNodeId || !apply) {
        return { outcome: "skipped", mutationCommitted: false };
      }
      return apply(prepared, op, {
        focusNodeId: destinationPaneId === "primary" ? focusNodeId : undefined,
        expectedNavigationVersion:
          getPaneSession(sourcePaneId).navigationVersion,
        ...(expandNodeId === undefined ? {} : { expandNodeId }),
        beforeHistoryCapture: () =>
          settleCrossPaneMove(sourcePaneId, destinationPaneId, focusNodeId)
      });
    },
    [
      actionsSlice.applyPreparedSelectionBatch,
      getPaneSession,
      settleCrossPaneMove
    ]
  );
  const primaryActions = useMemo<NotesWorkspaceActions>(
    () => ({
      ...actionsSlice.actions,
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
          await actionsSlice.actions.acknowledgeFocus(nodeId, requestId);
        }
      },
      claimEditingFocus: (nodeId, field) =>
        claimEditing("primary", nodeId, field),
      releaseEditingFocus: (nodeId) =>
        editingLease.release("primary", nodeId),
      setOutlineCompositionActive: (active) =>
        setPaneComposition("primary", active),
      markEditingFocus: (nodeId, field) => {
        if (editingLease.canEdit({ paneId: "primary", nodeId, field })) {
          actionsSlice.actions.markEditingFocus?.(nodeId, field);
        }
      },
      updateNodeDraft: (nodeId, patch, field) => {
        if (
          !field ||
          editingLease.canEdit({ paneId: "primary", nodeId, field })
        ) {
          actionsSlice.actions.updateNodeDraft(nodeId, patch, field);
        }
      }
    }),
    [
      actionsSlice.actions,
      applyPreparedSelectionBatchAcrossPanes,
      claimEditing,
      editingLease,
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
      releaseEditingFocus: (nodeId) =>
        editingLease.release("secondary", nodeId),
      setOutlineCompositionActive: (active) =>
        setPaneComposition("secondary", active),
      updateNodeDraft: (nodeId, patch, field) => {
        if (
          !field ||
          editingLease.canEdit({ paneId: "secondary", nodeId, field })
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
        if (!editingLease.canEdit({ paneId: "secondary", nodeId, field })) {
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
      claimEditing,
      dispatchPane,
      editingLease,
      getPaneSession,
      navigateWithHistory,
      setPaneComposition,
      setActivePaneId,
      state.nodesById,
      updateSecondarySelection,
      moveNodeAcrossPanes
    ]
  );
  const secondaryState = useMemo<NormalizedNotesWorkspace>(() => {
    const pane = panes.secondary;
    return {
      ...state,
      selectedId: pane.selectedId,
      zoomRootId: pane.zoomRootId,
      editingNoteId: pane.editingNoteId,
      pendingFocusId: pane.pendingFocusId,
      pendingFocusField: pane.pendingFocusField
    };
  }, [panes.secondary, state]);
  const secondaryStateSlice = useMemo<NotesStateSlice>(
    () => ({
      ...stateSlice,
      state: secondaryState,
      locallyExpandedNodeIds: panes.secondary.locallyExpandedNodeIds,
      pendingPrimarySelection: panes.secondary.pendingPrimarySelection
    }),
    [panes.secondary, secondaryState, stateSlice]
  );
  const secondaryDraftsSlice = useMemo<NotesDraftsSlice>(
    () => ({
      ...draftsSlice,
      selection: panes.secondary.selection,
      selectionRevision: panes.secondary.selectionRevision
    }),
    [draftsSlice, panes.secondary]
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
      draftsSlice,
      actionsSlice: {
        ...actionsSlice,
        actions: primaryActions
      }
    }),
    [actionsSlice, draftsSlice, primaryActions, stateSlice]
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
