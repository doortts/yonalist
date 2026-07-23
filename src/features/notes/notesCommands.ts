import type { MutableRefObject } from "react";
import {
  createNoteId,
  isImageAtomOperationReceiptResult
} from "../../domain/notes";
import type {
  ApplyImageAtomEditInput,
  ApplyImageAtomPasteInput,
  ApplyNotesBatchInput,
  ImageAtomEdit,
  ImageAtomMutationResult,
  ImageAtomOperationReceiptResult,
  ImportSubtreeInput,
  LogicalSelection,
  MoveNoteNodeInput,
  NoteAttachment,
  NoteId,
  NoteNode,
  NoteSearchTag,
  NotesHistoryContext,
  NotesHistoryStatus,
  NotesWorkspace,
  NotesWorkspaceScope,
  NoteTagFilter
} from "../../domain/notes";
import type { ParsedImageAtomPaste } from "./notesImageAtomClipboard";
import { normalizeLogicalSelection } from "./imageAtomModel";
import { isSupportedClipboardImageMime } from "./notesClipboardImages";
import {
  notesExpansionSnapshotPool,
  type NotesHistoryFocus,
  type NotesHistorySnapshot
} from "./notesHistory";
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
import { markSplitPhase } from "./notesSplitLatencyProbe";
import {
  authoritative,
  unwrapNotesMutation,
  type UnwrappedNotesMutation
} from "./notesWorkspaceProjection";
import {
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
  samePreparedMoveNode,
  workspaceForScope
} from "./notesWorkspaceCommandSupport";
import { sameScope } from "./notesWorkspaceScope";
import type {
  LiveNotesNavigation,
  NotesLibraryView,
  NotesImageAtomCutAuthority,
  NotesImageAtomPasteAuthority,
  NotesLifecycleNavigationSnapshot,
  NotesLifecycleNavigationTransition,
  NotesPreparedMove,
  NotesPreparedMoveCommitResult,
  NotesPreparedSelectionAuthority,
  ProjectedNotesMutation,
  NotesWorkspaceCompoundOptions,
  NotesWorkspaceQueueStep,
  StructuralCommandOptions,
  TagFilterOrigin
} from "./notesWorkspaceTypes";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function imageAtomOperationMatches(
  result: ImageAtomMutationResult,
  historyContext: NotesHistoryContext
): boolean {
  return (
    result.operation.operationId === historyContext.entryId &&
    result.operation.historyEpoch === historyContext.historyEpoch &&
    result.historyEntryId === historyContext.entryId
  );
}

interface ImageAtomDirectResultExpectation {
  readonly kind: ImageAtomOperationKind;
  readonly affectedRootIds: readonly NoteId[];
  readonly focusNodeId: NoteId;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function isUtf16Boundary(title: string, offset: number): boolean {
  return !(
    offset > 0 &&
    offset < title.length &&
    title.charCodeAt(offset - 1) >= 0xd800 &&
    title.charCodeAt(offset - 1) <= 0xdbff &&
    title.charCodeAt(offset) >= 0xdc00 &&
    title.charCodeAt(offset) <= 0xdfff
  );
}

function imageAtomFocusMatchesWorkspace(
  workspace: NotesWorkspace,
  receipt: ImageAtomOperationReceiptResult
): boolean {
  const node = workspace.nodes.find(
    (candidate) =>
      candidate.id === receipt.focus.nodeId &&
      candidate.deletedAt === null &&
      candidate.archivedAt === null
  );
  if (!node) return false;
  const logicalLength = node.title.length + (node.nodeKind === "image" ? 1 : 0);
  const { anchorUtf16, focusUtf16 } = receipt.focus;
  if (
    anchorUtf16 < 0 ||
    focusUtf16 < 0 ||
    anchorUtf16 > logicalLength ||
    focusUtf16 > logicalLength
  ) {
    return false;
  }
  try {
    if (node.nodeKind === "image") {
      const normalized = normalizeLogicalSelection(node, receipt.focus);
      return (
        normalized.anchorUtf16 === anchorUtf16 &&
        normalized.focusUtf16 === focusUtf16
      );
    }
    return (
      isUtf16Boundary(node.title, anchorUtf16) &&
      isUtf16Boundary(node.title, focusUtf16)
    );
  } catch {
    return false;
  }
}

function imageAtomReceiptMatchesExpectation(
  receipt: ImageAtomOperationReceiptResult,
  historyContext: NotesHistoryContext,
  expectation: ImageAtomDirectResultExpectation
): boolean {
  return (
    receipt.operationId === historyContext.entryId &&
    receipt.historyEpoch === historyContext.historyEpoch &&
    isImageAtomOperationReceiptResult(receipt) &&
    sameIds(receipt.affectedRootIds, expectation.affectedRootIds) &&
    receipt.focus.nodeId === expectation.focusNodeId
  );
}

function sameImageAtomReceipt(
  left: ImageAtomOperationReceiptResult,
  right: ImageAtomOperationReceiptResult
): boolean {
  return (
    left.operationId === right.operationId &&
    left.historyEpoch === right.historyEpoch &&
    left.postconditionDigest === right.postconditionDigest &&
    sameIds(left.affectedRootIds, right.affectedRootIds) &&
    left.focus.nodeId === right.focus.nodeId &&
    left.focus.anchorUtf16 === right.focus.anchorUtf16 &&
    left.focus.focusUtf16 === right.focus.focusUtf16
  );
}

async function imageAtomDirectResultMatches(
  result: ImageAtomMutationResult,
  historyContext: NotesHistoryContext,
  expectation: ImageAtomDirectResultExpectation
): Promise<boolean> {
  const receipt = result.operation;
  if (
    !imageAtomOperationMatches(result, historyContext) ||
    !imageAtomReceiptMatchesExpectation(receipt, historyContext, expectation) ||
    !imageAtomFocusMatchesWorkspace(result.workspace, receipt)
  ) {
    return false;
  }
  const activeNodes = new Map(
    result.workspace.nodes
      .filter((node) => node.deletedAt === null && node.archivedAt === null)
      .map((node) => [node.id, node])
  );
  if (
    !receipt.affectedRootIds.every((id) => activeNodes.has(id)) ||
    !activeNodes.has(receipt.focus.nodeId)
  ) {
    return false;
  }
  return (
    (await imageAtomPostconditionDigest(
      result.workspace,
      receipt.affectedRootIds,
      expectation.kind
    )) === receipt.postconditionDigest
  );
}

function imageAtomFailureAfterApply(
  cause: unknown,
  workspace: NotesWorkspace,
  historyContext: NotesHistoryContext,
  historyStatus: NotesHistoryStatus | undefined
): NotesWorkspaceQueueResult {
  return {
    kind: "failure",
    error: errorMessage(cause),
    workspace,
    ...(historyStatus ? { historyStatus } : {}),
    committedHistoryEntryIds: [historyContext.entryId],
    invalidatesTagSummaries: true
  };
}

const imageAtomUnacknowledgedMessage =
  "Notes image operation could not be acknowledged. Close and reopen this Vault.";

function unresolvedImageAtomOperation(
  ctx: NotesCommandContext,
  record?: NotesWorkspaceSessionRecord,
  postAuthority?: {
    readonly workspace: NotesWorkspace;
    readonly historyContext: NotesHistoryContext;
    readonly historyStatus: NotesHistoryStatus | undefined;
  }
): NotesWorkspaceQueueResult {
  if (!record?.closing) {
    ctx.publishFeedback?.({ kind: "error", message: imageAtomUnacknowledgedMessage });
  }
  if (!postAuthority) {
    return { kind: "failure", error: imageAtomUnacknowledgedMessage };
  }
  return imageAtomFailureAfterApply(
    new Error(imageAtomUnacknowledgedMessage),
    postAuthority.workspace,
    postAuthority.historyContext,
    postAuthority.historyStatus
  );
}

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
  readonly captureHistorySnapshot: () => NotesHistorySnapshot;
  readonly resolveHistoryLocation: (
    snapshot: NotesHistorySnapshot,
    workspace?: NotesWorkspace
  ) => Promise<{
    workspace: NormalizedNotesWorkspace;
    snapshot: NotesHistorySnapshot;
  } | null>;
  readonly releaseHistorySnapshot: (snapshot: NotesHistorySnapshot) => void;
  readonly publishFeedback?: (feedback: {
    kind: "status" | "error";
    message: string;
  }) => void;
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
  readonly currentImageAtomPasteMaxDisplayWidth: () => number;
  readonly isImageAtomCutAuthorityCurrentAtQueueTurn: (
    authority: NotesImageAtomCutAuthority,
    nodeId: NoteId,
    context: NotesWorkspaceQueueContext,
    record: NotesWorkspaceSessionRecord,
    workspace: NormalizedNotesWorkspace
  ) => boolean;
  readonly isImageAtomPasteAuthorityCurrentAtQueueTurn: (
    authority: NotesImageAtomPasteAuthority,
    context: NotesWorkspaceQueueContext,
    record: NotesWorkspaceSessionRecord,
    workspace: NormalizedNotesWorkspace
  ) => boolean;
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
    expandedNodeIds?: ReadonlySet<NoteId>,
    returnedHistoryState?: NotesHistoryStatus,
    historyRejectionState?: NotesHistoryStatus
  ) => Promise<NotesWorkspaceQueueResult | null>;
  readonly settleAtomicMutation: (
    context: NotesHistoryContext | null | undefined,
    mutation: UnwrappedNotesMutation,
    projection: ProjectedNotesMutation,
    options?: {
      uiUpdate?: NotesWorkspaceUiUpdate;
      focus?: NotesHistoryFocus | null;
      expandedNodeIds?: ReadonlySet<NoteId>;
      requestedLocation?: NotesHistorySnapshot;
      recoveryLocation?: NotesHistorySnapshot;
      recoverySource?: Pick<
        NotesWorkspaceSessionRecord,
        "repository" | "vaultRoot"
      >;
      applyToCurrentOwner?: boolean;
    }
  ) => Promise<NotesWorkspaceQueueResult | null>;
  readonly consumeRecoveredHistoryResult: (entryId: string) => void;
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

