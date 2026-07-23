import type {
  MoveNoteNodeInput,
  NoteId,
  NoteNode,
  NotesHistoryContext,
  NotesHistoryStatus,
  NotesMutationResponse,
  NotesWorkspace,
  NotesWorkspaceScope
} from "../../domain/notes";
import type {
  NotesWorkspaceQueueContext,
  NotesWorkspaceQueueResult,
  NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import {
  authoritative,
  scopedActiveDelta,
  unwrapNotesMutation,
  type UnwrappedNotesMutation
} from "./notesWorkspaceProjection";
import {
  normalizeWorkspace,
  type NormalizedNotesWorkspace,
  type NotesWorkspaceDelta
} from "./notesWorkspaceReducer";
import { canonicalizeTagFilters } from "./notesWorkspaceScope";
import type {
  NotesLifecycleNavigationSnapshot,
  NotesLifecycleNavigationTransition,
  NotesWorkspaceQueueStep,
  ProjectedNotesMutation
} from "./notesWorkspaceTypes";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function cloneWorkspaceScope(scope: NotesWorkspaceScope): NotesWorkspaceScope {
  return scope.kind === "tags"
    ? { kind: "tags", tags: canonicalizeTagFilters(scope.tags) }
    : { ...scope };
}

export function emptyHistoryState(): NotesHistoryStatus {
  return {
    canUndo: false,
    canRedo: false,
    historyEpoch: "",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
  };
}

function forwardableActiveDelta(
  mutation: UnwrappedNotesMutation,
  projection: ProjectedNotesMutation
): NotesWorkspaceDelta | undefined {
  if (
    projection.projectionError !== undefined ||
    projection.workspace !== mutation.workspace
  ) {
    return undefined;
  }
  return scopedActiveDelta(mutation.delta);
}

export function historyArguments(
  context: NotesHistoryContext | null | undefined
): [NotesHistoryContext] {
  if (!context) {
    throw new Error("A Notes user mutation requires a history context.");
  }
  return [context];
}

export function expansionsOutsideSubtree(
  current: ReadonlySet<NoteId>,
  workspace: NotesWorkspace,
  subtreeRootId: NoteId
): Set<NoteId> {
  const nodesById = Object.fromEntries(
    workspace.nodes.map((node) => [node.id, node])
  ) as Record<NoteId, NoteNode>;
  const next = new Set(current);
  for (const candidateId of current) {
    let candidate: NoteNode | undefined = nodesById[candidateId];
    const visited = new Set<NoteId>();
    while (candidate && !visited.has(candidate.id)) {
      if (candidate.id === subtreeRootId) {
        next.delete(candidateId);
        break;
      }
      visited.add(candidate.id);
      candidate = candidate.parentId
        ? nodesById[candidate.parentId]
        : undefined;
    }
  }
  return next;
}

export function samePreparedMoveNode(
  prepared: NoteNode | undefined,
  current: NoteNode | undefined
): boolean {
  return Boolean(
    prepared &&
      current &&
      prepared.id === current.id &&
      prepared.parentId === current.parentId &&
      prepared.sortKey === current.sortKey &&
      prepared.title === current.title &&
      prepared.note === current.note &&
      prepared.imageOffsetUtf16 === current.imageOffsetUtf16 &&
      prepared.layoutMode === current.layoutMode &&
      prepared.isCollapsed === current.isCollapsed &&
      prepared.isStarred === current.isStarred &&
      prepared.completedAt === current.completedAt &&
      prepared.createdAt === current.createdAt &&
      prepared.updatedAt === current.updatedAt &&
      prepared.deletedAt === current.deletedAt &&
      prepared.archivedAt === current.archivedAt &&
      prepared.archiveRootId === current.archiveRootId
  );
}

export async function workspaceForScope(
  context: NotesWorkspaceQueueContext,
  mutationWorkspace: NotesWorkspace,
  scope: NotesWorkspaceScope
): Promise<NotesWorkspace> {
  return scope.kind === "active"
    ? mutationWorkspace
    : context.repository.loadWorkspace(context.vaultRoot, scope);
}

export async function projectNotesMutation(
  context: NotesWorkspaceQueueContext,
  mutation: UnwrappedNotesMutation,
  scope: NotesWorkspaceScope
): Promise<ProjectedNotesMutation> {
  try {
    return {
      workspace: await workspaceForScope(context, mutation.workspace, scope)
    };
  } catch (cause) {
    if (!mutation.atomic) throw cause;
    return {
      workspace: mutation.workspace,
      projectionError: errorMessage(cause)
    };
  }
}

export function directMutationResult(
  mutation: UnwrappedNotesMutation,
  projection: ProjectedNotesMutation,
  uiUpdate?: NotesWorkspaceUiUpdate,
  broadcastScope?: NotesWorkspaceScope
): NotesWorkspaceQueueResult {
  if (!projection.projectionError) {
    const result = authoritative(
      projection.workspace,
      uiUpdate,
      mutation.historyStatus,
      {
        invalidatesTagSummaries: true,
        delta: forwardableActiveDelta(mutation, projection)
      }
    );
    return broadcastScope && result.kind === "authoritative"
      ? { ...result, broadcastScope: cloneWorkspaceScope(broadcastScope) }
      : result;
  }
  return { kind: "failure", error: projection.projectionError };
}

export async function runCompoundQueueWork(
  context: NotesWorkspaceQueueContext,
  steps: NotesWorkspaceQueueStep[],
  uiUpdate?: NotesWorkspaceUiUpdate,
  scope: NotesWorkspaceScope = { kind: "active" }
): Promise<
  NotesWorkspaceQueueResult & {
    historyRejectionState?: NotesHistoryStatus;
  }
> {
  let workspace = context.confirmedWorkspace;
  let hasAuthoritativeStep = false;
  let historyStatus: NotesHistoryStatus | undefined;
  let stepCount = 0;
  let lastMutation: UnwrappedNotesMutation | null = null;
  let lastAtomicEntryId: string | null = null;
  const committedHistoryEntryIds: string[] = [];
  const nonAtomicHistoryEntryIds: string[] = [];

  try {
    for (const step of steps) {
      const stepResult = await step.run();
      if (
        typeof stepResult === "object" &&
        stepResult !== null &&
        "kind" in stepResult &&
        (stepResult.kind === "authoritative" ||
          stepResult.kind === "failure" ||
          stepResult.kind === "skipped")
      ) {
        return stepResult as NotesWorkspaceQueueResult;
      }
      const mutation = unwrapNotesMutation(stepResult as NotesMutationResponse);
      const expectedEntryId = step.historyEntryId ?? null;
      if (
        mutation.atomic &&
        mutation.historyEntryId !== null &&
        expectedEntryId &&
        (mutation.historyEntryId !== expectedEntryId ||
          mutation.historyStatus?.historyEpoch !== context.history?.historyEpoch ||
          mutation.historyStatus?.nextUndoEntryId !== expectedEntryId ||
          mutation.historyStatus?.nextRedoEntryId !== null ||
          mutation.historyStatus?.canUndo !== true ||
          mutation.historyStatus?.canRedo !== false)
      ) {
        const historyRejectionState = mutation.historyStatus ?? {
          ...emptyHistoryState(),
          historyEpoch: context.history?.historyEpoch ?? ""
        };
        return {
          kind: "failure",
          error: "Notes history did not acknowledge the compound mutation.",
          workspace: context.confirmedWorkspace,
          committedHistoryEntryIds: [expectedEntryId],
          ...(mutation.historyStatus
            ? { historyStatus: mutation.historyStatus }
            : {}),
          historyRejectionState
        };
      }
      workspace = mutation.workspace;
      hasAuthoritativeStep = true;
      stepCount += 1;
      lastMutation = mutation;
      lastAtomicEntryId = mutation.atomic
        ? mutation.historyEntryId ?? lastAtomicEntryId
        : lastAtomicEntryId;
      historyStatus = mutation.historyStatus ?? historyStatus;
      const committedHistoryEntryId = mutation.atomic
        ? mutation.historyEntryId
        : step.historyEntryId;
      if (
        committedHistoryEntryId &&
        !committedHistoryEntryIds.includes(committedHistoryEntryId)
      ) {
        committedHistoryEntryIds.push(committedHistoryEntryId);
      }
      if (
        !mutation.atomic &&
        expectedEntryId &&
        !nonAtomicHistoryEntryIds.includes(expectedEntryId)
      ) {
        nonAtomicHistoryEntryIds.push(expectedEntryId);
      }
    }
    let projectedWorkspace: NotesWorkspace;
    try {
      projectedWorkspace = await workspaceForScope(context, workspace, scope);
    } catch (cause) {
      return {
        kind: "failure",
        error: errorMessage(cause),
        workspace: context.confirmedWorkspace,
        ...(lastAtomicEntryId
          ? { committedHistoryEntryIds: [lastAtomicEntryId] }
          : {}),
        ...(historyStatus
          ? { historyStatus, historyRejectionState: historyStatus }
          : {})
      };
    }
    const delta =
      stepCount === 1 && lastMutation && projectedWorkspace === workspace
        ? scopedActiveDelta(lastMutation.delta)
        : undefined;
    const result = authoritative(
      projectedWorkspace,
      uiUpdate,
      historyStatus,
      committedHistoryEntryIds.length > 0
        ? { committedHistoryEntryIds, invalidatesTagSummaries: true, delta }
        : { invalidatesTagSummaries: true, delta }
    );
    return result.kind === "authoritative"
      ? {
          ...result,
          projectionScope: cloneWorkspaceScope(scope),
          ...(nonAtomicHistoryEntryIds.length > 0
            ? { nonAtomicHistoryEntryIds }
            : {})
        }
      : result;
  } catch (cause) {
    if (hasAuthoritativeStep && scope.kind !== "active") {
      workspace = context.confirmedWorkspace;
      try {
        workspace = await context.repository.loadWorkspace(
          context.vaultRoot,
          scope
        );
      } catch {
        // The last confirmed projection still belongs to the selected scope.
      }
    }
    return {
      kind: "failure",
      error: errorMessage(cause),
      ...(hasAuthoritativeStep ? { workspace } : {}),
      ...(historyStatus ? { historyStatus } : {}),
      ...(hasAuthoritativeStep ? { invalidatesTagSummaries: true } : {}),
      ...(committedHistoryEntryIds.length > 0
        ? { committedHistoryEntryIds }
        : {})
    };
  }
}

export function notifySuccess(callback: (() => void) | undefined): void {
  if (!callback) return;
  try {
    callback();
  } catch {
    // Local completion handlers cannot change an authoritative queue result.
  }
}

export function confirmedState(
  context: NotesWorkspaceQueueContext
): NormalizedNotesWorkspace {
  return normalizeWorkspace(context.confirmedWorkspace);
}

export function focusedUiUpdate(
  focusNodeId: NoteId | null | undefined
): NotesWorkspaceUiUpdate | undefined {
  return focusNodeId == null
    ? undefined
    : {
        selectedId: focusNodeId,
        editingNoteId: focusNodeId,
        pendingFocusId: focusNodeId,
        pendingFocusField: "title"
      };
}

export function duplicateRootId(
  before: NormalizedNotesWorkspace,
  after: NotesWorkspace,
  sourceId: NoteId
): NoteId | null {
  const source = before.nodesById[sourceId];
  if (!source) return null;
  return (
    after.nodes.find(
      (node) =>
        node.parentId === source.parentId && !before.nodesById[node.id]
    )?.id ?? null
  );
}

export function rootIdForNode(
  workspace: NormalizedNotesWorkspace,
  nodeId: NoteId | null
): NoteId | null {
  let currentId = nodeId;
  const visited = new Set<NoteId>();
  while (currentId !== null && !visited.has(currentId)) {
    const node = workspace.nodesById[currentId];
    if (!node) return null;
    if (node.parentId === null) return node.id;
    visited.add(currentId);
    currentId = node.parentId;
  }
  return null;
}

function fallbackRootAfterRemoval(
  beforeRootIds: readonly NoteId[],
  afterRootIds: readonly NoteId[],
  removedRootId: NoteId
): NoteId | null {
  const removedIndex = beforeRootIds.indexOf(removedRootId);
  const remaining = new Set(afterRootIds);
  if (removedIndex < 0) return afterRootIds[0] ?? null;
  for (let index = removedIndex + 1; index < beforeRootIds.length; index += 1) {
    const candidate = beforeRootIds[index];
    if (remaining.has(candidate)) return candidate;
  }
  for (let index = removedIndex - 1; index >= 0; index -= 1) {
    const candidate = beforeRootIds[index];
    if (remaining.has(candidate)) return candidate;
  }
  return null;
}

export function resolveRootLifecycleNavigation(
  beforeWorkspace: NormalizedNotesWorkspace,
  afterWorkspace: NormalizedNotesWorkspace,
  removedRootId: NoteId,
  before: NotesLifecycleNavigationSnapshot
): NotesLifecycleNavigationTransition {
  const openRootId = rootIdForNode(beforeWorkspace, before.zoomRootId);
  if (openRootId !== removedRootId) {
    const existing = (nodeId: NoteId | null) =>
      nodeId !== null && afterWorkspace.nodesById[nodeId] ? nodeId : null;
    const pendingFocusId = existing(before.pendingFocusId);
    return {
      before,
      after: {
        ...before,
        selectedId: existing(before.selectedId),
        zoomRootId: existing(before.zoomRootId),
        editingNoteId: existing(before.editingNoteId),
        pendingFocusId,
        pendingFocusField:
          pendingFocusId === null ? null : before.pendingFocusField,
        locallyExpandedNodeIds: new Set(
          [...before.locallyExpandedNodeIds].filter(
            (nodeId) => afterWorkspace.nodesById[nodeId]
          )
        )
      }
    };
  }

  const fallbackRootId = fallbackRootAfterRemoval(
    beforeWorkspace.rootIds,
    afterWorkspace.rootIds,
    removedRootId
  );
  const fallbackRoot = fallbackRootId
    ? afterWorkspace.nodesById[fallbackRootId]
    : undefined;
  const focusFallback = fallbackRoot !== undefined && fallbackRoot.deletedAt === null;
  return {
    before,
    after: {
      ...before,
      selectedId: fallbackRootId,
      zoomRootId: fallbackRootId,
      editingNoteId: focusFallback ? fallbackRootId : null,
      pendingFocusId: focusFallback ? fallbackRootId : null,
      pendingFocusField:
        focusFallback ? before.pendingFocusField ?? "title" : null,
      locallyExpandedNodeIds: new Set()
    }
  };
}

export function hasMoveDependencies(
  workspace: NormalizedNotesWorkspace,
  input: MoveNoteNodeInput
): boolean {
  return Boolean(
    workspace.nodesById[input.id] &&
      (input.parentId === null || workspace.nodesById[input.parentId]) &&
      (input.afterId === null || workspace.nodesById[input.afterId]) &&
      (input.beforeId == null || workspace.nodesById[input.beforeId])
  );
}
