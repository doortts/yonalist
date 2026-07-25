import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { VaultRootContext } from "../../VaultRootContext";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import type { NoteId } from "../../domain/notes";
import { notesStore, notesSyncFlush } from "../../services/notesStore";
import type { FeaturePanes, FeatureRuntime } from "../core/featureTypes";
import type {
  NotesBatchCommandSettlement,
  NotesBatchOp,
} from "./notesCommands";
import type {
  NotesPreparedSelectionAuthority,
  NotesPreparedSelectionBatchOptions,
} from "./notesWorkspaceTypes";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesDetailSplitHost } from "./NotesDetailSplitHost";
import {
  NotesAttachmentUiContext,
  useNotesAttachmentUi,
} from "./NotesAttachmentUiContext";
import { NotesImageResidencyProvider } from "./NotesImageResidencyContext";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesPaneRegistryContext,
  NotesStateContext,
} from "./NotesWorkspaceContext";
import { useNotesFeedback } from "./NotesFeedbackContext";
import {
  nativeNotesAttachmentUi,
  type NotesAttachmentUiBoundary,
} from "./notesAttachmentController";
import { useFlushDraftsOnWindowClose } from "./useFlushDraftsOnWindowClose";
import {
  drainNotesVault,
  registerNotesVaultDrain,
} from "./notesVaultDrain";
import { useNotesWorkspace } from "./useNotesWorkspace";
import "./notes.css";

interface NotesWorkspaceProviderProps extends PropsWithChildren {
  attachmentUi?: NotesAttachmentUiBoundary;
}

function preparedSelectionForestRootIds(
  prepared: NotesPreparedSelectionAuthority,
): readonly NoteId[] {
  const selected = new Set(prepared.selectedNodeIds);
  return prepared.selectedNodeIds.filter((nodeId) => {
    const visited = new Set<NoteId>([nodeId]);
    let parentId = prepared.workspace.nodesById[nodeId]?.parentId ?? null;
    while (parentId !== null && !visited.has(parentId)) {
      if (selected.has(parentId)) return false;
      visited.add(parentId);
      parentId = prepared.workspace.nodesById[parentId]?.parentId ?? null;
    }
    return true;
  });
}