function imageAtomUiUpdate(
  receipt: ImageAtomOperationReceiptResult
): NotesWorkspaceUiUpdate {
  return {
    selectedId: receipt.focus.nodeId,
    editingNoteId: receipt.focus.nodeId,
    pendingFocusId: receipt.focus.nodeId,
    pendingFocusField: "title"
  };
}

function receiptMatchesHistory(
  receipt: ImageAtomOperationReceiptResult,
  historyContext: NotesHistoryContext
): boolean {
  return (
    receipt.operationId === historyContext.entryId &&
    receipt.historyEpoch === historyContext.historyEpoch
  );
}

type ImageAtomOperationKind = "edit" | "paste";
type ImageAtomPasteFragmentItem = ApplyImageAtomPasteInput["fragment"][number];
type ImageAtomPasteImageItem = Extract<
  ImageAtomPasteFragmentItem,
  { readonly kind: "image" }
>;

/**
 * The operation's target authority is deliberately captured before enqueueing
 * the backend work. It contains metadata only (never clipboard bytes) and is
 * used only if the history generation disappears while acknowledgement is in
 * flight: a reload can then distinguish the exact pre-state from an
 * indeterminate third state without ever reissuing the mutation.
 */
interface ImageAtomPreAuthority {
  readonly rootId: NoteId;
  readonly kind: ImageAtomOperationKind;
  readonly expectedUpdatedAt: string;
  readonly subtreeDigest: string;
  readonly generatedNodeIds: readonly NoteId[];
  readonly generatedAttachmentIds: readonly string[];
}

async function captureImageAtomPreAuthority(
  workspace: NotesWorkspace,
  node: NoteNode,
  kind: ImageAtomOperationKind,
  generatedNodeIds: readonly NoteId[],
  generatedAttachmentIds: readonly string[]
): Promise<ImageAtomPreAuthority | null> {
  const subtreeDigest = await imageAtomPostconditionDigest(workspace, [node.id], kind);
  if (!subtreeDigest) return null;
  return {
    rootId: node.id,
    kind,
    expectedUpdatedAt: node.updatedAt,
    subtreeDigest,
    generatedNodeIds: [...generatedNodeIds],
    generatedAttachmentIds: [...generatedAttachmentIds]
  };
}

async function matchesImageAtomPreAuthority(
  workspace: NotesWorkspace,
  authority: ImageAtomPreAuthority
): Promise<boolean> {
  const node = workspace.nodes.find((candidate) => candidate.id === authority.rootId);
  if (node?.updatedAt !== authority.expectedUpdatedAt) return false;
  const nodeIds = new Set(workspace.nodes.map((candidate) => candidate.id));
  if (authority.generatedNodeIds.some((id) => nodeIds.has(id))) return false;
  const attachmentIds = new Set(
    Object.values(workspace.attachmentsByNodeId ?? {}).flatMap((attachments) =>
      attachments.map((attachment) => attachment.id)
    )
  );
  return (
    !authority.generatedAttachmentIds.some((id) => attachmentIds.has(id)) &&
    (await imageAtomPostconditionDigest(
      workspace,
      [authority.rootId],
      authority.kind
    )) === authority.subtreeDigest
  );
}

function compareOrdinalStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function imageAtomPasteIsInPlace(
  source: NoteNode,
  selection: LogicalSelection
): boolean {
  if (source.nodeKind === "text") return true;
  const start = Math.min(selection.anchorUtf16, selection.focusUtf16);
  const end = Math.max(selection.anchorUtf16, selection.focusUtf16);
  return start <= source.imageOffsetUtf16 && end > source.imageOffsetUtf16;
}

function imageAtomAttachmentAuthority(attachment: NoteAttachment): object {
  return {
    id: attachment.id,
    nodeId: attachment.nodeId,
    sortKey: attachment.sortKey,
    relativePath: attachment.relativePath,
    contentHash: attachment.contentHash,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    intrinsicWidth: attachment.intrinsicWidth,
    intrinsicHeight: attachment.intrinsicHeight,
    displayWidth: attachment.displayWidth,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt
  };
}

function sameImageAtomTargetAuthority(
  expected: NoteNode,
  expectedAttachments: readonly NoteAttachment[],
  activeWorkspace: NotesWorkspace
): boolean {
  const active = activeWorkspace.nodes.find((node) => node.id === expected.id);
  if (
    !active ||
    active.nodeKind !== expected.nodeKind ||
    active.updatedAt !== expected.updatedAt ||
    active.title !== expected.title ||
    active.imageOffsetUtf16 !== expected.imageOffsetUtf16
  ) {
    return false;
  }
  const activeAttachments = activeWorkspace.attachmentsByNodeId?.[expected.id] ?? [];
  return (
    activeAttachments.length === expectedAttachments.length &&
    JSON.stringify(activeAttachments.map(imageAtomAttachmentAuthority)) ===
      JSON.stringify(expectedAttachments.map(imageAtomAttachmentAuthority))
  );
}

async function workspaceForImageAtomPreAuthority(
  context: NotesWorkspaceQueueContext,
  confirmedWorkspace: NormalizedNotesWorkspace,
  source: NoteNode,
  attachments: readonly NoteAttachment[]
): Promise<NotesWorkspace | null> {
  const confirmed = imageAtomWorkspaceFromRecoveredPresentation(confirmedWorkspace);
  if (context.sourceScope.kind === "active") return confirmed;
  try {
    const active = await context.repository.loadWorkspace(context.vaultRoot, {
      kind: "active"
    });
    return sameImageAtomTargetAuthority(source, attachments, active) ? active : null;
  } catch {
    return null;
  }
}

