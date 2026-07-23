import { useCallback } from "react";
import type {
  GithubNotificationSnapshotInput,
  MaterializeGithubNotificationIntent,
  ImageAtomEdit,
  LogicalSelection,
  MoveNoteNodeInput,
  NoteId,
  NoteImportNode,
  NoteNode,
  NotesStore,
  NotesStoreError
} from "../../domain/notes";
import {
  notesDataDeletionParticipants,
  releaseNotesDataDeletion,
  reserveNotesDataDeletion
} from "./notesDataDeletionRegistry";
import type { NotesWorkspaceCoordinatorSession } from "./notesWorkspaceCoordinator";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import type { ParsedImageAtomPaste } from "./notesImageAtomClipboard";
import {
  applyBatchCommand,
  applyImageAtomEditCommand,
  applyImageAtomPasteCommand,
  createChildCommand,
  createNextTextSiblingCommand,
  createRootCommand,
  deleteNodeCommand,
  deleteNodesCommand,
  duplicateNodeCommand,
  emptyTrashCommand,
  importSubtreeCommand,
  materializeGithubNotificationCommand,
  moveNodeCommand,
  refreshMaterializedGithubNotificationsCommand,
  removeEmptyNodeCommand,
  restoreNodeCommand,
  setGithubGroupCollapsedCommand,
  runAtomicSubtreeCommand,
  setReadonlyCommand,
  runRootLifecycle,
  splitNodeCommand,
  toggleCollapsedCommand,
  toggleCompleteCommand,
  toggleStarCommand,
  updateNodeCommand,
  type NotesBatchOp,
  type NotesChildPlacement,
  type NotesCommandContext
} from "./notesCommands";
import { authoritative } from "./notesWorkspaceProjection";
import {
  errorMessage
} from "./notesWorkspaceNavigationSupport";
import { focusedUiUpdate } from "./notesWorkspaceCommandSupport";
import type {
  NotesDeleteAllOptions,
  NotesDeleteAllResult,
  NotesImageAtomCutAuthority,
  NotesImageAtomPasteAuthority,
  NotesPreparedSelectionAuthority,
  NotesWorkspaceCompoundOptions
} from "./notesWorkspaceTypes";
import type { NotesLibraryStateController } from "./useNotesLibraryController";

interface LiveRef<T> {
  current: T;
}

interface NotesCommandActionsDependencies {
  readonly commandCtx: NotesCommandContext;
  readonly repository: NotesStore;
  readonly vaultRoot: string;
  readonly sessionRecordRef: LiveRef<NotesWorkspaceSessionRecord | null>;
  readonly sessionRef: LiveRef<NotesWorkspaceCoordinatorSession | null>;
  readonly activeScopeRef: NotesLibraryStateController["activeScopeRef"];
  readonly setLibraryView: NotesLibraryStateController["setLibraryView"];
  readonly setTagSummaries: NotesLibraryStateController["setTagSummaries"];
  readonly resetTagFilterTracking: NotesLibraryStateController["resetTagFilterTracking"];
  readonly replaceLocalExpansions: (nodeIds: ReadonlySet<NoteId>) => void;
  readonly purgeAttachmentUploadAttemptsAfterDataDeletion: () => void;
  readonly createDraftFlushFailedError: (
    cause: NotesStoreError | null
  ) => Error;
}

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

