import type { MutableRefObject } from "react";
import { createNoteId } from "../../domain/notes";
import type {
  ApplyNotesBatchInput,
  ImportSubtreeInput,
  MoveNoteNodeInput,
  NoteId,
  NoteNode,
  NoteSearchTag,
  NotesHistoryContext,
  NotesWorkspace,
  NotesWorkspaceScope,
  NoteTagFilter
} from "../../domain/notes";
import type { NotesHistoryFocus } from "./notesHistory";
import {
  normalizeWorkspace,
  settledUiState,
  settleWorkspaceStore,
  type NormalizedNotesWorkspace
} from "./notesWorkspaceReducer";
import type {
  NotesWorkspaceCommandOutcome,
  NotesWorkspaceCoordinatorSession,
  NotesWorkspaceQueueContext,
  NotesWorkspaceQueueResult,
  NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import { buildNotesMoveNodeInput } from "./notesMoveTargets";
import {
  appliedHistoryContext,
  authoritative,
  confirmedState,
  directMutationResult,
  duplicateRootId,
  expansionsOutsideSubtree,
  focusedUiUpdate,
  hasMoveDependencies,
  historyArguments,
  notifySuccess,
  projectNotesMutation,
  resolveRootLifecycleNavigation,
  rootIdForNode,
  runCompoundQueueWork,
  sameScope,
  samePreparedMoveNode,
  unwrapNotesMutation,
  workspaceForScope,
  type LiveNotesNavigation,
  type NotesLibraryView,
  type NotesLifecycleNavigationSnapshot,
  type NotesLifecycleNavigationTransition,
  type NotesPreparedMove,
  type NotesPreparedMoveCommitResult,
  type NotesPreparedSelectionAuthority,
  type NotesWorkspaceCompoundOptions,
  type NotesWorkspaceQueueStep,
  type StructuralCommandOptions,
  type TagFilterOrigin,
  type UnwrappedNotesMutation
} from "./useNotesWorkspace";

/**
 * Everything the structural command bodies read from the hook. The hook
 * assembles this once (a memoized snapshot of its refs, state setters, and the
 * queue/history callbacks) and delegates every structural command to the pure
 * functions below, so the ~20 command bodies no longer live inline in the hook.
 *
 * Refs are the hook's live values: reading `.current` at command-execution time
 * observes the same state the inline bodies did. Callbacks are captured by the
 * memo dependency list so the context (and therefore the delegating actions)
 * only churns identity when one of those callbacks changes — matching the
 * pre-extraction identity behaviour the context-split tests pin.
 */
export interface NotesCommandContext {
  readonly activeScopeRef: MutableRefObject<NotesWorkspaceScope>;
  readonly sessionRecordRef: MutableRefObject<NotesWorkspaceSessionRecord | null>;
  readonly sessionRef: MutableRefObject<NotesWorkspaceCoordinatorSession | null>;
  // The reducer-owned navigation, derived on demand (settled state plus the live
  // editing caret). Commands read this instead of a parallel navigation ref.
  readonly currentNavigation: () => LiveNotesNavigation;
  readonly currentEditingFocus: () => NotesHistoryFocus | null;
  readonly navigationVersionRef: MutableRefObject<number>;
  readonly locallyExpandedNodeIdsRef: MutableRefObject<ReadonlySet<NoteId>>;
  readonly tagFilterRequestRef: MutableRefObject<number>;
  readonly tagFilterOriginRef: MutableRefObject<TagFilterOrigin | null>;
  readonly stateRef: MutableRefObject<NormalizedNotesWorkspace>;
  readonly requestedTagFiltersRef: MutableRefObject<readonly NoteTagFilter[]>;
  readonly movePreparationTokenRef: MutableRefObject<number>;
  readonly selectionPreparationTokenRef: MutableRefObject<number>;
  readonly selectionRevisionRef: MutableRefObject<number>;
  readonly vaultRootRef: MutableRefObject<string>;
  readonly libraryViewRef: MutableRefObject<NotesLibraryView>;
  readonly activeWorkspaceGenerationRef: MutableRefObject<number>;
  readonly setLibraryView: (view: NotesLibraryView) => void;
  readonly setActiveTagFilters: (filters: readonly NoteTagFilter[]) => void;
  readonly runStructuralCommand: (
    commandKind: string,
    work: (
      context: NotesWorkspaceQueueContext,
      historyContext: NotesHistoryContext | null,
      record: NotesWorkspaceSessionRecord
    ) => Promise<NotesWorkspaceQueueResult> | NotesWorkspaceQueueResult,
    options?: StructuralCommandOptions
  ) => Promise<NotesWorkspaceCommandOutcome>;
  readonly rememberHistoryAfter: (
    context: NotesHistoryContext | null | undefined,
    workspace: NotesWorkspace,
    uiUpdate?: NotesWorkspaceUiUpdate,
    focus?: NotesHistoryFocus | null,
    expandedNodeIds?: ReadonlySet<NoteId>
  ) => void;
  readonly replaceLocalExpansions: (nodeIds: ReadonlySet<NoteId>) => void;
  readonly beginTextEntry: (
    record: NotesWorkspaceSessionRecord,
    nodeId: NoteId,
    focus: NotesHistoryFocus
  ) => NotesHistoryContext | null;
  readonly settleInlineTextEntry: (
    record: NotesWorkspaceSessionRecord,
    context: NotesHistoryContext | null,
    result: NotesWorkspaceQueueResult
  ) => void;
  readonly closeTextBurst: () => void;
}

/**
 * The single session-staleness guard. Every command body used to inline the
 * same triple check (record not closing, and still the session record and
 * session the coordinator is pointing at). This is the one definition; each
 * checkpoint that previously repeated the expression now calls this instead,
 * preserving exact bail-out semantics.
 */
export function ownerStillActive(
  ctx: NotesCommandContext,
  record: NotesWorkspaceSessionRecord
): boolean {
  return (
    !record.closing &&
    ctx.sessionRecordRef.current === record &&
    ctx.sessionRef.current === record.session
  );
}

/**
 * Return the library projection to the Active view and clear every tag-filter
 * tracker in one step. Scope is single-sourced (activeScopeRef, set by the
 * caller alongside the mutation), and the rendered library view + tag filters
 * are derived from it here — the three trackers move together instead of being
 * poked independently at each call site, which is where they used to drift.
 */
function activateAllLibraryView(ctx: NotesCommandContext): void {
  ctx.setLibraryView("all");
  ctx.requestedTagFiltersRef.current = [];
  ctx.tagFilterOriginRef.current = null;
  ctx.tagFilterRequestRef.current += 1;
  ctx.setActiveTagFilters([]);
}

export async function createRootCommand(
  ctx: NotesCommandContext
): Promise<NotesWorkspaceCommandOutcome> {
  const transitionToAll = ctx.libraryViewRef.current !== "all";
  let created = false;
  const creation = { record: null as NotesWorkspaceSessionRecord | null };
  const outcome = await ctx.runStructuralCommand(
    "create",
    async (context, historyContext) => {
    const ownerRecord = ctx.sessionRecordRef.current;
    if (!ownerRecord) {
      return { kind: "skipped" };
    }
    const before = normalizeWorkspace(
      transitionToAll
        ? await context.repository.loadWorkspace(context.vaultRoot, {
            kind: "active"
          })
        : context.confirmedWorkspace
    );
    if (!ownerStillActive(ctx, ownerRecord)) {
      return { kind: "skipped" };
    }
    const id = createNoteId();
    const mutation = unwrapNotesMutation(await context.repository.createNode(
      context.vaultRoot,
      {
        id,
        parentId: null,
        afterId: before.rootIds.at(-1) ?? null,
        title: "",
        note: ""
      },
      ...historyArguments(historyContext)
    ));
    if (!ownerStillActive(ctx, ownerRecord)) {
      return authoritative(
        mutation.workspace,
        undefined,
        mutation.historyStatus,
        { invalidatesTagSummaries: true }
      );
    }
    created = true;
    creation.record = ownerRecord;
    ctx.activeScopeRef.current = { kind: "active" };
    const uiUpdate = {
      selectedId: id,
      editingNoteId: id,
      pendingFocusId: id,
      pendingFocusField: "title" as const,
      zoomRootId: null
    };
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      mutation.workspace,
      uiUpdate,
      undefined,
      transitionToAll ? new Set() : ctx.locallyExpandedNodeIdsRef.current
    );
    return authoritative(
      mutation.workspace,
      uiUpdate,
      mutation.historyStatus,
      { invalidatesTagSummaries: true }
    );
  });
  if (
    created &&
    creation.record &&
    ownerStillActive(ctx, creation.record) &&
    transitionToAll
  ) {
    activateAllLibraryView(ctx);
    ctx.replaceLocalExpansions(new Set());
  }
  return outcome;
}