function compareBySortKeyAndId(
  left: { sortKey: number; id: string },
  right: { sortKey: number; id: string }
): number {
  return left.sortKey - right.sortKey || compareOrdinalStrings(left.id, right.id);
}

export async function imageAtomPostconditionDigest(
  workspace: NotesWorkspace,
  affectedRootIds: readonly NoteId[],
  kind: ImageAtomOperationKind
): Promise<string | null> {
  const nodes: NoteNode[] = [];
  const nodesById = new Map<NoteId, (typeof nodes)[number]>();
  const childrenByParent = new Map<NoteId, (typeof nodes)[number][]>();
  const workspaceIndexes = new Map<NoteId, number>();
  for (const [index, node] of workspace.nodes.entries()) {
    if (node.deletedAt !== null || node.archivedAt !== null) continue;
    nodes.push(node);
    if (nodesById.has(node.id)) return null;
    nodesById.set(node.id, node);
    workspaceIndexes.set(node.id, index);
    if (node.parentId !== null) {
      const children = childrenByParent.get(node.parentId) ?? [];
      children.push(node);
      childrenByParent.set(node.parentId, children);
    }
  }
  for (const children of childrenByParent.values()) {
    children.sort(compareBySortKeyAndId);
  }
  const roots = affectedRootIds.map((id) => nodesById.get(id) ?? null);
  if (roots.some((node) => node === null)) return null;
  const orderedRoots = roots as (typeof nodes)[number][];
  if (kind === "edit") {
    orderedRoots.sort(
      (left, right) =>
        (workspaceIndexes.get(left.id) ?? 0) -
        (workspaceIndexes.get(right.id) ?? 0)
    );
  }
  const pending = [...orderedRoots].reverse();
  const seen = new Set<NoteId>();
  const projection: unknown[] = [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    const attachments = [...(workspace.attachmentsByNodeId?.[node.id] ?? [])]
      .sort(compareBySortKeyAndId)
      .map((attachment) => ({
        id: attachment.id,
        node_id: attachment.nodeId,
        sort_key: attachment.sortKey,
        relative_path: attachment.relativePath,
        content_hash: attachment.contentHash,
        original_name: attachment.originalName,
        mime_type: attachment.mimeType,
        byte_size: attachment.byteSize,
        intrinsic_width: attachment.intrinsicWidth,
        intrinsic_height: attachment.intrinsicHeight,
        display_width: attachment.displayWidth
      }));
    projection.push({
      id: node.id,
      parent_id: node.parentId,
      sort_key: node.sortKey,
      node_kind: node.nodeKind,
      title: node.title,
      note: node.note,
      image_offset_utf16: node.imageOffsetUtf16,
      layout_mode: node.layoutMode,
      is_collapsed: node.isCollapsed,
      is_starred: node.isStarred,
      completed_at: node.completedAt,
      attachments
    });
    const children = childrenByParent.get(node.id);
    if (children) pending.push(...[...children].reverse());
  }
  const domain =
    kind === "edit"
      ? "notes-image-atom-postcondition-v1"
      : "notes-image-atom-paste-postcondition-v1";
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([domain, projection]))
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  } catch {
    return null;
  }
}

interface ImageAtomAcknowledgementAuthority {
  readonly record: NotesWorkspaceSessionRecord;
  readonly kind: ImageAtomOperationKind;
  readonly preAuthority: ImageAtomPreAuthority;
  readonly directExpectation: ImageAtomDirectResultExpectation;
  /** A lookup already established this receipt before its acknowledgement. */
  readonly lookupDerived?: true;
}

function imageAtomWorkspaceFromRecoveredPresentation(
  workspace: NormalizedNotesWorkspace
): NotesWorkspace {
  return {
    nodes: Object.values(workspace.nodesById),
    attachmentsByNodeId: workspace.attachmentsByNodeId
  };
}

function historyLossState(historyContext: NotesHistoryContext): NotesHistoryStatus {
  return {
    canUndo: false,
    canRedo: false,
    historyEpoch: historyContext.historyEpoch,
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
  };
}

function hasPostconditionDigest(receipt: ImageAtomOperationReceiptResult): boolean {
  return /^[0-9a-f]{64}$/.test(receipt.postconditionDigest);
}

/**
 * A history-generation loss is never retried. The coordinator resets its
 * history and reloads active rows once; only a digest which validates both the
 * direct response and the reload can prove the post-state. The frozen target
 * authority can prove the pre-state, while every other reload remains
 * deliberately ambiguous.
 */
async function recoverImageAtomHistoryGeneration(
  ctx: NotesCommandContext,
  context: NotesWorkspaceQueueContext,
  historyContext: NotesHistoryContext,
  authority: ImageAtomAcknowledgementAuthority,
  knownPost: {
    readonly receipt: ImageAtomOperationReceiptResult;
    readonly workspace: NotesWorkspace;
  } | null
): Promise<NotesWorkspaceQueueResult> {
  const location = ctx.captureHistorySnapshot();
  let reloadedWorkspace: NotesWorkspace | null = null;
  try {
    const recovered = await (
      authority.record.session as NotesWorkspaceCoordinatorSession
    ).recoverHistoryMismatch(
      historyLossState(historyContext),
      async () => {
        reloadedWorkspace = await context.repository.loadWorkspace(context.vaultRoot, {
          kind: "active"
        });
        const resolved = await ctx.resolveHistoryLocation(location, reloadedWorkspace);
        if (!resolved) {
          throw new Error("Notes image operation could not reload its history location.");
        }
        return resolved;
      }
    );
    if (!recovered || !reloadedWorkspace) {
      ctx.publishFeedback?.({
        kind: "error",
        message:
          "Notes image operation history could not be synchronized. Close and reopen this Vault."
      });
      return {
        kind: "failure",
        error:
          "Notes image operation history could not be synchronized. Close and reopen this Vault."
      };
    }
    const recoveredWorkspace = imageAtomWorkspaceFromRecoveredPresentation(
      recovered.workspace
    );
    const matchesKnownPost =
      knownPost !== null &&
      receiptMatchesHistory(knownPost.receipt, historyContext) &&
      hasPostconditionDigest(knownPost.receipt) &&
      (await imageAtomPostconditionDigest(
        knownPost.workspace,
        knownPost.receipt.affectedRootIds,
        authority.kind
      )) === knownPost.receipt.postconditionDigest &&
      (await imageAtomPostconditionDigest(
        reloadedWorkspace,
        knownPost.receipt.affectedRootIds,
        authority.kind
      )) === knownPost.receipt.postconditionDigest;
    if (matchesKnownPost) {
      ctx.publishFeedback?.({
        kind: "status",
        message: "Notes image operation history was reset after acknowledgement loss."
      });
      return authoritative(recoveredWorkspace, imageAtomUiUpdate(knownPost!.receipt), undefined, {
        invalidatesTagSummaries: true
      });
    }
    const matchesPreAuthority = await matchesImageAtomPreAuthority(
      reloadedWorkspace,
      authority.preAuthority
    );
    const error = matchesPreAuthority
      ? "Notes image operation acknowledgement lost its history generation; the active workspace is still the exact pre-state."
      : "Notes image operation acknowledgement lost its history generation and the active workspace is ambiguous.";
    ctx.publishFeedback?.({ kind: "error", message: error });
    return {
      kind: "failure",
      workspace: recoveredWorkspace,
      error,
      invalidatesTagSummaries: true
    };
  } finally {
    ctx.releaseHistorySnapshot(location);
  }
}

