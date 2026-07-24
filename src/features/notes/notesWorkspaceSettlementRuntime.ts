import type { NoteId, NotesStore } from "../../domain/notes";
import type {
  NotesWorkspaceCoordinatorSession,
  NotesWorkspaceQueueSettlement,
  NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import type { NotesProjectionPublication } from "./notesWorkspaceTypes";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import { expansionsOutsideSubtree } from "./notesWorkspaceCommandSupport";

export interface PendingKeyboardInsertionFocus {
  readonly vaultRoot: string;
  readonly nodeId: NoteId;
  readonly intentToken: number;
  readonly interactionEpochAtDispatch: number;
}

export interface RoutedKeyboardInsertionNavigation {
  readonly primaryResult: NotesWorkspaceQueueSettlement;
  readonly secondaryNavigation: NotesWorkspaceUiUpdate | null;
}

export function routeKeyboardInsertionNavigation(
  result: NotesWorkspaceQueueSettlement
): RoutedKeyboardInsertionNavigation {
  if (result.kind === "skipped") {
    return { primaryResult: result, secondaryNavigation: null };
  }
  const disposition =
    result.projectionPublication?.keyboardInsertionDisposition;
  if (
    (disposition?.kind !== "exact" && disposition?.kind !== "mixed") ||
    !disposition.settlement.focusEligible ||
    disposition.settlement.ownerPaneId !== "secondary" ||
    !result.uiUpdate
  ) {
    return { primaryResult: result, secondaryNavigation: null };
  }
  const {
    selectedId,
    editingNoteId,
    pendingFocusId,
    pendingFocusField,
    ...primaryUiUpdate
  } = result.uiUpdate;
  const secondaryNavigation = {
    selectedId,
    editingNoteId,
    pendingFocusId,
    pendingFocusField:
      pendingFocusId == null ? pendingFocusField : (pendingFocusField ?? "title")
  };
  return {
    primaryResult: {
      ...result,
      uiUpdate:
        Object.keys(primaryUiUpdate).length === 0
          ? undefined
          : primaryUiUpdate
    },
    secondaryNavigation
  };
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
        intentToken: disposition.settlement.intentToken,
        interactionEpochAtDispatch:
          disposition.pending.interactionEpochAtDispatch
      }
    : null;
}

export function ownsKeyboardInsertionFocus(
  pending: PendingKeyboardInsertionFocus | null,
  vaultRoot: string,
  intentToken: number,
  nodeId: NoteId | undefined
): nodeId is NoteId {
  return (
    nodeId !== undefined &&
    pending?.vaultRoot === vaultRoot &&
    pending.nodeId === nodeId &&
    pending.intentToken === intentToken
  );
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
