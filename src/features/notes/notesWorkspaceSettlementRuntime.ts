import type { NoteId, NoteNode, NotesStore } from "../../domain/notes";
import type {
  NotesWorkspaceCoordinatorEvent,
  NotesWorkspaceCoordinatorSession,
  NotesWorkspaceQueueSettlement,
  NotesWorkspaceUiUpdate,
} from "./notesWorkspaceCoordinator";
import type { OptimisticInsertionSnapshot } from "./notesLocalStructure";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import { expansionsOutsideSubtree } from "./notesWorkspaceCommandSupport";

export interface RoutedKeyboardInsertionNavigation {
  readonly primaryResult: NotesWorkspaceQueueSettlement;
  readonly secondaryNavigation: NotesWorkspaceUiUpdate | null;
}

export function observeKeyboardInsertionGesture(
  session: NotesWorkspaceCoordinatorSession,
): () => void {
  const end = (): void => {
    session.setKeyboardInsertionGestureActive(false);
  };
  const keyDown = (event: globalThis.KeyboardEvent): void => {
    const title =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-notes-bullet-title]")
        : null;
    if (
      !event.isTrusted ||
      event.key !== "Enter" ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing ||
      !title ||
      title.getAttribute("aria-expanded") === "true"
    ) {
      return;
    }
    session.setKeyboardInsertionGestureActive(true);
  };
  const keyUp = (event: globalThis.KeyboardEvent): void => {
    if (event.isTrusted && event.key === "Enter") {
      end();
    }
  };
  const visibilityChange = (): void => {
    if (document.visibilityState === "hidden") end();
  };
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("blur", end);
  document.addEventListener("visibilitychange", visibilityChange);
  return () => {
    window.removeEventListener("keydown", keyDown, true);
    window.removeEventListener("keyup", keyUp, true);
    window.removeEventListener("blur", end);
    document.removeEventListener("visibilitychange", visibilityChange);
    end();
  };
}