export async function createChildCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId
): Promise<NotesWorkspaceCommandOutcome> {
  return ctx.runStructuralCommand("create", async (context, historyContext) => {
    const before = confirmedState(context);
    if (!before.nodesById[nodeId]) {
      return { kind: "skipped" };
    }
    const id = createNoteId();
    const mutation = unwrapNotesMutation(await context.repository.createNode(
      context.vaultRoot,
      {
        id,
        parentId: nodeId,
        afterId: before.childIdsByParent[nodeId]?.at(-1) ?? null,
        title: "",
        note: ""
      },
      ...historyArguments(historyContext)
    ));
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    const uiUpdate = {
      selectedId: id,
      editingNoteId: id,
      pendingFocusId: id,
      pendingFocusField: "title" as const
    };
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      projection.workspace,
      uiUpdate
    );
    return directMutationResult(mutation, projection, uiUpdate);
  });
}

export async function splitNodeCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId,
  newNodeId: NoteId,
  prefix: string,
  suffix: string,
  options?: NotesWorkspaceCompoundOptions
): Promise<NotesWorkspaceCommandOutcome> {
  const hadCentralDraft =
    ctx.sessionRecordRef.current?.drafts.has(nodeId) ?? false;
  const record = ctx.sessionRecordRef.current;
  const centralDraft = record?.drafts.get(nodeId);
  const hasCentralDraft = centralDraft !== undefined;
  const inlineDraft =
    hadCentralDraft || hasCentralDraft ? undefined : options?.draft;
  let succeeded = false;
  const completion = ctx.runStructuralCommand(
    "split",
    async (context, historyContext, executionRecord) => {
      if (!confirmedState(context).nodesById[nodeId]) {
        return { kind: "skipped" };
      }
      const inlineTextContext = inlineDraft
        ? ctx.beginTextEntry(executionRecord, nodeId, {
            nodeId,
            field: "title"
          })
        : null;
      const steps: NotesWorkspaceQueueStep[] = [];
      if (inlineDraft) {
        steps.push({
          historyEntryId: inlineTextContext?.entryId,
          run: async () => {
            const response = await context.repository.updateNode(
              context.vaultRoot,
              { id: nodeId, ...inlineDraft },
              ...historyArguments(inlineTextContext)
            );
            const mutation = unwrapNotesMutation(response);
            ctx.rememberHistoryAfter(
              appliedHistoryContext(inlineTextContext, mutation),
              mutation.workspace,
              undefined,
              { nodeId, field: "title" }
            );
            return response;
          }
        });
      }
      steps.push({
        historyEntryId: historyContext?.entryId,
        run: () => context.repository.splitNode(
          context.vaultRoot,
          {
            id: nodeId,
            newNodeId,
            prefix,
            suffix
          },
          ...historyArguments(historyContext)
        )
      });
      const result = await runCompoundQueueWork(
        context,
        steps,
        {
          selectedId: newNodeId,
          editingNoteId: newNodeId,
          pendingFocusId: newNodeId
        },
        ctx.activeScopeRef.current
      );
      ctx.settleInlineTextEntry(executionRecord, inlineTextContext, result);
      if (result.kind === "authoritative") {
        ctx.rememberHistoryAfter(
          historyContext &&
            result.committedHistoryEntryIds?.includes(historyContext.entryId)
            ? historyContext
            : null,
          result.workspace,
          result.uiUpdate
        );
      }
      succeeded = result.kind === "authoritative";
      return result;
    }
  );
  return completion.then((outcome) => {
    if (succeeded) {
      notifySuccess(options?.onSuccess);
    }
    return outcome;
  });
}

export async function updateNodeCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId,
  patch: Pick<NoteNode, "title" | "note">
): Promise<NotesWorkspaceCommandOutcome> {
  return ctx.runStructuralCommand("update", async (context, historyContext) => {
    if (!confirmedState(context).nodesById[nodeId]) {
      return { kind: "skipped" };
    }
    const mutation = unwrapNotesMutation(await context.repository.updateNode(
      context.vaultRoot,
      {
        id: nodeId,
        ...patch
      },
      ...historyArguments(historyContext)
    ));
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      projection.workspace
    );
    return directMutationResult(mutation, projection);
  });
}

