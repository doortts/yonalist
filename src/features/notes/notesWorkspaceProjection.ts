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

/**
 * Reconstruct the full denormalized workspace from a confirmed base plus the
 * mutation's audit delta (Track T2), so a delta-only response yields the same
 * `NotesWorkspace` shape the wire used to carry. Mirrors the normalized
 * {@link applyWorkspaceDelta} semantics — same scoping, same attachment
 * ordering — so the dev-only settle verification cross-checks the two apply
 * paths against each other. Node array order is not maintained here because
 * every consumer re-sorts via {@link normalizeWorkspace}.
 */
export function applyDeltaToNotesWorkspace(
  base: NotesWorkspace,
  raw: RawNotesMutationDelta
): NotesWorkspace {
  const scoped = scopedActiveDelta(raw);
  if (!scoped) {
    // Empty delta is a no-op — the backend keeps the workspace on the wire for
    // this case, so this branch is only a safe identity fallback.
    return base;
  }
  const nodesById = new Map<NoteId, NoteNode>();
  for (const node of base.nodes) {
    nodesById.set(node.id, node);
  }
  for (const node of scoped.changedNodes) {
    nodesById.set(node.id, node);
  }
  const attachmentsByNodeId: Record<NoteId, NoteAttachment[]> = {};
  for (const [nodeId, list] of Object.entries(base.attachmentsByNodeId ?? {})) {
    attachmentsByNodeId[nodeId] = [...list];
  }
  for (const removedId of scoped.removedNodeIds) {
    nodesById.delete(removedId);
    delete attachmentsByNodeId[removedId];
  }
  for (const change of scoped.changedAttachments) {
    if (!nodesById.has(change.nodeId)) {
      continue;
    }
    const list = (attachmentsByNodeId[change.nodeId] ??= []);
    const existingIndex = list.findIndex(
      (candidate) => candidate.id === change.id
    );
    if (existingIndex >= 0) {
      list.splice(existingIndex, 1);
    }
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareAttachments(list[mid], change) <= 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    list.splice(low, 0, change);
  }
  return { nodes: [...nodesById.values()], attachmentsByNodeId };
}

/**
 * @param confirmedBase the caller's confirmed pre-mutation workspace, used to
 *   reconstruct a delta-only response (Track T2). Ignored when the response
 *   already carries a workspace; may be `null` only when the caller knows the
 *   response always carries one.
 */
export function unwrapNotesMutation(
  response: NotesMutationResponse,
  confirmedBase: NotesWorkspace | null
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
    let workspace = response.workspace;
    if (workspace === undefined) {
      // Delta-only response (isNotesMutationResult guarantees a delta here):
      // reconstruct from the confirmed base. A missing base is unrecoverable —
      // the caller maps the throw to a full reload.
      if (delta === null || confirmedBase === null) {
        throw new Error(
          "Cannot reconstruct a delta-only Notes mutation without a confirmed base workspace."
        );
      }
      workspace = applyDeltaToNotesWorkspace(confirmedBase, delta);
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
