import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren
} from "react";
import { VaultRootContext } from "../../VaultRootContext";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import type { NoteId } from "../../domain/notes";
import { notesStore, notesSyncFlush } from "../../services/notesStore";
import type { FeaturePanes, FeatureRuntime } from "../core/featureTypes";
import { NotesDetailPane } from "./NotesDetailPane";
import { NotesLibraryPane } from "./NotesLibraryPane";
import {
  NotesAttachmentUiContext,
  useNotesAttachmentUi
} from "./NotesAttachmentUiContext";
import { NotesImageResidencyProvider } from "./NotesImageResidencyContext";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesStateContext
} from "./NotesWorkspaceContext";
import { useNotesFeedback } from "./NotesFeedbackContext";
import {
  nativeNotesAttachmentUi,
  type NotesAttachmentUiBoundary
} from "./notesAttachmentController";
import type { NotesPreparedSelectionAuthority } from "./notesWorkspaceTypes";
import { useFlushDraftsOnWindowClose } from "./useFlushDraftsOnWindowClose";
import { useNotesWorkspace } from "./useNotesWorkspace";
import "./notes.css";

interface NotesWorkspaceProviderProps extends PropsWithChildren {
  attachmentUi?: NotesAttachmentUiBoundary;
}

function preparedDeleteForestRootIds(
  prepared: NotesPreparedSelectionAuthority
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
  attachmentUi
}: NotesWorkspaceProviderProps) {
  const vaultRoot = useContext(VaultRootContext);
  const contextAttachmentUi = useNotesAttachmentUi();
  const { publish } = useNotesFeedback();
  const workspace = useNotesWorkspace({
    vaultRoot,
    repository: notesStore,
    attachmentUi: attachmentUi ?? contextAttachmentUi,
    publishFeedback: publish
  });
  const { actions, actionsSlice } = workspace;
  const [pendingReadonlyDelete, setPendingReadonlyDelete] = useState<{
    nodeIds: readonly NoteId[];
    readonlyDescendantIds: readonly NoteId[];
  } | null>(null);
  useEffect(() => setPendingReadonlyDelete(null), [vaultRoot]);
  const requestDeleteNodes = useCallback(
    async (
      nodeIds: readonly NoteId[],
      expectedReadonlyDescendantIds?: readonly NoteId[],
      prepared?: NotesPreparedSelectionAuthority
    ) => {
      const result = actions.deleteNodes
        ? await actions.deleteNodes(
            nodeIds,
            expectedReadonlyDescendantIds,
            prepared
          )
        : {
            kind: "settled" as const,
            outcome:
              nodeIds.length === 1
                ? await actions.deleteNode(nodeIds[0])
                : "skipped" as const
          };
      if (result.kind === "confirmationRequired") {
        setPendingReadonlyDelete({
          nodeIds: Object.freeze([...nodeIds]),
          readonlyDescendantIds: Object.freeze([
            ...result.readonlyDescendantIds
          ])
        });
        return "skipped" as const;
      }
      setPendingReadonlyDelete(null);
      return result.outcome;
    },
    [actions]
  );
  const sharedActions = useMemo(
    () => ({
      ...actions,
      deleteNode:
        actions.deleteNodes === undefined
          ? actions.deleteNode
          : (nodeId: NoteId) => requestDeleteNodes([nodeId]),
      applyBatch: (
        nodeIds: readonly NoteId[],
        op: Parameters<typeof actions.applyBatch>[1],
        options?: Parameters<typeof actions.applyBatch>[2]
      ) =>
        op.type === "delete" && actions.deleteNodes !== undefined
          ? requestDeleteNodes(nodeIds)
          : actions.applyBatch(nodeIds, op, options)
    }),
    [actions, requestDeleteNodes]
  );
  const sharedActionsSlice = useMemo(
    () => ({
      ...actionsSlice,
      actions: sharedActions,
      applyPreparedSelectionBatch:
        actionsSlice.applyPreparedSelectionBatch === undefined
          ? undefined
          : async (
              prepared: Parameters<
                NonNullable<
                  typeof actionsSlice.applyPreparedSelectionBatch
                >
              >[0],
              op: Parameters<
                NonNullable<
                  typeof actionsSlice.applyPreparedSelectionBatch
                >
              >[1],
              options?: Parameters<
                NonNullable<
                  typeof actionsSlice.applyPreparedSelectionBatch
                >
              >[2]
            ) => {
              if (
                op.type !== "delete" ||
                actions.deleteNodes === undefined
              ) {
                return actionsSlice.applyPreparedSelectionBatch!(
                  prepared,
                  op,
                  options
                );
              }
              const outcome = await requestDeleteNodes(
                preparedDeleteForestRootIds(prepared),
                undefined,
                prepared
              );
              return {
                outcome,
                mutationCommitted: outcome === "committed"
              };
            }
    }),
    [actions.deleteNodes, actionsSlice, requestDeleteNodes, sharedActions]
  );

  useFlushDraftsOnWindowClose(
    actions.flushAllDrafts,
    vaultRoot ? () => notesSyncFlush(vaultRoot) : undefined
  );

  return (
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
                pending.readonlyDescendantIds
              );
            }}
          />
        </NotesDraftsContext.Provider>
      </NotesStateContext.Provider>
    </NotesActionsContext.Provider>
  );
}

export function NotesFeatureProvider({
  children,
  attachmentUi
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
  detail: <NotesDetailPane />
};

export const notesFeatureRuntime: FeatureRuntime = {
  Provider: NotesFeatureProvider,
  renderPanes: () => notesPanes
};