export async function moveNodeCommand(
  ctx: NotesCommandContext,
  input: MoveNoteNodeInput,
  focusNodeId?: NoteId | null,
  options?: NotesWorkspaceCompoundOptions
): Promise<NotesWorkspaceCommandOutcome> {
  const hadCentralDraft =
    ctx.sessionRecordRef.current?.drafts.has(input.id) ?? false;
  const record = ctx.sessionRecordRef.current;
  const centralDraft = record?.drafts.get(input.id);
  const hasCentralDraft = centralDraft !== undefined;
  const inlineDraft =
    hadCentralDraft || hasCentralDraft ? undefined : options?.draft;
  return ctx.runStructuralCommand("move", async (context, historyContext, executionRecord) => {
    const before = confirmedState(context);
    const expandNodeId = options?.expandNodeId;
    if (
      !hasMoveDependencies(before, input) ||
      (expandNodeId !== undefined && !before.nodesById[expandNodeId])
    ) {
      return { kind: "skipped" };
    }
    const inlineTextContext = inlineDraft
      ? ctx.beginTextEntry(executionRecord, input.id, {
          nodeId: input.id,
          field: "title"
        })
      : null;
    const steps: NotesWorkspaceQueueStep[] = [];
    if (inlineDraft) {
      steps.push({
        historyEntryId: inlineTextContext?.entryId,
        run: async () => {
          const response = await context.repository.updateNode(
            context.vaultRoot,
            { id: input.id, ...inlineDraft },
            ...historyArguments(inlineTextContext)
          );
          const mutation = unwrapNotesMutation(response);
          ctx.rememberHistoryAfter(
            appliedHistoryContext(inlineTextContext, mutation),
            mutation.workspace,
            undefined,
            { nodeId: input.id, field: "title" }
          );
          return response;
        }
      });
    }
    if (
      expandNodeId !== undefined &&
      before.nodesById[expandNodeId].isCollapsed
    ) {
      steps.push({
        historyEntryId: historyContext?.entryId,
        run: () => context.repository.toggleCollapsed(
            context.vaultRoot,
            expandNodeId,
            ...historyArguments(historyContext)
          )
      });
    }
    steps.push({
      historyEntryId: historyContext?.entryId,
      run: () => context.repository.moveNode(
        context.vaultRoot,
        input,
        ...historyArguments(historyContext)
      )
    });
    const result = await runCompoundQueueWork(
      context,
      steps,
      focusedUiUpdate(focusNodeId),
      ctx.activeScopeRef.current
    );
    ctx.settleInlineTextEntry(executionRecord, inlineTextContext, result);
    if (result.kind === "authoritative") {
      ctx.rememberHistoryAfter(
        historyContext &&
          result.committedHistoryEntryIds?.includes(historyContext.entryId)
          ? historyContext
          : null,
        result.workspace,
        result.uiUpdate
      );
    } else if (
      historyContext &&
      result.kind === "failure" &&
      result.workspace &&
      result.committedHistoryEntryIds?.includes(historyContext.entryId)
    ) {
      ctx.rememberHistoryAfter(
        historyContext,
        result.workspace
      );
    }
    return result;
  });
}

/**
 * A structural operation to apply to a whole multi-node selection (plan Phase
 * 4.1). Mirrors the backend `BatchOp`; the caller supplies the target node set
 * separately (see {@link applyBatchCommand}).
 */
export type NotesBatchOp =
  | { type: "complete"; completed?: boolean }
  | { type: "delete" }
  | { type: "indent" }
  | { type: "outdent" }
  | { type: "duplicate" }
  | { type: "addTag"; tag: NoteSearchTag }
  | { type: "removeTag"; tag: NoteTagFilter }
  | {
      type: "move";
      parentId: NoteId | null;
      afterId: NoteId | null;
      beforeId?: NoteId | null;
    };

/**
 * Build the `notes_apply_batch` transport input for `nodeIds` (already in
 * outline order) and `op`.
 */
function buildApplyBatchInput(
  nodeIds: readonly NoteId[],
  op: NotesBatchOp
): ApplyNotesBatchInput {
  switch (op.type) {
    case "complete":
      return {
        op: "complete",
        nodeIds,
        completed: op.completed ?? false
      };
    case "delete":
      return { op: "delete", nodeIds };
    case "indent":
      return { op: "indent", nodeIds };
    case "outdent":
      return { op: "outdent", nodeIds };
    case "duplicate":
      return { op: "duplicate", nodeIds };
    case "addTag":
      return { op: "addTag", nodeIds, tag: op.tag };
    case "removeTag":
      return { op: "removeTag", nodeIds, tag: op.tag };
    case "move":
      return {
        op: "move",
        nodeIds,
        parentId: op.parentId,
        afterId: op.afterId,
        beforeId: op.beforeId ?? null
      };
  }
}

/**
 * Apply one structural operation to a whole selection as a single transaction /
 * single history entry (undo reverts the batch in one step). The command runs
 * through the same structural pipeline as the single-node commands — so it
 * reports the Phase 3.5 settlement outcome and projects the mutation into the
 * active scope. Indent/outdent retain the stable anchor/head selection while
 * the block moves; every other batch operation keeps the default pending-time
 * selection clear.
 *
 * Only ids still present in the confirmed workspace are forwarded; if none
 * survive (all vanished before the command ran) the command is skipped rather
 * than issuing an empty batch. `uiUpdate` lets a delete hand focus to a
 * surviving neighbor.
 */
export interface NotesBatchCommandSettlement {
  readonly outcome: NotesWorkspaceCommandOutcome;
  /** True once the repository returned, even if projecting the committed
   * mutation back into the active scope subsequently failed. */
  readonly mutationCommitted: boolean;
  /** Whether this command still owns survivor focus/navigation postconditions. */
  readonly navigationOwned?: boolean;
  readonly duplicatedRootIds?: readonly NoteId[];
  /** Present only when the committed mutation was successfully projected into
   * the active UI scope. Router postconditions must use this snapshot rather
   * than waiting for a React render to refresh pane refs. */
  readonly projectedWorkspace?: NormalizedNotesWorkspace;
}

function resolvedBatchOp(
  workspace: NormalizedNotesWorkspace,
  nodeIds: readonly NoteId[],
  op: NotesBatchOp
): NotesBatchOp {
  return op.type === "complete"
    ? {
        type: "complete",
        completed: nodeIds.some(
          (nodeId) => workspace.nodesById[nodeId].completedAt === null
        )
      }
    : op;
}

function isInsideSelectedForest(
  nodeId: NoteId,
  selectedIds: ReadonlySet<NoteId>,
  workspace: NormalizedNotesWorkspace
): boolean {
  const visited = new Set<NoteId>();
  let currentId: NoteId | null = nodeId;
  while (currentId !== null && !visited.has(currentId)) {
    if (selectedIds.has(currentId)) {
      return true;
    }
    visited.add(currentId);
    currentId = workspace.nodesById[currentId]?.parentId ?? null;
  }
  return false;
}