async function reconcileImageAtomAcknowledgementFailure(
  ctx: NotesCommandContext,
  context: NotesWorkspaceQueueContext,
  historyContext: NotesHistoryContext,
  receipt: ImageAtomOperationReceiptResult,
  mutation: UnwrappedNotesMutation,
  projection: ProjectedNotesMutation,
  uiUpdate: NotesWorkspaceUiUpdate,
  authority: ImageAtomAcknowledgementAuthority
): Promise<NotesWorkspaceQueueResult> {
  const failedAcknowledgement = (): NotesWorkspaceQueueResult =>
    unresolvedImageAtomOperation(ctx, authority.record, {
      workspace: projection.workspace,
      historyContext,
      historyStatus: mutation.historyStatus
    });
  const lookup = async () => {
    return context.repository.lookupImageAtomOperation(
      context.vaultRoot,
      historyContext.sessionId,
      historyContext.historyEpoch,
      historyContext.entryId
    );
  };
  let firstLookup;
  try {
    firstLookup = await lookup();
  } catch {
    return failedAcknowledgement();
  }
  if (
    firstLookup.kind === "epochMismatch" ||
    (firstLookup.kind === "missing" &&
      firstLookup.historyEpoch !== historyContext.historyEpoch)
  ) {
    return recoverImageAtomHistoryGeneration(
      ctx,
      context,
      historyContext,
      authority,
      { receipt, workspace: mutation.workspace }
    );
  }
  if (!ownerStillActive(ctx, authority.record)) {
    if (firstLookup.kind === "missing") {
      return directMutationResult(mutation, projection, uiUpdate);
    }
    return failedAcknowledgement();
  }
  if (
    firstLookup.kind !== "found" ||
    !sameImageAtomReceipt(firstLookup.receipt, receipt)
  ) {
    if (firstLookup.kind === "missing") {
      return directMutationResult(mutation, projection, uiUpdate);
    }
    return failedAcknowledgement();
  }
  try {
    await context.repository.ackImageAtomOperation(
      context.vaultRoot,
      historyContext.sessionId,
      historyContext.historyEpoch,
      historyContext.entryId
    );
    return directMutationResult(mutation, projection, uiUpdate);
  } catch {
    let finalLookup;
    try {
      finalLookup = await lookup();
    } catch {
      return failedAcknowledgement();
    }
    if (
      finalLookup.kind === "epochMismatch" ||
      (finalLookup.kind === "missing" &&
        finalLookup.historyEpoch !== historyContext.historyEpoch)
    ) {
      return recoverImageAtomHistoryGeneration(
        ctx,
        context,
        historyContext,
        authority,
        { receipt, workspace: mutation.workspace }
      );
    }
    if (finalLookup.kind === "missing") {
      return directMutationResult(mutation, projection, uiUpdate);
    }
    return failedAcknowledgement();
  }
}

async function settleImageAtomMutation(
  ctx: NotesCommandContext,
  context: NotesWorkspaceQueueContext,
  historyContext: NotesHistoryContext,
  receipt: ImageAtomOperationReceiptResult,
  mutation: UnwrappedNotesMutation,
  acknowledgementAuthority?: ImageAtomAcknowledgementAuthority
): Promise<NotesWorkspaceQueueResult> {
  const projection = await projectNotesMutation(
    context,
    mutation,
    ctx.activeScopeRef.current
  );
  const uiUpdate = imageAtomUiUpdate(receipt);
  const settlement = await ctx.settleAtomicMutation(
    historyContext,
    mutation,
    projection,
    {
      uiUpdate,
      focus: {
        nodeId: receipt.focus.nodeId,
        field: "title",
        primarySelection: {
          anchorUtf16: receipt.focus.anchorUtf16,
          focusUtf16: receipt.focus.focusUtf16
        }
      },
      applyToCurrentOwner: true
    }
  );
  if (settlement) return settlement;
  try {
    await context.repository.ackImageAtomOperation(
      context.vaultRoot,
      historyContext.sessionId,
      historyContext.historyEpoch,
      historyContext.entryId
    );
  } catch (cause) {
    if (acknowledgementAuthority) {
      if (
        acknowledgementAuthority.lookupDerived &&
        !ownerStillActive(ctx, acknowledgementAuthority.record)
      ) {
        return unresolvedImageAtomOperation(ctx, acknowledgementAuthority.record, {
          workspace: projection.workspace,
          historyContext,
          historyStatus: mutation.historyStatus
        });
      }
      return reconcileImageAtomAcknowledgementFailure(
        ctx,
        context,
        historyContext,
        receipt,
        mutation,
        projection,
        uiUpdate,
        acknowledgementAuthority
      );
    }
    return imageAtomFailureAfterApply(
      cause,
      projection.workspace,
      historyContext,
      mutation.historyStatus
    );
  }
  return directMutationResult(mutation, projection, uiUpdate);
}

async function materializeImageAtomReceipt(
  ctx: NotesCommandContext,
  context: NotesWorkspaceQueueContext,
  historyContext: NotesHistoryContext,
  receipt: ImageAtomOperationReceiptResult,
  acknowledgementAuthority: ImageAtomAcknowledgementAuthority
): Promise<NotesWorkspaceQueueResult> {
  if (!receiptMatchesHistory(receipt, historyContext)) {
    return unresolvedImageAtomOperation(ctx, acknowledgementAuthority.record);
  }
  if (
    !imageAtomReceiptMatchesExpectation(
      receipt,
      historyContext,
      acknowledgementAuthority.directExpectation
    )
  ) {
    return unresolvedImageAtomOperation(ctx, acknowledgementAuthority.record);
  }
  let workspace: NotesWorkspace;
  try {
    workspace = await context.repository.loadWorkspace(context.vaultRoot, {
      kind: "active"
    });
  } catch {
    return unresolvedImageAtomOperation(ctx, acknowledgementAuthority.record);
  }
  if (!context.repository.historyStatus) {
    return unresolvedImageAtomOperation(ctx, acknowledgementAuthority.record);
  }
  let historyStatus: NotesHistoryStatus;
  try {
    historyStatus = await context.repository.historyStatus(
      context.vaultRoot,
      historyContext.sessionId
    );
  } catch {
    return unresolvedImageAtomOperation(ctx, acknowledgementAuthority.record);
  }
  if (
    historyStatus.historyEpoch !== historyContext.historyEpoch ||
    historyStatus.canUndo !== true ||
    historyStatus.canRedo !== false ||
    historyStatus.nextUndoEntryId !== historyContext.entryId ||
    historyStatus.nextRedoEntryId !== null
  ) {
    return unresolvedImageAtomOperation(ctx, acknowledgementAuthority.record);
  }
  if (
    (await imageAtomPostconditionDigest(
      workspace,
      receipt.affectedRootIds,
      acknowledgementAuthority.kind
    )) !== receipt.postconditionDigest
  ) {
    return unresolvedImageAtomOperation(ctx, acknowledgementAuthority.record);
  }
  if (!imageAtomFocusMatchesWorkspace(workspace, receipt)) {
    return unresolvedImageAtomOperation(ctx, acknowledgementAuthority.record);
  }
  const mutation = unwrapNotesMutation(
    {
      workspace,
      historyEntryId: historyContext.entryId,
      ...historyStatus
    }
  );
  return settleImageAtomMutation(
    ctx,
    context,
    historyContext,
    receipt,
    mutation,
    { ...acknowledgementAuthority, lookupDerived: true }
  );
}

