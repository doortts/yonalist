import type { NoteId, NotesStore } from "../../domain/notes";
import type {
  NotesWorkspaceCoordinatorSession,
  NotesWorkspaceQueueSettlement
} from "./notesWorkspaceCoordinator";
import type { NotesProjectionPublication } from "./notesWorkspaceTypes";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import { expansionsOutsideSubtree } from "./notesWorkspaceCommandSupport";

export interface PendingKeyboardInsertionFocus {
  readonly vaultRoot: string;
  readonly nodeId: NoteId;
  readonly interactionEpochAtDispatch: number;
}

export function pendingKeyboardInsertionEpoch(
  pending: PendingKeyboardInsertionFocus | null,
  vaultRoot: string,
  nodeId: NoteId
): number | undefined {
  return pending?.vaultRoot === vaultRoot && pending.nodeId === nodeId
    ? pending.interactionEpochAtDispatch
    : undefined;
}

export function unregisterOwnedOutlinePane(
  record: NotesWorkspaceSessionRecord | null,
  session: NotesWorkspaceCoordinatorSession | null,
  repository: NotesStore,
  vaultRoot: string,
  paneId: string
): void {
  if (
    record?.repository === repository &&
    record.vaultRoot === vaultRoot &&
    session === record.session
  ) {
    session.unregisterOutlinePane(paneId);
  }
}

export function settledKeyboardInsertionFocus(
  current: PendingKeyboardInsertionFocus | null,
  result: NotesWorkspaceQueueSettlement,
  vaultRoot: string
): PendingKeyboardInsertionFocus | null {
  const disposition =
    result.kind !== "skipped"
      ? result.projectionPublication?.keyboardInsertionDisposition
      : undefined;
  if (disposition?.kind !== "exact" && disposition?.kind !== "mixed") {
    return current;
  }
  return disposition.settlement.focusEligible
    ? {
        vaultRoot,
        nodeId: disposition.pending.intent.expectedNodeId,
        interactionEpochAtDispatch:
          disposition.pending.interactionEpochAtDispatch
      }
    : null;
}

export function settledLocalExpansions(
  current: ReadonlySet<NoteId>,
  result: NotesWorkspaceQueueSettlement
): ReadonlySet<NoteId> {
  if (result.kind === "skipped") return current;
  const workspace = result.workspace;
  let next =
    workspace && result.clearLocalExpansionSubtreeId
      ? expansionsOutsideSubtree(
          current,
          workspace,
          result.clearLocalExpansionSubtreeId
        )
      : current;
  next = result.projectionPublication?.locallyExpandedNodeIds ?? next;
  return next;
}

export function consumedInsertionMotion(
  publication: NotesProjectionPublication | null,
  intentToken: number
): NotesProjectionPublication | null {
  const disposition = publication?.keyboardInsertionDisposition;
  if (
    !publication ||
    (disposition?.kind !== "exact" && disposition?.kind !== "mixed") ||
    disposition.settlement.intentToken !== intentToken
  ) {
    return publication;
  }
  const { keyboardInsertionDisposition: _consumed, ...remaining } = publication;
  return remaining;
}