function isPreparedBatchMoveSafe(
  workspace: NormalizedNotesWorkspace,
  nodeIds: readonly NoteId[],
  op: NotesBatchOp
): boolean {
  if (op.type !== "move") {
    return true;
  }
  if (
    (op.afterId !== null && op.beforeId != null) ||
    (op.parentId !== null && workspace.nodesById[op.parentId] === undefined) ||
    (op.afterId !== null && workspace.nodesById[op.afterId] === undefined) ||
    (op.beforeId != null && workspace.nodesById[op.beforeId] === undefined)
  ) {
    return false;
  }
  const selectedIds = new Set(nodeIds);
  for (const dependencyId of [op.parentId, op.afterId, op.beforeId ?? null]) {
    if (
      dependencyId !== null &&
      isInsideSelectedForest(dependencyId, selectedIds, workspace)
    ) {
      return false;
    }
  }
  const after = op.afterId === null ? undefined : workspace.nodesById[op.afterId];
  const before =
    op.beforeId == null ? undefined : workspace.nodesById[op.beforeId];
  return (
    (after === undefined || after.parentId === op.parentId) &&
    (before === undefined || before.parentId === op.parentId)
  );
}

function sameAuthorityValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        sameAuthorityValue(value, right[index])
      )
    );
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameAuthorityValue(leftRecord[key], rightRecord[key])
    )
  );
}

function preparedSelectionOwnerIsCurrent(
  ctx: NotesCommandContext,
  prepared: NotesPreparedSelectionAuthority,
  context: NotesWorkspaceQueueContext,
  record: NotesWorkspaceSessionRecord
): boolean {
  return (
    prepared.token === ctx.selectionPreparationTokenRef.current &&
    prepared.vaultRoot === ctx.vaultRootRef.current &&
    prepared.vaultRoot === context.vaultRoot &&
    sameScope(prepared.scope, ctx.activeScopeRef.current) &&
    prepared.generation === ctx.activeWorkspaceGenerationRef.current &&
    prepared.selectionRevision === ctx.selectionRevisionRef.current &&
    prepared.session === record.session &&
    prepared.session === ctx.sessionRef.current &&
    ownerStillActive(ctx, record)
  );
}

function retainedFocusAfterNavigationLoss(
  navigation: LiveNotesNavigation,
  workspace: NotesWorkspace
): NotesHistoryFocus | null {
  const nodeId = navigation.editingNoteId;
  if (nodeId === null || !workspace.nodes.some((node) => node.id === nodeId)) {
    return null;
  }
  return {
    nodeId,
    field: navigation.pendingFocusField ?? "title"
  };
}

function settledNavigationAfterNavigationLoss(
  navigation: LiveNotesNavigation,
  editingFocus: NotesHistoryFocus | null,
  workspace: NotesWorkspace
): NotesWorkspaceUiUpdate {
  const normalized = normalizeWorkspace(workspace);
  const retained = settledUiState(normalized, navigation);
  if (editingFocus === null) {
    return retained;
  }
  const nodeId = normalized.nodesById[editingFocus.nodeId]
    ? editingFocus.nodeId
    : null;
  return {
    ...retained,
    selectedId: nodeId,
    editingNoteId: nodeId,
    // The editor already owns real DOM focus. A pending focus would replay the
    // stale command postcondition and could move the caret away again.
    pendingFocusId: null,
    pendingFocusField: null
  };
}

function projectedSettlementWorkspace(
  ctx: NotesCommandContext,
  result: Extract<NotesWorkspaceQueueResult, { kind: "authoritative" }>
): NormalizedNotesWorkspace {
  const workspace = settleWorkspaceStore(
    ctx.stateRef.current,
    result.workspace,
    result.delta
  );
  return {
    ...workspace,
    ...settledUiState(workspace, ctx.stateRef.current, result.uiUpdate)
  };
}

export async function applyBatchCommand(
  ctx: NotesCommandContext,
  nodeIds: readonly NoteId[],
  op: NotesBatchOp,
  uiUpdate?: NotesWorkspaceUiUpdate
): Promise<NotesBatchCommandSettlement> {
  const preserveSelection = op.type === "indent" || op.type === "outdent";
  let mutationCommitted = false;
  let duplicatedRootIds: readonly NoteId[] | undefined;
  let projectedWorkspace: NormalizedNotesWorkspace | undefined;
  const outcome = await ctx.runStructuralCommand(
    "batch",
    async (context, historyContext) => {
      const before = confirmedState(context);
      const ids = [...nodeIds];
      if (
        ids.length === 0 ||
        ids.some((id) => before.nodesById[id] === undefined)
      ) {
        return { kind: "skipped" };
      }
      const resolvedOp = resolvedBatchOp(before, ids, op);
      const mutation = unwrapNotesMutation(
        await context.repository.applyBatch(
          context.vaultRoot,
          buildApplyBatchInput(ids, resolvedOp),
          ...historyArguments(historyContext)
        )
      );
      mutationCommitted = true;
      duplicatedRootIds = mutation.duplicatedRootIds
        ? Object.freeze([...mutation.duplicatedRootIds])
        : undefined;
      const projection = await projectNotesMutation(
        context,
        mutation,
        ctx.activeScopeRef.current
      );
      const result = directMutationResult(mutation, projection, uiUpdate);
      if (result.kind === "authoritative") {
        projectedWorkspace = projectedSettlementWorkspace(ctx, result);
      }
      ctx.rememberHistoryAfter(
        appliedHistoryContext(historyContext, mutation),
        projection.workspace,
        uiUpdate
      );
      return result;
    },
    { selectionPolicy: preserveSelection ? "preserve" : "clear" }
  );
  return {
    outcome,
    mutationCommitted,
    ...(duplicatedRootIds ? { duplicatedRootIds } : {}),
    ...(projectedWorkspace ? { projectedWorkspace } : {})
  };
}

/**
 * Applies a frozen selected-range authority. Unlike the compatibility
 * `applyBatch` path, this refreshes the complete Active workspace inside the
 * structural queue and revalidates ownership and every target immediately
 * before the one repository mutation.
 */