async function applyImageAtomMutation(
  ctx: NotesCommandContext,
  context: NotesWorkspaceQueueContext,
  historyContext: NotesHistoryContext | null,
  record: NotesWorkspaceSessionRecord,
  kind: ImageAtomOperationKind,
  preAuthority: ImageAtomPreAuthority,
  directExpectation: ImageAtomDirectResultExpectation,
  send: (history: NotesHistoryContext) => Promise<ImageAtomMutationResult>
): Promise<NotesWorkspaceQueueResult> {
  if (!historyContext) {
    return { kind: "failure", error: "Notes image operation history is unavailable." };
  }
  const settleDirect = async (
    result: ImageAtomMutationResult
  ): Promise<NotesWorkspaceQueueResult> => {
    if (
      !(await imageAtomDirectResultMatches(
        result,
        historyContext,
        directExpectation
      ))
    ) {
      return unresolvedImageAtomOperation(ctx, record);
    }
    const { operation, ...response } = result;
    return settleImageAtomMutation(
      ctx,
      context,
      historyContext,
      operation,
      unwrapNotesMutation(response),
      { record, kind, preAuthority, directExpectation }
    );
  };
  const reconcileUnknown = async (
    retried: boolean
  ): Promise<NotesWorkspaceQueueResult> => {
    let lookup;
    try {
      lookup = await context.repository.lookupImageAtomOperation(
        context.vaultRoot,
        historyContext.sessionId,
        historyContext.historyEpoch,
        historyContext.entryId
      );
    } catch {
      return unresolvedImageAtomOperation(ctx, record);
    }
    if (lookup.kind === "found") {
      return materializeImageAtomReceipt(
        ctx,
        context,
        historyContext,
        lookup.receipt,
        { record, kind, preAuthority, directExpectation }
      );
    }
    if (
      lookup.kind === "epochMismatch" ||
      (lookup.kind === "missing" && lookup.historyEpoch !== historyContext.historyEpoch)
    ) {
      return recoverImageAtomHistoryGeneration(
        ctx,
        context,
        historyContext,
        { record, kind, preAuthority, directExpectation },
        null
      );
    }
    if (
      lookup.kind === "missing" &&
      lookup.historyEpoch === historyContext.historyEpoch &&
      retried
    ) {
      return {
        kind: "failure",
        error: "Notes image operation did not commit after its one retry."
      };
    }
    if (
      lookup.kind === "missing" &&
      lookup.historyEpoch === historyContext.historyEpoch &&
      !retried &&
      ownerStillActive(ctx, record)
    ) {
      let retryResult: ImageAtomMutationResult;
      try {
        retryResult = await send(historyContext);
      } catch {
        return reconcileUnknown(true);
      }
      try {
        return await settleDirect(retryResult);
      } catch {
        return unresolvedImageAtomOperation(ctx, record);
      }
    }
    return unresolvedImageAtomOperation(ctx, record);
  };
  let directResult: ImageAtomMutationResult;
  try {
    directResult = await send(historyContext);
  } catch {
    return reconcileUnknown(false);
  }
  try {
    return await settleDirect(directResult);
  } catch {
    return unresolvedImageAtomOperation(ctx, record);
  }
}

export function applyImageAtomEditCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId,
  selection: LogicalSelection,
  edit: ImageAtomEdit,
  cutAuthority?: NotesImageAtomCutAuthority
): Promise<NotesWorkspaceCommandOutcome> {
  const frozenSelection = { ...selection };
  const frozenEdit =
    edit.kind === "remove"
      ? { kind: "remove" as const, replacementText: edit.replacementText }
      : { kind: "enter" as const, siblingId: edit.siblingId };
  return ctx.runStructuralCommand(
    "imageAtomEdit",
    async (context, historyContext, record) => {
      const workspace = confirmedState(context);
      if (
        cutAuthority &&
        (frozenEdit.kind !== "remove" ||
          !ctx.isImageAtomCutAuthorityCurrentAtQueueTurn(
            cutAuthority,
            nodeId,
            context,
            record,
            workspace
          ))
      ) {
        return { kind: "skipped" };
      }
      const source = workspace.nodesById[nodeId];
      const attachments = workspace.attachmentsByNodeId[nodeId] ?? [];
      if (source?.nodeKind !== "image" || attachments.length !== 1) {
        return { kind: "skipped" };
      }
      const input: ApplyImageAtomEditInput = {
        target: {
          nodeId,
          expectedUpdatedAt: source.updatedAt,
          expectedTitle: source.title,
          expectedImageOffsetUtf16: source.imageOffsetUtf16,
          expectedPrimaryAttachmentId: attachments[0]!.id
        },
        selection: normalizeLogicalSelection(source, frozenSelection),
        edit: frozenEdit
      };
      const preWorkspace = await workspaceForImageAtomPreAuthority(
        context,
        workspace,
        source,
        attachments
      );
      if (!preWorkspace) {
        return {
          kind: "failure",
          error: "Notes image operation active precondition could not be verified."
        };
      }
      const preAuthority = await captureImageAtomPreAuthority(
        preWorkspace,
        source,
        "edit",
        frozenEdit.kind === "enter" ? [frozenEdit.siblingId] : [],
        []
      );
      if (!preAuthority) {
        return {
          kind: "failure",
          error: "Notes image operation could not establish its precondition."
        };
      }
      if (
        cutAuthority &&
        !ctx.isImageAtomCutAuthorityCurrentAtQueueTurn(
          cutAuthority,
          nodeId,
          context,
          record,
          confirmedState(context)
        )
      ) {
        return { kind: "skipped" };
      }
      return applyImageAtomMutation(
        ctx,
        context,
        historyContext,
        record,
        "edit",
        preAuthority,
        {
          kind: "edit",
          affectedRootIds:
            frozenEdit.kind === "enter"
              ? [nodeId, frozenEdit.siblingId]
              : [nodeId],
          focusNodeId:
            frozenEdit.kind === "enter" ? frozenEdit.siblingId : nodeId
        },
        (history) =>
          context.repository.applyImageAtomEdit(
            context.vaultRoot,
            input,
            ...historyArguments(history)
          )
      );
    },
    {
      selectionPolicy: "preserve",
      historyFocus: {
        nodeId,
        field: "title",
        primarySelection: { ...frozenSelection }
      }
    }
  );
}

function freezeImageAtomPasteFragment(
  fragment: ParsedImageAtomPaste
): ImageAtomPasteFragmentItem[] | null {
  const imageIds = fragment.fragment
    .filter((item) => item.kind === "image")
    .map(() => ({ nodeId: createNoteId(), attachmentId: createNoteId() }));
  const frozen: ImageAtomPasteFragmentItem[] = [];
  let imageIndex = 0;
  for (const item of fragment.fragment) {
    if (item.kind === "text") {
      frozen.push({ kind: "text", text: item.text });
      continue;
    }
    const ids = imageIds[imageIndex++];
    if (!ids || !isSupportedClipboardImageMime(item.source.mimeType)) {
      return null;
    }
    frozen.push({
      kind: "image",
      nodeId: ids.nodeId,
      attachmentId: ids.attachmentId,
      originalName: item.source.originalName,
      mimeType: item.source.mimeType,
      blob: item.source.blob
    });
  }
  return frozen;
}

