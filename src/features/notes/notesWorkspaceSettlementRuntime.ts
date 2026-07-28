import type { NoteId, NotesStore } from "../../domain/notes";
import type {
  NotesWorkspaceCoordinatorEvent,
  NotesWorkspaceCoordinatorSession,
  NotesWorkspaceQueueSettlement,
  NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import type { OptimisticInsertionSnapshot } from "./notesLocalStructure";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import { expansionsOutsideSubtree } from "./notesWorkspaceCommandSupport";

export interface RoutedKeyboardInsertionNavigation {
  readonly primaryResult: NotesWorkspaceQueueSettlement;
  readonly secondaryNavigation: NotesWorkspaceUiUpdate | null;
}

export function recordPendingOptimisticTitles(
  previous: OptimisticInsertionSnapshot,
  event: Extract<
    NotesWorkspaceCoordinatorEvent,
    { type: "optimisticInsertion" }
  >,
  pending: Map<NoteId, string>
): void {
  const nextIds = new Set(
    event.snapshot.insertions.map(
      (insertion) => insertion.pending.intent.expectedNodeId
    )
  );
  for (const insertion of previous.insertions) {
    const expectedNodeId = insertion.pending.intent.expectedNodeId;
    if (nextIds.has(expectedNodeId)) continue;
    const initialTitle =
      insertion.pending.intent.postcondition.kind === "split"
        ? insertion.pending.intent.postcondition.expectedInsertedTitle
        : "";
    const consumedByDependent = event.snapshot.insertions.some(
      (candidate) => candidate.dependencyId === expectedNodeId
    );
    if (
      insertion.insertedTitle !== initialTitle &&
      !consumedByDependent
    ) {
      pending.set(expectedNodeId, insertion.insertedTitle);
    }
  }
}

export interface ConfirmedOptimisticTitleUpdate {
  readonly nodeId: NoteId;
  readonly title: string;
  readonly note: string;
  readonly imageOffsetUtf16: number;
}

export function confirmedOptimisticTitleUpdates(
  result: NotesWorkspaceQueueSettlement,
  pending: Map<NoteId, string>
): readonly ConfirmedOptimisticTitleUpdate[] {
  if (result.kind !== "authoritative") return [];
  const updates: ConfirmedOptimisticTitleUpdate[] = [];
  for (const [nodeId, title] of pending) {
    const node = result.workspace.nodes.find(
      (candidate) => candidate.id === nodeId
    );
    if (!node) continue;
    pending.delete(nodeId);
    if (node.title !== title) {
      updates.push({
        nodeId,
        title,
        note: node.note,
        imageOffsetUtf16: node.imageOffsetUtf16
      });
    }
  }
  return updates;
}

export function routeKeyboardInsertionNavigation(
  result: NotesWorkspaceQueueSettlement
): RoutedKeyboardInsertionNavigation {
  if (result.kind === "skipped") {
    return { primaryResult: result, secondaryNavigation: null };
  }
  if (
    result.projectionPublication?.targetPaneId !== "secondary" ||
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