export async function applyPreparedSelectionBatchCommand(
  ctx: NotesCommandContext,
  prepared: NotesPreparedSelectionAuthority,
  op: NotesBatchOp,
  uiUpdate?: NotesWorkspaceUiUpdate,
  expandNodeId?: NoteId,
  expectedNavigationVersion = ctx.navigationVersionRef.current
): Promise<NotesBatchCommandSettlement> {
  let mutationCommitted = false;
  let navigationOwned = false;
  let duplicatedRootIds: readonly NoteId[] | undefined;
  let projectedWorkspace: NormalizedNotesWorkspace | undefined;
  const outcome = await ctx.runStructuralCommand(
    "batch",
    async (context, historyContext, record) => {
      if (!preparedSelectionOwnerIsCurrent(ctx, prepared, context, record)) {
        return { kind: "skipped" };
      }
      const activeWorkspace = normalizeWorkspace(
        await context.repository.loadWorkspace(context.vaultRoot, {
          kind: "active"
        })
      );
      if (!preparedSelectionOwnerIsCurrent(ctx, prepared, context, record)) {
        return { kind: "skipped" };
      }
      const ids = [...prepared.selectedNodeIds];
      if (
        ids.length === 0 ||
        ids.some(
          (nodeId) =>
            prepared.workspace.nodesById[nodeId] === undefined ||
            activeWorkspace.nodesById[nodeId] === undefined
        ) ||
        (expandNodeId !== undefined &&
          (op.type !== "move" ||
            op.parentId !== expandNodeId ||
            prepared.workspace.nodesById[expandNodeId] === undefined ||
            activeWorkspace.nodesById[expandNodeId] === undefined)) ||
        !sameAuthorityValue(prepared.workspace, activeWorkspace) ||
        !isPreparedBatchMoveSafe(activeWorkspace, ids, op)
      ) {
        return { kind: "skipped" };
      }
      const mutation = unwrapNotesMutation(
        await context.repository.applyBatch(
          context.vaultRoot,
          buildApplyBatchInput(
            ids,
            resolvedBatchOp(activeWorkspace, ids, op)
          ),
          ...historyArguments(historyContext)
        )
      );
      mutationCommitted = true;
      duplicatedRootIds = mutation.duplicatedRootIds
        ? Object.freeze([...mutation.duplicatedRootIds])
        : undefined;
      const projection = await projectNotesMutation(
        context,
        mutation,
        ctx.activeScopeRef.current
      );
      navigationOwned =
        preparedSelectionOwnerIsCurrent(ctx, prepared, context, record) &&
        ctx.navigationVersionRef.current === expectedNavigationVersion;
      const latestNavigation = ctx.currentNavigation();
      const latestEditingFocus = ctx.currentEditingFocus();
      const settlementUiUpdate = navigationOwned
        ? uiUpdate
        : settledNavigationAfterNavigationLoss(
            latestNavigation,
            latestEditingFocus,
            projection.workspace
          );
      const result = directMutationResult(
        mutation,
        projection,
        settlementUiUpdate
      );
      if (result.kind === "authoritative") {
        projectedWorkspace = projectedSettlementWorkspace(ctx, result);
      }
      let expandedNodeIds: ReadonlySet<NoteId> | undefined;
      if (
        result.kind === "authoritative" &&
        expandNodeId !== undefined &&
        activeWorkspace.nodesById[expandNodeId].isCollapsed &&
        preparedSelectionOwnerIsCurrent(ctx, prepared, context, record)
      ) {
        const current = ctx.locallyExpandedNodeIdsRef.current;
        if (current.has(expandNodeId)) {
          expandedNodeIds = current;
        } else {
          const next = new Set(current);
          next.add(expandNodeId);
          ctx.replaceLocalExpansions(next);
          expandedNodeIds = next;
        }
      }
      ctx.rememberHistoryAfter(
        appliedHistoryContext(historyContext, mutation),
        projection.workspace,
        settlementUiUpdate,
        navigationOwned
          ? undefined
          : retainedFocusAfterNavigationLoss(
              latestNavigation,
              projection.workspace
            ),
        expandedNodeIds
      );
      return result;
    },
    { selectionPolicy: "preserve" }
  );
  // Catch a caret/navigation move that landed after projection but before the
  // structural queue settled back to the semantic command.
  navigationOwned =
    navigationOwned &&
    ctx.navigationVersionRef.current === expectedNavigationVersion;
  return {
    outcome,
    mutationCommitted,
    navigationOwned,
    ...(duplicatedRootIds ? { duplicatedRootIds } : {}),
    ...(projectedWorkspace ? { projectedWorkspace } : {})
  };
}

/**
 * Paste import (plan Phase 4.4): insert `input.nodes` as one contiguous new
 * block under `input.parentId` right after `input.afterId`. Mirrors
 * `duplicateNodeCommand` — one mutation, one history entry — except the new
 * root to focus comes straight from the backend's `importedRootIds` (set by
 * `notes_import_subtree`) rather than being inferred by diffing before/after
 * workspaces.
 */
export async function importSubtreeCommand(
  ctx: NotesCommandContext,
  input: ImportSubtreeInput
): Promise<NotesWorkspaceCommandOutcome> {
  return ctx.runStructuralCommand("import", async (context, historyContext) => {
    const before = confirmedState(context);
    if (
      (input.parentId !== null && !before.nodesById[input.parentId]) ||
      (input.afterId !== null && !before.nodesById[input.afterId])
    ) {
      return { kind: "skipped" };
    }
    const mutation = unwrapNotesMutation(
      await context.repository.importSubtree(
        context.vaultRoot,
        input,
        ...historyArguments(historyContext)
      )
    );
    const importedRootId = mutation.importedRootIds?.[0] ?? null;
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    const uiUpdate = importedRootId
      ? {
          selectedId: importedRootId,
          editingNoteId: importedRootId,
          pendingFocusId: importedRootId,
          pendingFocusField: "title" as const
        }
      : undefined;
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      projection.workspace,
      uiUpdate
    );
    return directMutationResult(mutation, projection, uiUpdate);
  });
}

export async function toggleCompleteCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId
): Promise<NotesWorkspaceCommandOutcome> {
  return ctx.runStructuralCommand("complete", async (context, historyContext) => {
    if (!confirmedState(context).nodesById[nodeId]) {
      return { kind: "skipped" };
    }
    const mutation = unwrapNotesMutation(await context.repository.toggleComplete(
      context.vaultRoot,
      nodeId,
      ...historyArguments(historyContext)
    ));
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      projection.workspace
    );
    return directMutationResult(mutation, projection);
  });
}

export async function toggleCollapsedCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId
): Promise<NotesWorkspaceCommandOutcome> {
  ctx.closeTextBurst();
  if (ctx.locallyExpandedNodeIdsRef.current.has(nodeId)) {
    const next = new Set(ctx.locallyExpandedNodeIdsRef.current);
    next.delete(nodeId);
    ctx.replaceLocalExpansions(next);
    // Collapsing a locally expanded subtree is a client-only navigation change;
    // it commits immediately without touching the write queue.
    return "committed";
  }
  return ctx.runStructuralCommand("collapse", async (context, historyContext) => {
    if (!confirmedState(context).nodesById[nodeId]) {
      return { kind: "skipped" };
    }
    const mutation = unwrapNotesMutation(await context.repository.toggleCollapsed(
      context.vaultRoot,
      nodeId,
      ...historyArguments(historyContext)
    ));
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      projection.workspace
    );
    return directMutationResult(mutation, projection);
  });
}

