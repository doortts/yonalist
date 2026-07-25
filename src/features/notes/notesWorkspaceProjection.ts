import { isNotesMutationResult } from "../../domain/notes";
import type {
  NoteAttachment,
  NoteId,
  NoteNode,
  NotesHistoryStatus,
  NotesMutationResponse,
  NotesWorkspace,
  NotesWorkspaceScope
} from "../../domain/notes";
import type {
  NotesWorkspaceQueueResult,
  NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import { compareAttachments } from "./notesWorkspaceReducer";
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

export interface NotesMutationProjectionBase {
  workspace: NotesWorkspace;
  scope: NotesWorkspaceScope;
}

export function applyDeltaToNotesWorkspace(
  base: NotesWorkspace,
  raw: RawNotesMutationDelta
): NotesWorkspace {
  const delta = scopedActiveDelta(raw);
  if (!delta) {
    return base;
  }
  const nodesById = new Map<NoteId, NoteNode>(
    base.nodes.map((node) => [node.id, node])
  );
  const attachmentsByNodeId: Record<NoteId, NoteAttachment[]> = {};
  for (const [nodeId, attachments] of Object.entries(
    base.attachmentsByNodeId ?? {}
  )) {
    attachmentsByNodeId[nodeId] = [...attachments];
  }
  for (const node of delta.changedNodes) {
    nodesById.set(node.id, node);
  }
  for (const nodeId of delta.removedNodeIds) {
    nodesById.delete(nodeId);
    delete attachmentsByNodeId[nodeId];
  }
  for (const attachment of delta.changedAttachments) {
    if (!nodesById.has(attachment.nodeId)) {
      continue;
    }
    const attachments = (attachmentsByNodeId[attachment.nodeId] ??= []);
    const currentIndex = attachments.findIndex(
      ({ id }) => id === attachment.id
    );
    if (currentIndex >= 0) {
      attachments.splice(currentIndex, 1);
    }
    let low = 0;
    let high = attachments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareAttachments(attachments[middle], attachment) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    attachments.splice(low, 0, attachment);
  }
  return {
    nodes: [...nodesById.values()],
    attachmentsByNodeId
  };
}

export function unwrapNotesMutation(
  response: NotesMutationResponse,
  confirmedBase: NotesMutationProjectionBase | null
): UnwrappedNotesMutation {
  if (isNotesMutationResult(response)) {
    const completeDelta =
      response.changedNodes !== undefined &&
      response.removedNodeIds !== undefined &&
      response.changedAttachments !== undefined
        ? {
            changedNodes: response.changedNodes,
            removedNodeIds: response.removedNodeIds,
            changedAttachments: response.changedAttachments
          }
        : null;
    const delta =
      confirmedBase?.scope.kind === "active" ? completeDelta : null;
    const workspace =
      response.workspace ??
      (completeDelta && confirmedBase?.scope.kind === "active"
        ? applyDeltaToNotesWorkspace(confirmedBase.workspace, completeDelta)
        : null);
    if (workspace === null) {
      throw new Error(
        "Cannot reconstruct an Active Notes mutation without a confirmed base workspace scoped to Active."
      );
    }
    return {
      workspace,
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