export function NotesWorkspaceProvider({
  children,
  attachmentUi,
}: NotesWorkspaceProviderProps) {
  const vaultRoot = useContext(VaultRootContext);
  const contextAttachmentUi = useNotesAttachmentUi();
  const { publish } = useNotesFeedback();
  const workspace = useNotesWorkspace({
    vaultRoot,
    repository: notesStore,
    attachmentUi: attachmentUi ?? contextAttachmentUi,
    publishFeedback: publish,
  });
  const { actions, actionsSlice } = workspace;
  const [pendingReadonlyDelete, setPendingReadonlyDelete] = useState<{
    nodeIds: readonly NoteId[];
    readonlyDescendantIds: readonly NoteId[];
    prepared?: NotesPreparedSelectionAuthority;
    options?: NotesPreparedSelectionBatchOptions;
  } | null>(null);
  useEffect(() => setPendingReadonlyDelete(null), [vaultRoot]);
  const requestDeleteNodes = useCallback(
    async (
      nodeIds: readonly NoteId[],
      expectedReadonlyDescendantIds?: readonly NoteId[],
      prepared?: NotesPreparedSelectionAuthority,
      options?: NotesPreparedSelectionBatchOptions,
    ) => {
      const result = await actions.deleteNodes(
        nodeIds,
        expectedReadonlyDescendantIds,
        prepared,
        options,
      );
      if (result.kind === "confirmationRequired") {
        setPendingReadonlyDelete({
          nodeIds: Object.freeze([...nodeIds]),
          readonlyDescendantIds: Object.freeze([
            ...result.readonlyDescendantIds,
          ]),
          ...(prepared ? { prepared } : {}),
          ...(options ? { options } : {}),
        });
        return result;
      }
      setPendingReadonlyDelete(null);
      return result;
    },
    [actions],
  );
  const requestDeleteOutcome = useCallback(
    async (
      nodeIds: readonly NoteId[],
      expectedReadonlyDescendantIds?: readonly NoteId[],
      prepared?: NotesPreparedSelectionAuthority,
      options?: NotesPreparedSelectionBatchOptions,
    ) => {
      const result = await requestDeleteNodes(
        nodeIds,
        expectedReadonlyDescendantIds,
        prepared,
        options,
      );
      return result.kind === "settled" ? result.outcome : ("skipped" as const);
    },
    [requestDeleteNodes],
  );
  const sharedActions = useMemo(
    () => ({
      ...actions,
      deleteNode: (nodeId: NoteId) => requestDeleteOutcome([nodeId]),
      applyBatch: (
        nodeIds: readonly NoteId[],
        op: Parameters<typeof actions.applyBatch>[1],
        options?: Parameters<typeof actions.applyBatch>[2],
      ) =>
        op.type === "delete"
          ? requestDeleteOutcome(nodeIds, undefined, undefined, options)
          : actions.applyBatch(nodeIds, op, options),
    }),
    [actions, requestDeleteOutcome],
  );
  const sharedActionsSlice = useMemo(() => {
    const applyPreparedSelectionBatch =
      actionsSlice.applyPreparedSelectionBatch;
    return {
      ...actionsSlice,
      actions: sharedActions,
      applyPreparedSelectionBatch:
        applyPreparedSelectionBatch === undefined
          ? undefined
          : async (
              prepared: NotesPreparedSelectionAuthority,
              op: NotesBatchOp,
              options?: NotesPreparedSelectionBatchOptions,
            ): Promise<NotesBatchCommandSettlement> => {
              if (op.type !== "delete") {
                return applyPreparedSelectionBatch(prepared, op, options);
              }
              const result = await requestDeleteNodes(
                preparedSelectionForestRootIds(prepared),
                undefined,
                prepared,
                options,
              );
              if (result.kind === "confirmationRequired") {
                return {
                  outcome: "skipped",
                  mutationCommitted: false,
                  navigationOwned: false,
                };
              }
              return {
                outcome: result.outcome,
                mutationCommitted: result.mutationCommitted,
                ...(result.navigationOwned === undefined
                  ? {}
                  : { navigationOwned: result.navigationOwned }),
                ...(result.projectedWorkspace === undefined
                  ? {}
                  : { projectedWorkspace: result.projectedWorkspace }),
              };
            },
    };
  }, [actionsSlice, requestDeleteNodes, sharedActions]);

  const notesWorkspaceDrain = actions.drain;
  useEffect(() => {
    if (!vaultRoot) return;
    return registerNotesVaultDrain(vaultRoot, {
      drain: () => notesWorkspaceDrain?.() ?? Promise.resolve(false),
    });
  }, [notesWorkspaceDrain, vaultRoot]);

  useFlushDraftsOnWindowClose(
    () => (vaultRoot ? drainNotesVault(vaultRoot) : Promise.resolve(true)),
    vaultRoot ? () => notesSyncFlush(vaultRoot) : undefined,
  );

  return (
    <NotesPaneRegistryContext.Provider value={workspace.paneRegistrySlice}>
      <NotesActionsContext.Provider value={sharedActionsSlice}>
        <NotesStateContext.Provider value={workspace.stateSlice}>
          <NotesDraftsContext.Provider value={workspace.draftsSlice}>
            {children}
            <ConfirmDialog
              open={pendingReadonlyDelete !== null}
              onOpenChange={(open) => {
                if (!open) setPendingReadonlyDelete(null);
              }}
              title="읽기 전용 블릿이 포함되어 있습니다. 함께 삭제할까요?"
              description={
                pendingReadonlyDelete === null
                  ? ""
                  : `${pendingReadonlyDelete.readonlyDescendantIds.length}개의 읽기 전용 블릿이 포함되어 있습니다.`
              }
              confirmLabel="삭제"
              cancelLabel="취소"
              danger
              onConfirm={() => {
                const pending = pendingReadonlyDelete;
                if (!pending) return;
                void requestDeleteNodes(
                  pending.nodeIds,
                  pending.readonlyDescendantIds,
                  pending.prepared,
                  pending.options,
                );
              }}
            />
          </NotesDraftsContext.Provider>
        </NotesStateContext.Provider>
      </NotesActionsContext.Provider>
    </NotesPaneRegistryContext.Provider>
  );
}

export function NotesFeatureProvider({
  children,
  attachmentUi,
}: NotesWorkspaceProviderProps) {
  const vaultRoot = useContext(VaultRootContext);
  const resolvedAttachmentUi = attachmentUi ?? nativeNotesAttachmentUi;
  return (
    <NotesAttachmentUiContext.Provider value={resolvedAttachmentUi}>
      <NotesImageResidencyProvider scopeKey={vaultRoot}>
        <NotesWorkspaceProvider>{children}</NotesWorkspaceProvider>
      </NotesImageResidencyProvider>
    </NotesAttachmentUiContext.Provider>
  );
}

// The Notes panes take no props and never read App state, so build the
// FeaturePanes object — and the pane element mount points inside it — once and
// reuse the same references on every render. App calls `renderPanes()` in its
// render body, so returning stable references lets React bail out of the Notes
// subtree when an App-only state change (notification polling, status metrics,
// online toggles) re-renders the shell. This mirrors main's 0c19b5d pane
// memoization at the feature-pane layer. Inbox/Settings deliberately rebuild
// their panes each render so selection/list props keep flowing; their leaf
// panes are React.memo'd instead.
const notesPanes: FeaturePanes = {
  middle: <NotesLibraryPane />,
  detail: <NotesDetailSplitHost />,
};

export const notesFeatureRuntime: FeatureRuntime = {
  Provider: NotesFeatureProvider,
  renderPanes: () => notesPanes,
};