export async function runAtomicSubtreeCommand(
  ctx: NotesCommandContext,
  commandKind: string,
  method:
    | "expandAll"
    | "collapseAll"
    | "sortSubtreeAscending"
    | "sortSubtreeDescending",
  nodeId: NoteId,
  reconcileExpansions: boolean
): Promise<NotesWorkspaceCommandOutcome> {
  return ctx.runStructuralCommand(
    commandKind,
    async (context, historyContext) => {
      const before = confirmedState(context);
      const repositoryCommand = context.repository[method];
      if (!before.nodesById[nodeId] || !repositoryCommand) {
        return { kind: "skipped" };
      }
      const mutation = unwrapNotesMutation(
        await repositoryCommand(
          context.vaultRoot,
          nodeId,
          ...historyArguments(historyContext)
        )
      );
      const projection = await projectNotesMutation(
        context,
        mutation,
        ctx.activeScopeRef.current
      );
      const appliedContext = appliedHistoryContext(
        historyContext,
        mutation
      );
      let expandedNodeIds: ReadonlySet<NoteId> | undefined;
      if (reconcileExpansions) {
        const next = expansionsOutsideSubtree(
          ctx.locallyExpandedNodeIdsRef.current,
          mutation.workspace,
          nodeId
        );
        ctx.replaceLocalExpansions(next);
        expandedNodeIds = next;
      }
      ctx.rememberHistoryAfter(
        appliedContext,
        projection.workspace,
        undefined,
        undefined,
        expandedNodeIds
      );
      const result = directMutationResult(mutation, projection);
      return reconcileExpansions
        ? { ...result, clearLocalExpansionSubtreeId: nodeId }
        : result;
    }
  );
}

export async function toggleStarCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId
): Promise<NotesWorkspaceCommandOutcome> {
  return ctx.runStructuralCommand("star", async (context, historyContext) => {
    if (!confirmedState(context).nodesById[nodeId]) {
      return { kind: "skipped" };
    }
    const mutation = unwrapNotesMutation(await context.repository.toggleStar(
      context.vaultRoot,
      nodeId,
      ...historyArguments(historyContext)
    ));
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      projection.workspace
    );
    return directMutationResult(mutation, projection);
  });
}

export async function duplicateNodeCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId
): Promise<NotesWorkspaceCommandOutcome> {
  return ctx.runStructuralCommand("duplicate", async (context, historyContext) => {
    const before = confirmedState(context);
    if (!before.nodesById[nodeId]) {
      return { kind: "skipped" };
    }
    const mutation = unwrapNotesMutation(await context.repository.duplicateNode(
      context.vaultRoot,
      nodeId,
      ...historyArguments(historyContext)
    ));
    const duplicateId = duplicateRootId(before, mutation.workspace, nodeId);
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    const uiUpdate = duplicateId
      ? {
          selectedId: duplicateId,
          editingNoteId: duplicateId,
          pendingFocusId: duplicateId,
          pendingFocusField: "title" as const
        }
      : undefined;
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      projection.workspace,
      uiUpdate
    );
    return directMutationResult(mutation, projection, uiUpdate);
  });
}

