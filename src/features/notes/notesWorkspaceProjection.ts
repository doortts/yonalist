import { isNotesMutationResult } from "../../domain/notes";
import type {
  NoteAttachment,
  NoteId,
  NoteNode,
  NotesHistoryStatus,
  NotesMutationResponse,
  NotesWorkspace
} from "../../domain/notes";
import type {
  NotesWorkspaceQueueResult,
  NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import type { NotesWorkspaceDelta } from "./notesWorkspaceReducer";

export function authoritative(
  workspace: NotesWorkspace,
  uiUpdate?: NotesWorkspaceUiUpdate,
  historyStatus?: NotesHistoryStatus,
  options?: Pick<
    Extract<NotesWorkspaceQueueResult, { kind: "authoritative" }>,
    | "scopeAgnostic"
    | "committedHistoryEntryIds"
    | "projectionScope"
    | "projectionLocallyExpandedNodeIds"
    | "invalidatesTagSummaries"
    | "tagSummaries"
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

/** Full-database audit delta returned with an atomic mutation. */
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
  importedRootIds: readonly NoteId[] | undefined;
  duplicatedRootIds: readonly NoteId[] | undefined;
}

export function unwrapNotesMutation(
  response: NotesMutationResponse
): UnwrappedNotesMutation {
  if (isNotesMutationResult(response)) {
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
        canRedo: response.canRedo,
        historyEpoch: response.historyEpoch,
        nextUndoEntryId: response.nextUndoEntryId,
        nextRedoEntryId: response.nextRedoEntryId,
        prunedEntryIds: response.prunedEntryIds
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