export function useNotesCommandActions({
  commandCtx,
  repository,
  vaultRoot,
  sessionRecordRef,
  sessionRef,
  activeScopeRef,
  setLibraryView,
  setTagSummaries,
  resetTagFilterTracking,
  replaceLocalExpansions,
  purgeAttachmentUploadAttemptsAfterDataDeletion,
  createDraftFlushFailedError
}: NotesCommandActionsDependencies) {
  const createRoot = useCallback(
    () => createRootCommand(commandCtx),
    [commandCtx]
  );
  const createChild = useCallback(
    (nodeId: NoteId, placement?: NotesChildPlacement) =>
      createChildCommand(commandCtx, nodeId, placement),
    [commandCtx]
  );
  const createNextTextSibling = useCallback(
    (nodeId: NoteId) => createNextTextSiblingCommand(commandCtx, nodeId),
    [commandCtx]
  );
  const materializeGithubNotification = useCallback(
    (
      snapshot: GithubNotificationSnapshotInput,
      target: MaterializeGithubNotificationIntent
    ) =>
      materializeGithubNotificationCommand(
        commandCtx,
        snapshot,
        target
      ),
    [commandCtx]
  );
  const refreshMaterializedGithubNotifications = useCallback(
    (notifications: readonly GithubNotificationSnapshotInput[]) =>
      refreshMaterializedGithubNotificationsCommand(commandCtx, notifications),
    [commandCtx]
  );
  const setGithubGroupCollapsed = useCallback(
    (groupKey: string, collapsed: boolean) =>
      setGithubGroupCollapsedCommand(commandCtx, groupKey, collapsed),
    [commandCtx]
  );
  const splitNode = useCallback(
    (
      nodeId: NoteId,
      newNodeId: NoteId,
      prefix: string,
      suffix: string,
      options?: NotesWorkspaceCompoundOptions
    ) => splitNodeCommand(commandCtx, nodeId, newNodeId, prefix, suffix, options),
    [commandCtx]
  );
  const updateNode = useCallback(
    (nodeId: NoteId, patch: Pick<NoteNode, "title" | "note">) =>
      updateNodeCommand(commandCtx, nodeId, patch),
    [commandCtx]
  );
  const setReadonly = useCallback(
    (nodeId: NoteId, isReadonly: boolean) =>
      setReadonlyCommand(commandCtx, nodeId, isReadonly),
    [commandCtx]
  );
  const applyImageAtomEdit = useCallback(
    (nodeId: NoteId, selection: LogicalSelection, edit: ImageAtomEdit) =>
      applyImageAtomEditCommand(commandCtx, nodeId, selection, edit),
    [commandCtx]
  );
  const applyImageAtomCutWithAuthority = useCallback(
    (
      authority: NotesImageAtomCutAuthority,
      nodeId: NoteId,
      selection: LogicalSelection
    ) =>
      applyImageAtomEditCommand(
        commandCtx,
        nodeId,
        selection,
        { kind: "remove", replacementText: "" },
        authority
      ),
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
  const deleteNodes = useCallback(
    (
      nodeIds: readonly NoteId[],
      expectedReadonlyDescendantIds?: readonly NoteId[],
      prepared?: NotesPreparedSelectionAuthority
    ) =>
      deleteNodesCommand(
        commandCtx,
        nodeIds,
        expectedReadonlyDescendantIds,
        prepared
      ),
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
  const deleteAllNotesData = useCallback(
    async (options?: NotesDeleteAllOptions): Promise<NotesDeleteAllResult> => {
      const record = sessionRecordRef.current;
      if (!record || record.closing || sessionRef.current !== record.session) {
        throw new Error("The Notes workspace is unavailable.");
      }
      const deletionToken = {};
      if (!reserveNotesDataDeletion(repository, vaultRoot, deletionToken)) {
        throw new Error("Notes data deletion is already in progress.");
      }
      const discardDrafts = options?.discardDrafts === true;
      const participants = notesDataDeletionParticipants(repository, vaultRoot);
      try {
        if (discardDrafts) {
          for (const participant of participants) {
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
                hasAttachmentCleanupFlag(outcome) && outcome.attachmentCleanupFailed;
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
          { retainAfterClose: true, requireAllBarriers: !discardDrafts }
        );
        if (deletionError) throw deletionError;
        if (!deleted) {
          const failedParticipant = participants.find(
            (participant) =>
              participant.record.writeError !== null ||
              participant.record.drafts.size > 0
          );
          if (!discardDrafts && failedParticipant) {
            throw createDraftFlushFailedError(failedParticipant.record.writeError);
          }
          throw new Error("Notes data deletion did not complete.");
        }
        purgeAttachmentUploadAttemptsAfterDataDeletion();
        const resetParticipants = new Set([
          ...participants,
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
      activeScopeRef,
      createDraftFlushFailedError,
      purgeAttachmentUploadAttemptsAfterDataDeletion,
      replaceLocalExpansions,
      repository,
      resetTagFilterTracking,
      sessionRecordRef,
      sessionRef,
      setLibraryView,
      setTagSummaries,
      vaultRoot
    ]
  );

  return {
    createRoot,
    createChild,
    createNextTextSibling,
    materializeGithubNotification,
    refreshMaterializedGithubNotifications:
      repository.refreshMaterializedGithubNotifications === undefined
        ? undefined
        : refreshMaterializedGithubNotifications,
    setGithubGroupCollapsed:
      repository.setGithubGroupCollapsed === undefined
        ? undefined
        : setGithubGroupCollapsed,
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
    removeEmptyNode,
    deleteNode,
    deleteNodes: repository.deleteNodes === undefined ? undefined : deleteNodes,
    restoreNode,
    emptyTrash,
    deleteAllNotesData
  };
}