export async function runRootLifecycle(
  ctx: NotesCommandContext,
  nodeId: NoteId,
  mutation: "archive" | "unarchive" | "trash"
): Promise<NotesWorkspaceCommandOutcome> {
  const ownerRecord = ctx.sessionRecordRef.current;
  if (!ownerRecord) {
    return "skipped";
  }
  const visibleNode = ctx.stateRef.current.nodesById[nodeId];
  if (!visibleNode || visibleNode.parentId !== null) {
    return "skipped";
  }

  const liveNavigation = ctx.currentNavigation();
  const beforeNavigation: NotesLifecycleNavigationSnapshot = {
    selectedId: liveNavigation.selectedId,
    zoomRootId: liveNavigation.zoomRootId,
    editingNoteId: liveNavigation.editingNoteId,
    pendingFocusId: liveNavigation.pendingFocusId,
    pendingFocusField: liveNavigation.pendingFocusField,
    locallyExpandedNodeIds: new Set(ctx.locallyExpandedNodeIdsRef.current),
    scope: ctx.activeScopeRef.current
  };
  const beforeNavigationVersion = ctx.navigationVersionRef.current;
  const isLifecycleOwnerActive = (): boolean =>
    ownerStillActive(ctx, ownerRecord);
  const lifecycleResult: {
    transition: NotesLifecycleNavigationTransition | null;
    recoveredToActive: boolean;
    resolvedNavigationVersion: number | null;
  } = {
    transition: null,
    recoveredToActive: false,
    resolvedNavigationVersion: null
  };

  const outcome = await ctx.runStructuralCommand(
    mutation,
    async (context, historyContext) => {
      const beforeWorkspace = confirmedState(context);
      const root = beforeWorkspace.nodesById[nodeId];
      if (!root || root.parentId !== null) {
        return { kind: "skipped" };
      }
      const mutationResult = unwrapNotesMutation(await (mutation === "archive"
        ? context.repository.archiveNode(
            context.vaultRoot,
            nodeId,
            ...historyArguments(historyContext)
          )
        : mutation === "unarchive"
          ? context.repository.unarchiveNode(
              context.vaultRoot,
              nodeId,
              ...historyArguments(historyContext)
            )
          : context.repository.softDeleteNode(
              context.vaultRoot,
              nodeId,
              ...historyArguments(historyContext)
            )));
      if (!ownerStillActive(ctx, ownerRecord)) {
        return authoritative(
          mutationResult.workspace,
          undefined,
          mutationResult.historyStatus,
          {
            scopeAgnostic: beforeNavigation.scope.kind !== "active",
            invalidatesTagSummaries: true
          }
        );
      }
      const requestedScope = ctx.activeScopeRef.current;
      let projectedWorkspace: NotesWorkspace;
      try {
        projectedWorkspace = await workspaceForScope(
          context,
          mutationResult.workspace,
          requestedScope
        );
        if (!isLifecycleOwnerActive()) {
          return authoritative(
            projectedWorkspace,
            undefined,
            mutationResult.historyStatus,
            { invalidatesTagSummaries: true }
          );
        }
      } catch {
        if (!isLifecycleOwnerActive()) {
          return authoritative(
            mutationResult.workspace,
            undefined,
            mutationResult.historyStatus,
            {
              scopeAgnostic: beforeNavigation.scope.kind !== "active",
              invalidatesTagSummaries: true
            }
          );
        }
        lifecycleResult.recoveredToActive = true;
        ctx.activeScopeRef.current = { kind: "active" };
        try {
          projectedWorkspace = await context.repository.loadWorkspace(
            context.vaultRoot,
            ctx.activeScopeRef.current
          );
          if (!isLifecycleOwnerActive()) {
            return authoritative(
              projectedWorkspace,
              undefined,
              mutationResult.historyStatus,
              { invalidatesTagSummaries: true }
            );
          }
        } catch {
          projectedWorkspace = mutationResult.workspace;
        }
      }
      if (!isLifecycleOwnerActive()) {
        return authoritative(
          projectedWorkspace,
          undefined,
          mutationResult.historyStatus,
          { invalidatesTagSummaries: true }
        );
      }
      const navigationVersion = ctx.navigationVersionRef.current;
      const latestNavigation = ctx.currentNavigation();
      const navigation =
        navigationVersion === beforeNavigationVersion
          ? beforeNavigation
          : {
              selectedId: latestNavigation.selectedId,
              zoomRootId: latestNavigation.zoomRootId,
              editingNoteId: latestNavigation.editingNoteId,
              pendingFocusId: latestNavigation.pendingFocusId,
              pendingFocusField: latestNavigation.pendingFocusField,
              locallyExpandedNodeIds: new Set(
                ctx.locallyExpandedNodeIdsRef.current
              ),
              scope: ctx.activeScopeRef.current
            };
      const transition = resolveRootLifecycleNavigation(
        beforeWorkspace,
        normalizeWorkspace(projectedWorkspace),
        nodeId,
        navigation
      );
      lifecycleResult.transition = lifecycleResult.recoveredToActive
        ? {
            before: beforeNavigation,
            after: {
              ...transition.after,
              scope: { kind: "active" }
            }
          }
        : {
            before: beforeNavigation,
            after: transition.after
          };
      lifecycleResult.resolvedNavigationVersion = navigationVersion;
      const uiUpdate = {
        selectedId: lifecycleResult.transition.after.selectedId,
        zoomRootId: lifecycleResult.transition.after.zoomRootId,
        editingNoteId: lifecycleResult.transition.after.editingNoteId,
        pendingFocusId: lifecycleResult.transition.after.pendingFocusId,
        pendingFocusField:
          lifecycleResult.transition.after.pendingFocusField
      };
      ctx.rememberHistoryAfter(
        appliedHistoryContext(historyContext, mutationResult),
        projectedWorkspace,
        uiUpdate,
        undefined,
        lifecycleResult.transition.after.locallyExpandedNodeIds
      );
      return authoritative(
        projectedWorkspace,
        uiUpdate,
        mutationResult.historyStatus,
        { invalidatesTagSummaries: true }
      );
    }
  );

  if (!ownerStillActive(ctx, ownerRecord)) {
    return outcome;
  }

  if (lifecycleResult.transition) {
    if (
      lifecycleResult.resolvedNavigationVersion ===
      ctx.navigationVersionRef.current
    ) {
      ctx.replaceLocalExpansions(
        lifecycleResult.transition.after.locallyExpandedNodeIds
      );
    }
  }
  if (lifecycleResult.recoveredToActive) {
    activateAllLibraryView(ctx);
  }
  return outcome;
}

export async function removeEmptyNodeCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId,
  focusNodeId?: NoteId | null,
  options?: NotesWorkspaceCompoundOptions
): Promise<NotesWorkspaceCommandOutcome> {
  const hadCentralDraft =
    ctx.sessionRecordRef.current?.drafts.has(nodeId) ?? false;
  const record = ctx.sessionRecordRef.current;
  const centralDraft = record?.drafts.get(nodeId);
  const hasCentralDraft = centralDraft !== undefined;
  const inlineDraft =
    hadCentralDraft || hasCentralDraft ? undefined : options?.draft;
  return ctx.runStructuralCommand(
    "remove",
    async (context, historyContext, executionRecord) => {
    if (!confirmedState(context).nodesById[nodeId]) {
      return { kind: "skipped" };
    }
    const inlineTextContext = inlineDraft
      ? ctx.beginTextEntry(executionRecord, nodeId, {
          nodeId,
          field: "title"
        })
      : null;
    const steps: NotesWorkspaceQueueStep[] = [];
    if (inlineDraft) {
      steps.push({
        historyEntryId: inlineTextContext?.entryId,
        run: async () => {
          const response = await context.repository.updateNode(
            context.vaultRoot,
            { id: nodeId, ...inlineDraft },
            ...historyArguments(inlineTextContext)
          );
          const mutation = unwrapNotesMutation(response);
          ctx.rememberHistoryAfter(
            appliedHistoryContext(inlineTextContext, mutation),
            mutation.workspace,
            undefined,
            { nodeId, field: "title" }
          );
          return response;
        }
      });
    }
    steps.push({
      historyEntryId: historyContext?.entryId,
      run: () => context.repository.removeEmptyNode(
        context.vaultRoot,
        nodeId,
        ...historyArguments(historyContext)
      )
    });
    const result = await runCompoundQueueWork(
      context,
      steps,
      focusedUiUpdate(focusNodeId),
      ctx.activeScopeRef.current
    );
    ctx.settleInlineTextEntry(executionRecord, inlineTextContext, result);
    if (result.kind === "authoritative") {
      ctx.rememberHistoryAfter(
        historyContext &&
          result.committedHistoryEntryIds?.includes(historyContext.entryId)
          ? historyContext
          : null,
        result.workspace,
        result.uiUpdate
      );
    }
    return result;
    }
  );
}

export async function deleteNodeCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId
): Promise<NotesWorkspaceCommandOutcome> {
  if (ctx.stateRef.current.nodesById[nodeId]?.parentId === null) {
    return runRootLifecycle(ctx, nodeId, "trash");
  }
  return ctx.runStructuralCommand("trash", async (context, historyContext) => {
    if (!confirmedState(context).nodesById[nodeId]) {
      return { kind: "skipped" };
    }
    const mutation = unwrapNotesMutation(await context.repository.softDeleteNode(
      context.vaultRoot,
      nodeId,
      ...historyArguments(historyContext)
    ));
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      projection.workspace
    );
    return directMutationResult(mutation, projection);
  });
}