export function applyImageAtomPasteCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId,
  selection: LogicalSelection,
  fragment: ParsedImageAtomPaste,
  authority?: NotesImageAtomPasteAuthority
): Promise<NotesWorkspaceCommandOutcome> {
  const frozenSelection = { ...selection };
  const frozenFragment = freezeImageAtomPasteFragment(fragment);
  return ctx.runStructuralCommand(
    "imageAtomPaste",
    async (context, historyContext, record) => {
      if (
        frozenFragment === null ||
        !frozenFragment.some((item) => item.kind === "image")
      ) {
        return {
          kind: "failure",
          error: "Notes image atom paste requires at least one supported image."
        };
      }
      const workspace = confirmedState(context);
      if (
        authority &&
        !ctx.isImageAtomPasteAuthorityCurrentAtQueueTurn(
          authority,
          context,
          record,
          workspace
        )
      ) {
        return { kind: "skipped" };
      }
      const source = workspace.nodesById[nodeId];
      const attachments = workspace.attachmentsByNodeId[nodeId] ?? [];
      const initialMaxDisplayWidth = ctx.currentImageAtomPasteMaxDisplayWidth();
      if (
        !source ||
        (source.nodeKind !== "text" && source.nodeKind !== "image") ||
        (source.nodeKind === "image" && attachments.length !== 1) ||
        (source.nodeKind === "text" && attachments.length !== 0) ||
        !Number.isSafeInteger(initialMaxDisplayWidth) ||
        initialMaxDisplayWidth <= 0
      ) {
        return { kind: "skipped" };
      }
      const normalizedSelection =
        source.nodeKind === "image"
          ? normalizeLogicalSelection(source, frozenSelection)
          : frozenSelection;
      const inPlace = imageAtomPasteIsInPlace(source, normalizedSelection);
      let imageIndex = 0;
      const inputFragment: ImageAtomPasteFragmentItem[] = [];
      for (const item of frozenFragment) {
        if (item.kind !== "image") {
          inputFragment.push(item);
          continue;
        }
        const fragmentNodeId =
          inPlace && imageIndex === 0 ? source.id : item.nodeId;
        imageIndex += 1;
        inputFragment.push({ ...item, nodeId: fragmentNodeId });
      }
      const input: ApplyImageAtomPasteInput = {
        target: {
          nodeId,
          expectedUpdatedAt: source.updatedAt,
          expectedNodeKind: source.nodeKind,
          expectedTitle: source.title,
          expectedImageOffsetUtf16: source.imageOffsetUtf16,
          expectedPrimaryAttachmentId:
            source.nodeKind === "image" ? attachments[0]!.id : null
        },
        selection: normalizedSelection,
        version: 1,
        fragment: inputFragment,
        initialMaxDisplayWidth
      };
      const generatedImages = inputFragment.filter(
        (item): item is ImageAtomPasteImageItem => item.kind === "image"
      );
      const firstGeneratedImage = generatedImages[0];
      if (!firstGeneratedImage) {
        return {
          kind: "failure",
          error: "Notes image atom paste requires at least one supported image."
        };
      }
      const preWorkspace = await workspaceForImageAtomPreAuthority(
        context,
        workspace,
        source,
        attachments
      );
      if (!preWorkspace) {
        return {
          kind: "failure",
          error: "Notes image operation active precondition could not be verified."
        };
      }
      const preAuthority = await captureImageAtomPreAuthority(
        preWorkspace,
        source,
        "paste",
        generatedImages
          .map((item) => item.nodeId)
          .filter((generatedNodeId) => generatedNodeId !== source.id),
        generatedImages.map((item) => item.attachmentId)
      );
      if (!preAuthority) {
        return {
          kind: "failure",
          error: "Notes image operation could not establish its precondition."
        };
      }
      return applyImageAtomMutation(
        ctx,
        context,
        historyContext,
        record,
        "paste",
        preAuthority,
        {
          kind: "paste",
          affectedRootIds: generatedImages.map((item) => item.nodeId),
          focusNodeId: firstGeneratedImage.nodeId
        },
        (history) =>
          context.repository.applyImageAtomPaste(
            context.vaultRoot,
            input,
            ...historyArguments(history)
          )
      );
    },
    {
      selectionPolicy: "preserve",
      historyFocus: {
        nodeId,
        field: "title",
        primarySelection: { ...frozenSelection }
      }
    }
  );
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
    const commandLocation = ctx.captureHistorySnapshot();
    try {
      const mutation = unwrapNotesMutation(await context.repository.createNode(
        context.vaultRoot,
        {
          id,
          parentId: null,
          afterId: before.rootIds.at(-1) ?? null,
          title: "",
          note: "",
          markerKind: "bullet"
        },
        ...historyArguments(historyContext)
      ));
      const uiUpdate = {
        selectedId: id,
        editingNoteId: id,
        pendingFocusId: id,
        pendingFocusField: "title" as const,
        zoomRootId: null
      };
      const requestedLocation: NotesHistorySnapshot = {
        ...commandLocation,
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: id,
        zoomRootId: null,
        expansion: notesExpansionSnapshotPool.acquire(
          transitionToAll ? [] : commandLocation.expansion.nodeIds
        ),
        focus: { nodeId: id, field: "title" },
        tagFilterOrigin: null
      };
      const projection = { workspace: mutation.workspace };
      try {
        const settlement = await ctx.settleAtomicMutation(
          historyContext,
          mutation,
          projection,
          {
            uiUpdate,
            expandedNodeIds: transitionToAll
              ? new Set()
              : new Set(commandLocation.expansion.nodeIds),
            requestedLocation,
            recoveryLocation: commandLocation
          }
        );
        if (settlement) return settlement;
        if (ownerStillActive(ctx, ownerRecord)) {
          created = true;
          creation.record = ownerRecord;
          ctx.activeScopeRef.current = { kind: "active" };
        }
        return directMutationResult(mutation, projection, uiUpdate);
      } finally {
        ctx.releaseHistorySnapshot(requestedLocation);
      }
    } finally {
      ctx.releaseHistorySnapshot(commandLocation);
    }
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

export type NotesChildPlacement = "first" | "last";

export async function createChildCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId,
  placement: NotesChildPlacement = "last"
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
      if (!ownerStillActive(ctx, ownerRecord) || !before.nodesById[nodeId]) {
        return { kind: "skipped" };
      }
      const id = createNoteId();
      const firstChildId = before.childIdsByParent[nodeId]?.[0] ?? null;
      const commandLocation = transitionToAll
        ? ctx.captureHistorySnapshot()
        : null;
      try {
        const mutation = unwrapNotesMutation(await context.repository.createNode(
          context.vaultRoot,
          {
            id,
            parentId: nodeId,
            afterId:
              placement === "first"
                ? null
                : before.childIdsByParent[nodeId]?.at(-1) ?? null,
            ...(placement === "first" && firstChildId !== null
              ? { beforeId: firstChildId }
              : {}),
            title: "",
            note: "",
            markerKind: "bullet"
          },
          ...historyArguments(historyContext)
        ));
        const projection = transitionToAll
          ? { workspace: mutation.workspace }
          : await projectNotesMutation(
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
        const requestedLocation = commandLocation
          ? {
              ...commandLocation,
              scope: { kind: "active" as const },
              libraryView: "all" as const,
              activeTagFilters: [],
              selectedId: id,
              expansion: notesExpansionSnapshotPool.acquire(
                commandLocation.expansion.nodeIds
              ),
              focus: {
                nodeId: id,
                field: "title" as const,
                primarySelection: { anchorUtf16: 0, focusUtf16: 0 }
              },
              tagFilterOrigin: null
            }
          : null;
        try {
          const settlement = await ctx.settleAtomicMutation(
            historyContext,
            mutation,
            projection,
            {
              uiUpdate,
              ...(requestedLocation && commandLocation
                ? {
                    requestedLocation,
                    recoveryLocation: commandLocation
                  }
                : {})
            }
          );
          if (settlement) return settlement;
          if (transitionToAll && ownerStillActive(ctx, ownerRecord)) {
            created = true;
            creation.record = ownerRecord;
            ctx.activeScopeRef.current = { kind: "active" };
          }
          return directMutationResult(mutation, projection, uiUpdate);
        } finally {
          if (requestedLocation) {
            ctx.releaseHistorySnapshot(requestedLocation);
          }
        }
      } finally {
        if (commandLocation) {
          ctx.releaseHistorySnapshot(commandLocation);
        }
      }
    }
  );
  if (
    created &&
    creation.record &&
    ownerStillActive(ctx, creation.record) &&
    transitionToAll
  ) {
    activateAllLibraryView(ctx);
  }
  return outcome;
}