export function recordPendingOptimisticTitles(
  previous: OptimisticInsertionSnapshot,
  event: Extract<
    NotesWorkspaceCoordinatorEvent,
    { type: "optimisticInsertion" }
  >,
  pending: Map<NoteId, string>,
): void {
  const nextIds = new Set(
    event.snapshot.insertions.map(
      (insertion) => insertion.pending.intent.expectedNodeId,
    ),
  );
  for (const insertion of previous.insertions) {
    const expectedNodeId = insertion.pending.intent.expectedNodeId;
    if (nextIds.has(expectedNodeId)) continue;
    const initialTitle =
      insertion.pending.intent.postcondition.kind === "split"
        ? insertion.pending.intent.postcondition.expectedInsertedTitle
        : "";
    const consumedByDependent =
      event.snapshot.insertions.some(
        (candidate) => candidate.dependencyId === expectedNodeId,
      ) ||
      previous.insertions.some(
        (candidate) => candidate.dependencyId === expectedNodeId,
      );
    const failedInsertionId =
      event.snapshot.failure?.insertion.pending.intent.expectedNodeId;
    if (
      insertion.insertedTitle !== initialTitle &&
      !consumedByDependent &&
      failedInsertionId !== expectedNodeId
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

function takeConfirmedOptimisticTitleUpdates(
  nodeForId: (nodeId: NoteId) => NoteNode | undefined,
  pending: Map<NoteId, string>,
): readonly ConfirmedOptimisticTitleUpdate[] {
  const updates: ConfirmedOptimisticTitleUpdate[] = [];
  for (const [nodeId, title] of pending) {
    const node = nodeForId(nodeId);
    if (!node) continue;
    pending.delete(nodeId);
    if (node.title !== title) {
      updates.push({
        nodeId,
        title,
        note: node.note,
        imageOffsetUtf16: node.imageOffsetUtf16,
      });
    }
  }
  return updates;
}

export function confirmedOptimisticTitleUpdates(
  result: NotesWorkspaceQueueSettlement,
  pending: Map<NoteId, string>,
): readonly ConfirmedOptimisticTitleUpdate[] {
  return result.kind === "authoritative"
    ? takeConfirmedOptimisticTitleUpdates(
        (nodeId) =>
          result.workspace.nodes.find((candidate) => candidate.id === nodeId),
        pending,
      )
    : [];
}

export function confirmedOptimisticTitleUpdatesFromNodesById(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  pending: Map<NoteId, string>,
): readonly ConfirmedOptimisticTitleUpdate[] {
  return takeConfirmedOptimisticTitleUpdates(
    (nodeId) => nodesById[nodeId],
    pending,
  );
}

export function routeKeyboardInsertionNavigation(
  result: NotesWorkspaceQueueSettlement,
  navigationOwned = true,
): RoutedKeyboardInsertionNavigation {
  if (result.kind === "skipped") {
    return { primaryResult: result, secondaryNavigation: null };
  }
  if (
    result.projectionPublication?.expectedNavigationVersion !== undefined &&
    !navigationOwned
  ) {
    if (!result.uiUpdate) {
      return { primaryResult: result, secondaryNavigation: null };
    }
    const {
      selectedId: _selectedId,
      editingNoteId: _editingNoteId,
      pendingFocusId: _pendingFocusId,
      pendingFocusField: _pendingFocusField,
      ...retainedUiUpdate
    } = result.uiUpdate;
    return {
      primaryResult: {
        ...result,
        uiUpdate:
          Object.keys(retainedUiUpdate).length === 0
            ? undefined
            : retainedUiUpdate,
      },
      secondaryNavigation: null,
    };
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
      pendingFocusId == null
        ? pendingFocusField
        : (pendingFocusField ?? "title"),
  };
  return {
    primaryResult: {
      ...result,
      uiUpdate:
        Object.keys(primaryUiUpdate).length === 0 ? undefined : primaryUiUpdate,
    },
    secondaryNavigation,
  };
}

export interface RoutedKeyboardInsertionSettlement extends RoutedKeyboardInsertionNavigation {
  readonly focusRequest: {
    readonly paneId: "primary" | "secondary";
    readonly nodeId: NoteId;
    readonly titleLength: number;
    readonly expectedNavigationVersion: number;
    readonly expectedUserInteractionRevision?: number;
  } | null;
}

export function routeKeyboardInsertionSettlement(
  result: NotesWorkspaceQueueSettlement,
  primaryNavigationVersion: number,
  secondaryNavigationVersion: number,
  userInteractionRevision: number,
): RoutedKeyboardInsertionSettlement {
  const publication =
    result.kind === "skipped" ? undefined : result.projectionPublication;
  const paneId =
    publication?.expectedNavigationVersion !== undefined &&
    (publication.targetPaneId === "primary" ||
      publication.targetPaneId === "secondary")
      ? publication.targetPaneId
      : null;
  const expectedNavigationVersion = publication?.expectedNavigationVersion;
  const expectedUserInteractionRevision =
    publication?.expectedUserInteractionRevision;
  const navigationOwned =
    paneId === null ||
    expectedNavigationVersion === undefined ||
    ((paneId === "primary"
      ? primaryNavigationVersion
      : secondaryNavigationVersion) === expectedNavigationVersion &&
      (expectedUserInteractionRevision === undefined ||
        userInteractionRevision === expectedUserInteractionRevision));
  const routed = routeKeyboardInsertionNavigation(result, navigationOwned);
  const nodeId =
    navigationOwned && result.kind !== "skipped"
      ? result.uiUpdate?.pendingFocusId
      : null;
  if (
    paneId === null ||
    expectedNavigationVersion === undefined ||
    nodeId == null
  ) {
    return { ...routed, focusRequest: null };
  }
  const workspace =
    result.kind === "authoritative"
      ? result.workspace
      : result.kind === "failure"
        ? result.workspace
        : undefined;
  const focusNode =
    (result.kind === "authoritative"
      ? result.delta?.changedNodes.find((candidate) => candidate.id === nodeId)
      : undefined) ??
    workspace?.nodes.find((candidate) => candidate.id === nodeId);
  return {
    ...routed,
    focusRequest: {
      paneId,
      nodeId,
      titleLength: focusNode?.title.length ?? 0,
      expectedNavigationVersion,
      ...(expectedUserInteractionRevision === undefined
        ? {}
        : { expectedUserInteractionRevision }),
    },
  };
}

export function unregisterOwnedOutlinePane(
  record: NotesWorkspaceSessionRecord | null,
  session: NotesWorkspaceCoordinatorSession | null,
  repository: NotesStore,
  vaultRoot: string,
  paneId: string,
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
  result: NotesWorkspaceQueueSettlement,
  paneId: "primary" | "secondary" = "primary",
): ReadonlySet<NoteId> {
  if (result.kind === "skipped") return current;
  const workspace = result.workspace;
  let next =
    workspace && result.clearLocalExpansionSubtreeId
      ? expansionsOutsideSubtree(
          current,
          workspace,
          result.clearLocalExpansionSubtreeId,
        )
      : current;
  const publication = result.projectionPublication;
  if (
    (publication?.targetPaneId ?? "primary") === paneId &&
    publication?.locallyExpandedNodeIds
  ) {
    next = publication.locallyExpandedNodeIds;
  }
  return next;
}