export async function restoreNodeCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId
): Promise<NotesWorkspaceCommandOutcome> {
  ctx.closeTextBurst();
  const ownerRecord = ctx.sessionRecordRef.current;
  const beforeNavigationVersion = ctx.navigationVersionRef.current;
  const followsViewedTrashRoot =
    ctx.activeScopeRef.current.kind === "trash" &&
    rootIdForNode(
      ctx.stateRef.current,
      ctx.currentNavigation().zoomRootId
    ) === nodeId;
  let followedIntoActive = false;
  const outcome = await ctx.runStructuralCommand("restore", async (context, historyContext) => {
    const mutation = unwrapNotesMutation(await context.repository.restoreNode(
      context.vaultRoot,
      nodeId,
      ...historyArguments(historyContext)
    ));
    const canFollowIntoActive =
      followsViewedTrashRoot &&
      ownerRecord !== null &&
      ownerStillActive(ctx, ownerRecord) &&
      ctx.navigationVersionRef.current === beforeNavigationVersion &&
      ctx.activeScopeRef.current.kind === "trash";
    const nextScope: NotesWorkspaceScope = canFollowIntoActive
      ? { kind: "active" }
      : ctx.activeScopeRef.current;
    const projection = await projectNotesMutation(
      context,
      mutation,
      nextScope
    );
    const restoredNode = projection.workspace.nodes.find(
      (candidate) => candidate.id === nodeId && candidate.deletedAt === null
    );
    followedIntoActive = canFollowIntoActive && restoredNode !== undefined;
    if (followedIntoActive) {
      ctx.activeScopeRef.current = nextScope;
    }
    const uiUpdate = followedIntoActive
      ? {
          selectedId: nodeId,
          zoomRootId: nodeId,
          editingNoteId: nodeId,
          pendingFocusId: nodeId,
          pendingFocusField: "title" as const
        }
      : undefined;
    ctx.rememberHistoryAfter(
      appliedHistoryContext(historyContext, mutation),
      projection.workspace,
      uiUpdate,
      followedIntoActive ? { nodeId, field: "title" } : undefined,
      followedIntoActive ? new Set() : undefined
    );
    return directMutationResult(mutation, projection, uiUpdate);
  });
  if (
    !followedIntoActive ||
    ownerRecord === null ||
    !ownerStillActive(ctx, ownerRecord) ||
    ctx.navigationVersionRef.current !== beforeNavigationVersion
  ) {
    return outcome;
  }
  activateAllLibraryView(ctx);
  ctx.replaceLocalExpansions(new Set());
  return outcome;
}

export function emptyTrashCommand(
  ctx: NotesCommandContext
): Promise<NotesWorkspaceCommandOutcome> {
  ctx.closeTextBurst();
  const record = ctx.sessionRecordRef.current;
  if (!record) {
    return Promise.resolve("skipped");
  }
  const scope = ctx.activeScopeRef.current;
  return record.session.enqueueStructural(async (context) => {
    const workspace = await context.repository.emptyTrash(context.vaultRoot);
    record.session.history.clearSnapshots();
    const projectedWorkspace = await workspaceForScope(
      context,
      workspace,
      scope
    );
    const isOwnerActive = ownerStillActive(ctx, record);
    return authoritative(
      projectedWorkspace,
      isOwnerActive
        ? {
            selectedId: null,
            zoomRootId: null,
            editingNoteId: null,
            pendingFocusId: null,
            pendingFocusField: null
          }
        : undefined,
      undefined,
      { invalidatesTagSummaries: true }
    );
  });
}

export async function commitPreparedMoveCommand(
  ctx: NotesCommandContext,
  prepared: NotesPreparedMove,
  destinationId: NoteId | null
): Promise<NotesPreparedMoveCommitResult> {
  const staleError =
    "Notes changed while Move To was open. Refresh Move To and try again.";
  // The structural settlement (below) tells us whether the queued move reached
  // the backend; this closure variable only carries the *more specific* failure
  // reason for the two cases the three-value outcome cannot express. It no
  // longer smuggles the ok/failed verdict — that comes from the return value.
  let specificError: string | null = null;
  const settlement = await ctx.runStructuralCommand(
    "move",
    async (context, historyContext) => {
      const stale = () =>
        prepared.token !== ctx.movePreparationTokenRef.current ||
        prepared.vaultRoot !== ctx.vaultRootRef.current ||
        prepared.vaultRoot !== context.vaultRoot ||
        !sameScope(prepared.scope, ctx.activeScopeRef.current) ||
        prepared.generation !== ctx.activeWorkspaceGenerationRef.current;
      if (stale()) {
        return { kind: "skipped" };
      }

      let activeWorkspace: NotesWorkspace;
      try {
        activeWorkspace = await context.repository.loadWorkspace(
          context.vaultRoot,
          { kind: "active" }
        );
      } catch {
        specificError = "Could not refresh move destinations. Try again.";
        return { kind: "skipped" };
      }
      if (stale()) {
        return { kind: "skipped" };
      }

      const preparedNodesById = Object.fromEntries(
        prepared.nodes.map((node) => [node.id, node])
      ) as Record<NoteId, NoteNode>;
      const currentNodesById = Object.fromEntries(
        activeWorkspace.nodes.map((node) => [node.id, node])
      ) as Record<NoteId, NoteNode>;
      if (
        !samePreparedMoveNode(
          preparedNodesById[prepared.sourceId],
          currentNodesById[prepared.sourceId]
        ) ||
        (destinationId !== null &&
          !samePreparedMoveNode(
            preparedNodesById[destinationId],
            currentNodesById[destinationId]
          ))
      ) {
        return { kind: "skipped" };
      }

      const input = buildNotesMoveNodeInput(
        currentNodesById,
        prepared.sourceId,
        destinationId
      );
      if (!input) {
        return { kind: "skipped" };
      }

      let mutation: UnwrappedNotesMutation;
      try {
        mutation = unwrapNotesMutation(
          await context.repository.moveNode(
            context.vaultRoot,
            input,
            ...historyArguments(historyContext)
          )
        );
      } catch (cause) {
        specificError =
          "Move could not be completed. Refresh Move To and try again.";
        throw cause;
      }
      const projection = await projectNotesMutation(
        context,
        mutation,
        ctx.activeScopeRef.current
      );
      const appliedContext = appliedHistoryContext(
        historyContext,
        mutation
      );
      ctx.rememberHistoryAfter(
        appliedContext,
        projection.workspace,
        focusedUiUpdate(prepared.sourceId)
      );
      if (!historyContext || appliedContext) {
        ctx.movePreparationTokenRef.current += 1;
      }
      return directMutationResult(
        mutation,
        projection,
        focusedUiUpdate(prepared.sourceId)
      );
    }
  );
  if (specificError !== null) {
    return { ok: false, error: specificError };
  }
  if (settlement === "skipped") {
    return { ok: false, error: staleError };
  }
  // "committed" — or "failed" from a projection error after the backend already
  // committed the move — means the move reached the backend.
  return { ok: true };
}