export async function createNextTextSiblingCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId
): Promise<NotesWorkspaceCommandOutcome> {
  return ctx.runStructuralCommand("create", async (context, historyContext) => {
    const before = confirmedState(context);
    const source = before.nodesById[nodeId];
    if (!source) {
      return { kind: "skipped" };
    }
    const id = createNoteId();
    const mutation = unwrapNotesMutation(
      await context.repository.createNode(
        context.vaultRoot,
        {
          id,
          parentId: source.parentId,
          afterId: source.id,
          title: "",
          note: "",
          markerKind: source.markerKind
        },
        ...historyArguments(historyContext)
      )
    );
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    const uiUpdate = {
      selectedId: id,
      editingNoteId: id,
      pendingFocusId: id,
      pendingFocusField: "title" as const,
      ...(ctx.currentNavigation().zoomRootId === nodeId
        ? { zoomRootId: source.parentId }
        : {})
    };
    const settlement = await ctx.settleAtomicMutation(
      historyContext,
      mutation,
      projection,
      { uiUpdate }
    );
    if (settlement) return settlement;
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
      // Post-barrier: the coordinator has flushed the draft-flush barrier and
      // handed this callback the run turn (plan Phase L0 instrumentation).
      markSplitPhase(newNodeId, "barrier");
      if (!confirmedState(context).nodesById[nodeId]) {
        return { kind: "skipped" };
      }
      const inlineTextContext = inlineDraft
        ? ctx.beginTextEntry(executionRecord, nodeId, {
            nodeId,
            field: "title"
          })
        : null;
      let inlineRecovery: NotesWorkspaceQueueResult | null = null;
      const steps: NotesWorkspaceQueueStep[] = [];
      if (inlineDraft) {
        steps.push({
          historyEntryId: inlineTextContext?.entryId,
          run: async () => {
            const response = await context.repository.updateNode(
              context.vaultRoot,
              {
                id: nodeId,
                ...inlineDraft,
                markerKind:
                  confirmedState(context).nodesById[nodeId]?.markerKind ??
                  "bullet"
              },
              ...historyArguments(inlineTextContext)
            );
            const mutation = unwrapNotesMutation(response);
            const settlement = await ctx.settleAtomicMutation(
              inlineTextContext,
              mutation,
              { workspace: mutation.workspace },
              { focus: { nodeId, field: "title" } }
            );
            if (settlement) {
              inlineRecovery = settlement;
              if (inlineTextContext) {
                ctx.consumeRecoveredHistoryResult(inlineTextContext.entryId);
              }
              return settlement;
            }
            return response;
          }
        });
      }
      steps.push({
        historyEntryId: historyContext?.entryId,
        run: async () => {
          const response = await context.repository.splitNode(
            context.vaultRoot,
            {
              id: nodeId,
              newNodeId,
              prefix,
              suffix
            },
            ...historyArguments(historyContext)
          );
          markSplitPhase(newNodeId, "ipc-done");
          return response;
        }
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
      if (inlineRecovery) {
        return inlineRecovery;
      }
      if (result.kind === "authoritative") {
        await ctx.rememberHistoryAfter(
          historyContext &&
            result.committedHistoryEntryIds?.includes(historyContext.entryId)
            ? historyContext
            : null,
          result.workspace,
          result.uiUpdate,
          undefined,
          undefined,
          result.historyStatus
        );
      } else if (
        historyContext &&
        result.kind === "failure" &&
        result.workspace &&
        result.committedHistoryEntryIds?.includes(historyContext.entryId)
      ) {
        await ctx.rememberHistoryAfter(
          historyContext,
          result.workspace,
          undefined,
          undefined,
          undefined,
          result.historyStatus,
          result.historyRejectionState
        );
      }
      succeeded = result.kind === "authoritative";
      return result;
    }
  );
  return completion.then((outcome) => {
    // The structural command has resolved, i.e. the authoritative settle was
    // dispatched; the caret still lands on a later paint (plan Phase L0).
    markSplitPhase(newNodeId, "settled");
    if (succeeded) {
      notifySuccess(options?.onSuccess);
    }
    return outcome;
  });
}

export async function updateNodeCommand(
  ctx: NotesCommandContext,
  nodeId: NoteId,
  patch: Pick<NoteNode, "title" | "note"> &
    Partial<Pick<NoteNode, "markerKind">>
): Promise<NotesWorkspaceCommandOutcome> {
  return ctx.runStructuralCommand("update", async (context, historyContext) => {
    const source = confirmedState(context).nodesById[nodeId];
    if (!source) {
      return { kind: "skipped" };
    }
    const mutation = unwrapNotesMutation(await context.repository.updateNode(
      context.vaultRoot,
      {
        id: nodeId,
        ...patch,
        imageOffsetUtf16: source.imageOffsetUtf16,
        markerKind: patch.markerKind ?? source.markerKind
      },
      ...historyArguments(historyContext)
    ));
    const projection = await projectNotesMutation(
      context,
      mutation,
      ctx.activeScopeRef.current
    );
    const settlement = await ctx.settleAtomicMutation(
      historyContext,
      mutation,
      projection
    );
    if (settlement) return settlement;
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
    let inlineRecovery: NotesWorkspaceQueueResult | null = null;
    const steps: NotesWorkspaceQueueStep[] = [];
    if (inlineDraft) {
      steps.push({
        historyEntryId: inlineTextContext?.entryId,
        run: async () => {
          const response = await context.repository.updateNode(
            context.vaultRoot,
            {
              id: input.id,
              ...inlineDraft,
              markerKind:
                confirmedState(context).nodesById[input.id]?.markerKind ??
                "bullet"
            },
            ...historyArguments(inlineTextContext)
          );
          const mutation = unwrapNotesMutation(response);
          const settlement = await ctx.settleAtomicMutation(
            inlineTextContext,
            mutation,
            { workspace: mutation.workspace },
            { focus: { nodeId: input.id, field: "title" } }
          );
          if (settlement) {
            inlineRecovery = settlement;
            if (inlineTextContext) {
              ctx.consumeRecoveredHistoryResult(inlineTextContext.entryId);
            }
            return settlement;
          }
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
    if (inlineRecovery) {
      return inlineRecovery;
    }
    if (result.kind === "authoritative") {
      await ctx.rememberHistoryAfter(
        historyContext &&
          result.committedHistoryEntryIds?.includes(historyContext.entryId)
          ? historyContext
          : null,
        result.workspace,
        result.uiUpdate,
        undefined,
        undefined,
        result.historyStatus
      );
    } else if (
      historyContext &&
      result.kind === "failure" &&
      result.workspace &&
      result.committedHistoryEntryIds?.includes(historyContext.entryId)
    ) {
      await ctx.rememberHistoryAfter(
        historyContext,
        result.workspace,
        undefined,
        undefined,
        undefined,
        result.historyStatus,
        result.historyRejectionState
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
      const settlement = await ctx.settleAtomicMutation(
        historyContext,
        mutation,
        projection,
        { uiUpdate }
      );
      if (settlement) return settlement;
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
      const settlement = await ctx.settleAtomicMutation(
        historyContext,
        mutation,
        projection,
        {
          uiUpdate: settlementUiUpdate,
          focus: navigationOwned
            ? undefined
            : retainedFocusAfterNavigationLoss(
                latestNavigation,
                projection.workspace
              ),
          expandedNodeIds
        }
      );
      if (settlement) return settlement;
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
    const settlement = await ctx.settleAtomicMutation(
      historyContext,
      mutation,
      projection,
      { uiUpdate }
    );
    if (settlement) return settlement;
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
    const settlement = await ctx.settleAtomicMutation(
      historyContext,
      mutation,
      projection
    );
    if (settlement) return settlement;
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
    const settlement = await ctx.settleAtomicMutation(
      historyContext,
      mutation,
      projection
    );
    if (settlement) return settlement;
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
      const settlement = await ctx.settleAtomicMutation(
        historyContext,
        mutation,
        projection,
        { expandedNodeIds }
      );
      if (settlement) return settlement;
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
    const settlement = await ctx.settleAtomicMutation(
      historyContext,
      mutation,
      projection
    );
    if (settlement) return settlement;
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
    const settlement = await ctx.settleAtomicMutation(
      historyContext,
      mutation,
      projection,
      { uiUpdate }
    );
    if (settlement) return settlement;
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
      const commandLocation = ctx.captureHistorySnapshot();
      try {
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
        const navigationVersion = ctx.navigationVersionRef.current;
        const activeOwner = isLifecycleOwnerActive();
        const latestNavigation = ctx.currentNavigation();
        const navigation =
          activeOwner && navigationVersion !== beforeNavigationVersion
            ? {
                selectedId: latestNavigation.selectedId,
                zoomRootId: latestNavigation.zoomRootId,
                editingNoteId: latestNavigation.editingNoteId,
                pendingFocusId: latestNavigation.pendingFocusId,
                pendingFocusField: latestNavigation.pendingFocusField,
                locallyExpandedNodeIds: new Set(
                  ctx.locallyExpandedNodeIdsRef.current
                ),
                scope: ctx.activeScopeRef.current
              }
            : beforeNavigation;
        let projection;
        try {
          projection = await projectNotesMutation(
            context,
            mutationResult,
            navigation.scope
          );
        } catch {
          lifecycleResult.recoveredToActive = true;
          const projectedWorkspace = activeOwner
            ? await context.repository.loadWorkspace(context.vaultRoot, {
                kind: "active"
              }).catch(() => mutationResult.workspace)
            : mutationResult.workspace;
          projection = { workspace: projectedWorkspace };
        }
        const transition = resolveRootLifecycleNavigation(
          beforeWorkspace,
          normalizeWorkspace(projection.workspace),
          nodeId,
          navigation
        );
        lifecycleResult.transition = {
          before: beforeNavigation,
          after: lifecycleResult.recoveredToActive
            ? { ...transition.after, scope: { kind: "active" } }
            : transition.after
        };
        lifecycleResult.resolvedNavigationVersion = navigationVersion;
        const after = lifecycleResult.transition.after;
        const uiUpdate = {
          selectedId: after.selectedId,
          zoomRootId: after.zoomRootId,
          editingNoteId: after.editingNoteId,
          pendingFocusId: after.pendingFocusId,
          pendingFocusField: after.pendingFocusField
        };
        const requestedLocation: NotesHistorySnapshot = {
          ...commandLocation,
          scope: after.scope,
          selectedId: after.selectedId,
          zoomRootId: after.zoomRootId,
          expansion: notesExpansionSnapshotPool.acquire([
            ...after.locallyExpandedNodeIds
          ]),
          focus: after.editingNoteId
            ? {
                nodeId: after.editingNoteId,
                field: after.pendingFocusField ?? "title"
              }
            : null,
          tagFilterOrigin: commandLocation.tagFilterOrigin
            ? {
                ...commandLocation.tagFilterOrigin,
                expansion: notesExpansionSnapshotPool.acquire(
                  commandLocation.tagFilterOrigin.expansion.nodeIds
                )
              }
            : null
        };
        try {
          const settlement = await ctx.settleAtomicMutation(
            historyContext,
            mutationResult,
            projection,
            {
              uiUpdate,
              expandedNodeIds: after.locallyExpandedNodeIds,
              requestedLocation,
              recoveryLocation: commandLocation
            }
          );
          if (settlement) return settlement;
          return directMutationResult(
            mutationResult,
            projection,
            uiUpdate,
            navigation.scope
          );
        } finally {
          ctx.releaseHistorySnapshot(requestedLocation);
        }
      } finally {
        ctx.releaseHistorySnapshot(commandLocation);
      }
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
    let inlineRecovery: NotesWorkspaceQueueResult | null = null;
    const steps: NotesWorkspaceQueueStep[] = [];
    if (inlineDraft) {
      steps.push({
        historyEntryId: inlineTextContext?.entryId,
        run: async () => {
          const response = await context.repository.updateNode(
            context.vaultRoot,
            {
              id: nodeId,
              ...inlineDraft,
              markerKind:
                confirmedState(context).nodesById[nodeId]?.markerKind ??
                "bullet"
            },
            ...historyArguments(inlineTextContext)
          );
          const mutation = unwrapNotesMutation(response);
          const settlement = await ctx.settleAtomicMutation(
            inlineTextContext,
            mutation,
            { workspace: mutation.workspace },
            { focus: { nodeId, field: "title" } }
          );
          if (settlement) {
            inlineRecovery = settlement;
            if (inlineTextContext) {
              ctx.consumeRecoveredHistoryResult(inlineTextContext.entryId);
            }
            return settlement;
          }
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
    if (inlineRecovery) {
      return inlineRecovery;
    }
    if (result.kind === "authoritative") {
        await ctx.rememberHistoryAfter(
        historyContext &&
          result.committedHistoryEntryIds?.includes(historyContext.entryId)
          ? historyContext
          : null,
        result.workspace,
        result.uiUpdate,
        undefined,
        undefined,
        result.historyStatus
      );
    } else if (
      historyContext &&
      result.kind === "failure" &&
      result.workspace &&
      result.committedHistoryEntryIds?.includes(historyContext.entryId)
    ) {
      await ctx.rememberHistoryAfter(
        historyContext,
        result.workspace,
        undefined,
        undefined,
        undefined,
        result.historyStatus,
        result.historyRejectionState
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
    const settlement = await ctx.settleAtomicMutation(
      historyContext,
      mutation,
      projection
    );
    if (settlement) return settlement;
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
    const settlement = await ctx.settleAtomicMutation(
      historyContext,
      mutation,
      projection,
      {
        uiUpdate,
        focus: followedIntoActive ? { nodeId, field: "title" } : undefined,
        expandedNodeIds: followedIntoActive ? new Set() : undefined
      }
    );
    if (settlement) return settlement;
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
  return record.session.enqueueStructural(async (context) => {
    // This owned pre-reset snapshot is also the presentation contract for an
    // owner that transfers while the backend transaction is in flight.
    const current = ctx.captureHistorySnapshot();
    let resolved: Awaited<ReturnType<typeof ctx.resolveHistoryLocation>> = null;
    try {
      const reset = await context.repository.emptyTrash(context.vaultRoot, {
        sessionId: record.session.history.sessionId,
        historyEpoch: record.session.history.historyEpoch
      });
      if (reset.historyReset !== true) {
        const error = "Empty Trash did not acknowledge the history reset.";
        ctx.publishFeedback?.({ kind: "error", message: error });
        return { kind: "failure", error };
      }
      const projectedWorkspace = await workspaceForScope(
        context,
        reset.workspace,
        current.scope
      );
      resolved = await ctx.resolveHistoryLocation(current, projectedWorkspace);
      if (!resolved) {
        const error = "Empty Trash could not restore the current Notes location.";
        ctx.publishFeedback?.({ kind: "error", message: error });
        return { kind: "failure", error };
      }
      // The coordinator owns the all-or-nothing timeline/canonical reset. Do
      // not clear snapshots or drafts here: a rejected reset must leave both
      // intact for the caller to retry safely.
      (record.session as unknown as NotesWorkspaceCoordinatorSession).resetHistory(
        reset.historyEpoch,
        resolved
      );
      ctx.publishFeedback?.({
        kind: "status",
        message: "Trash emptied and Notes history reset."
      });
      return authoritative(
        {
          nodes: Object.values(resolved.workspace.nodesById),
          attachmentsByNodeId: resolved.workspace.attachmentsByNodeId
        },
        undefined,
        reset,
        { invalidatesTagSummaries: true }
      );
    } catch (cause) {
      if (resolved) {
        ctx.releaseHistorySnapshot(resolved.snapshot);
      }
      const error = errorMessage(cause);
      ctx.publishFeedback?.({ kind: "error", message: error });
      return { kind: "failure", error };
    } finally {
      ctx.releaseHistorySnapshot(current);
    }
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
      const historySettlement = await ctx.settleAtomicMutation(
        historyContext,
        mutation,
        projection,
        { uiUpdate: focusedUiUpdate(prepared.sourceId) }
      );
      if (historySettlement) return historySettlement;
      if (!mutation.atomic || mutation.historyEntryId !== null) {
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
