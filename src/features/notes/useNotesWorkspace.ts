import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { createNoteId, isNotesMutationResult } from "../../domain/notes";
import type {
  ImportNoteAttachmentByteItem,
  MoveNoteNodeInput,
  NoteId,
  NoteNode,
  NotesHistoryContext,
  NotesHistoryStatus,
  NotesMutationResponse,
  NoteSearchResult,
  NoteTagFilter,
  NoteTagSummary,
  NotesStore,
  NotesStoreError,
  NotesWorkspace,
  NotesWorkspaceScope,
  PendingNoteAttachmentByteItem
} from "../../domain/notes";
import {
  createNotesWriteQueue,
  type NotesWriteQueue
} from "../../services/notesWriteQueue";
import {
  notesWorkspaceCoordinatorRegistry,
  type NotesWorkspaceCoordinatorSession,
  type NotesWorkspaceQueueContext,
  type NotesWorkspaceQueueResult,
  type NotesWorkspaceQueueWork,
  type NotesWorkspaceUiUpdate
} from "./notesWorkspaceCoordinator";
import {
  createNotesHistoryOwnerRegistry,
  type NotesHistoryFocus,
  type NotesHistoryFocusField,
  type NotesHistoryLocationSnapshot,
  type NotesHistorySnapshot
} from "./notesHistory";
import {
  normalizeWorkspace,
  notesWorkspaceReducer,
  type NormalizedNotesWorkspace
} from "./notesWorkspaceReducer";
import { parseAndValidateNoteSearchQuery } from "./noteSearchQuery";
import {
  nativeNotesAttachmentUi,
  type NotesAttachmentUiBoundary
} from "./notesAttachmentController";
import {
  buildNotesMoveNodeInput,
  isActiveMoveNode
} from "./notesMoveTargets";
import {
  NotesDraftEngine,
  type DraftWriteAttempt,
  type NotesDraftEngineHost,
  type NotesWorkspaceSessionRecord
} from "./notesDraftEngine";

export interface NotesDeleteAllOptions {
  /**
   * Discard any pending drafts that could not be written and delete the Notes
   * data regardless. Recovers a vault whose database is broken enough that the
   * pre-delete flush can never succeed.
   */
  discardDrafts?: boolean;
}

export interface NotesDeleteAllResult {
  /**
   * True when the database was deleted but some attachment files were left on
   * disk. Non-blocking: the deletion still completed.
   */
  attachmentCleanupFailed: boolean;
}

/**
 * Discriminator for the rejection `deleteAllNotesData` throws when the
 * pre-delete draft flush fails and the caller has not opted into discarding
 * drafts. Lets the settings dialog offer an explicit "discard and delete"
 * confirmation instead of surfacing a dead end.
 */
export const NOTES_DRAFTS_FLUSH_FAILED_CODE = "notes-drafts-flush-failed";

interface NotesDraftsFlushFailedError extends Error {
  code: typeof NOTES_DRAFTS_FLUSH_FAILED_CODE;
}

function notesDraftsFlushFailedError(
  cause: NotesStoreError | null
): NotesDraftsFlushFailedError {
  const error = new Error(
    cause?.message ?? "Pending Notes changes could not be saved."
  ) as NotesDraftsFlushFailedError;
  error.name = "NotesDraftsFlushFailedError";
  error.code = NOTES_DRAFTS_FLUSH_FAILED_CODE;
  return error;
}

export function isNotesDraftsFlushFailedError(
  value: unknown
): value is NotesDraftsFlushFailedError {
  return (
    value instanceof Error &&
    (value as { code?: unknown }).code === NOTES_DRAFTS_FLUSH_FAILED_CODE
  );
}

/**
 * Narrows the value resolved by `NotesStore.deleteDatabase`. Injected test
 * repositories may still resolve `undefined`, so the cleanup flag is read
 * structurally instead of trusting the interface type.
 */
function hasAttachmentCleanupFlag(
  value: unknown
): value is { attachmentCleanupFailed: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { attachmentCleanupFailed?: unknown })
      .attachmentCleanupFailed === "boolean"
  );
}

export interface NotesWorkspaceActions {
  acknowledgeFocus(nodeId: NoteId): Promise<void>;
  focusNode(nodeId: NoteId): Promise<void>;
  createRoot(): Promise<void>;
  splitNode(
    nodeId: NoteId,
    newNodeId: NoteId,
    prefix: string,
    suffix: string,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<void>;
  createChild(nodeId: NoteId): Promise<void>;
  updateNode(
    nodeId: NoteId,
    patch: Pick<NoteNode, "title" | "note">
  ): Promise<void>;
  updateNodeDraft(
    nodeId: NoteId,
    patch: Pick<NoteNode, "title" | "note">,
    field?: NotesHistoryFocusField
  ): void;
  flushNodeDraft(nodeId: NoteId): Promise<boolean>;
  flushAllDrafts(): Promise<boolean>;
  moveNode(
    input: MoveNoteNodeInput,
    focusNodeId?: NoteId | null,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<void>;
  toggleComplete(nodeId: NoteId): Promise<void>;
  toggleCollapsed(nodeId: NoteId): Promise<void>;
  expandAll(nodeId: NoteId): Promise<void>;
  collapseAll(nodeId: NoteId): Promise<void>;
  sortSubtreeAscending(nodeId: NoteId): Promise<void>;
  sortSubtreeDescending(nodeId: NoteId): Promise<void>;
  toggleStar(nodeId: NoteId): Promise<void>;
  duplicateNode(nodeId: NoteId): Promise<void>;
  removeEmptyNode(
    nodeId: NoteId,
    focusNodeId?: NoteId | null,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<void>;
  deleteNode(nodeId: NoteId): Promise<void>;
  restoreNode(nodeId: NoteId): Promise<void>;
  archiveNode(nodeId: NoteId): Promise<void>;
  unarchiveNode(nodeId: NoteId): Promise<void>;
  emptyTrash(): Promise<void>;
  selectLibraryView(view: NotesLibraryView): Promise<void>;
  toggleTagFilter(filter: NoteTagFilter): Promise<void>;
  searchNotes(query: string): Promise<NoteSearchResult[]>;
  openSearchResult(nodeId: NoteId): Promise<void>;
  deleteAllNotesData(
    options?: NotesDeleteAllOptions
  ): Promise<NotesDeleteAllResult>;
  zoomTo(nodeId: NoteId | null): Promise<void>;
  uploadImage?(nodeId: NoteId): Promise<void>;
  importDroppedImagePaths?(
    nodeId: NoteId,
    paths: readonly string[]
  ): Promise<void>;
  importClipboardImages?(
    nodeId: NoteId,
    items: readonly PendingNoteAttachmentByteItem[]
  ): Promise<void>;
  retryImageUpload?(nodeId: NoteId, attemptId?: string): Promise<void>;
  loadAttachmentBytes?(attachmentId: string): Promise<Uint8Array>;
  resizeImage?(attachmentId: string, displayWidth: number): Promise<void>;
  removeImage?(attachmentId: string): Promise<void>;
  undo?(): Promise<void>;
  redo?(): Promise<void>;
  setImageImportMaxDisplayWidth(displayWidth: number | null): void;
}

export type NotesLibraryView =
  | "all"
  | "starred"
  | "recent"
  | "tags"
  | "archive"
  | "trash";

export interface NotesWorkspaceCompoundOptions {
  draft?: Pick<NoteNode, "title" | "note">;
  expandNodeId?: NoteId;
  onSuccess?: () => void;
}

export interface UseNotesWorkspaceOptions {
  vaultRoot: string;
  repository: NotesStore;
  attachmentUi?: NotesAttachmentUiBoundary;
}

export interface NotesPreparedMove {
  readonly token: number;
  readonly vaultRoot: string;
  readonly scope: NotesWorkspaceScope;
  readonly generation: number;
  readonly sourceId: NoteId;
  readonly nodes: readonly NoteNode[];
}

export type NotesPreparedMoveCommitResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Low-volatility slice: workspace projection + navigation + loading/history
 * status. Changes on structural mutations, navigation, and scope switches, but
 * NOT on draft keystrokes.
 */
export interface NotesStateSlice {
  state: NormalizedNotesWorkspace;
  deletingNotesData: boolean;
  libraryView: NotesLibraryView;
  activeTagFilters: readonly NoteTagFilter[];
  tagSummaries: readonly NoteTagSummary[];
  locallyExpandedNodeIds: ReadonlySet<NoteId>;
  status: NormalizedNotesWorkspace["status"];
  loading: boolean;
  error: string | null;
  canUndo?: boolean;
  canRedo?: boolean;
}

/**
 * High-volatility slice: the per-node draft buffer plus write/save-failure
 * surfaces. This is what churns on every keystroke.
 */
export interface NotesDraftsSlice {
  draftsByNodeId: Readonly<Record<NoteId, NotesNodeDraft>>;
  writeError: NotesStoreError | null;
  attachmentUploadErrorsByNodeId?: Readonly<Record<NoteId, string>>;
  attachmentUploadRetryAttemptIdsByNodeId?: Readonly<Record<NoteId, string>>;
}

/**
 * Stable slice: every action callback. Its identity must stay referentially
 * stable across draft keystrokes and unrelated state changes so that
 * action-only consumers never re-render for data they do not read.
 */
export interface NotesActionsSlice {
  actions: NotesWorkspaceActions;
  retryFailedDraft(nodeId: NoteId): Promise<void>;
  retryLastFailedWrite(): Promise<void>;
  loadActiveNodesForMove?(): Promise<readonly NoteNode[]>;
  prepareMoveNode?(nodeId: NoteId): Promise<NotesPreparedMove>;
  commitPreparedMove?(
    prepared: NotesPreparedMove,
    destinationId: NoteId | null
  ): Promise<NotesPreparedMoveCommitResult>;
}

export interface UseNotesWorkspaceResult
  extends NotesStateSlice,
    NotesDraftsSlice,
    NotesActionsSlice {
  // Memoized slices for volatility-partitioned context providers. Always
  // populated by the hook; optional so that test fixtures may build the flat
  // shape without them.
  stateSlice?: NotesStateSlice;
  draftsSlice?: NotesDraftsSlice;
  actionsSlice?: NotesActionsSlice;
}

export interface NotesNodeDraft extends Pick<NoteNode, "title" | "note"> {
  revision: number;
  status: "pending" | "failed";
}

/**
 * Stable empty snapshot for the drafts external store before any engine exists
 * (first render) or after teardown. Shared so `getDraftsSnapshot` returns a
 * referentially stable value that never trips `useSyncExternalStore`.
 */
const EMPTY_DRAFTS: Readonly<Record<NoteId, NotesNodeDraft>> = {};

type AttachmentImportRequest =
  | {
      readonly kind: "paths";
      readonly items: readonly { id: string; sourcePath: string }[];
    }
  | {
      readonly kind: "bytes";
      readonly items: readonly ImportNoteAttachmentByteItem[];
    };

interface AttachmentUploadAttempt {
  readonly attemptId: string;
  readonly nodeId: NoteId;
  readonly request: AttachmentImportRequest;
  readonly initialMaxDisplayWidth: number;
  readonly historyContext: NotesHistoryContext | null;
  readonly record: NotesWorkspaceSessionRecord;
  status: "pending" | "failed";
  error: string | null;
}

interface StructuralCommandOptions {
  readonly historyContext?: NotesHistoryContext | null;
  readonly retainHistoryOnFailure?: boolean;
}

function authoritative(
  workspace: NotesWorkspace,
  uiUpdate?: NotesWorkspaceUiUpdate,
  historyStatus?: { canUndo: boolean; canRedo: boolean },
  options?: Pick<
    Extract<NotesWorkspaceQueueResult, { kind: "authoritative" }>,
    | "scopeAgnostic"
    | "committedHistoryEntryIds"
    | "invalidatesTagSummaries"
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

interface UnwrappedNotesMutation {
  workspace: NotesWorkspace;
  historyEntryId: string | null | undefined;
  historyStatus: NotesHistoryStatus | undefined;
  atomic: boolean;
}

function unwrapNotesMutation(
  response: NotesMutationResponse
): UnwrappedNotesMutation {
  if (isNotesMutationResult(response)) {
    return {
      workspace: response.workspace,
      historyEntryId: response.historyEntryId,
      historyStatus: {
        canUndo: response.canUndo,
        canRedo: response.canRedo
      },
      atomic: true
    };
  }
  return {
    workspace: response,
    historyEntryId: undefined,
    historyStatus: undefined,
    atomic: false
  };
}

function appliedHistoryContext(
  context: NotesHistoryContext | null | undefined,
  mutation: UnwrappedNotesMutation
): NotesHistoryContext | null | undefined {
  if (!mutation.atomic) {
    return context;
  }
  return context?.entryId === mutation.historyEntryId ? context : null;
}

function historyArguments(
  context: NotesHistoryContext | null | undefined
): [] | [NotesHistoryContext] {
  return context ? [context] : [];
}

function supportsHistory(repository: NotesStore): boolean {
  return repository.undo !== undefined && repository.redo !== undefined;
}

function expansionsOutsideSubtree(
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

function samePreparedMoveNode(
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

async function workspaceForScope(
  context: NotesWorkspaceQueueContext,
  mutationWorkspace: NotesWorkspace,
  scope: NotesWorkspaceScope
): Promise<NotesWorkspace> {
  return scope.kind === "active"
    ? mutationWorkspace
    : context.repository.loadWorkspace(context.vaultRoot, scope);
}

interface ProjectedNotesMutation {
  workspace: NotesWorkspace;
  projectionError?: string;
}

async function projectNotesMutation(
  context: NotesWorkspaceQueueContext,
  mutation: UnwrappedNotesMutation,
  scope: NotesWorkspaceScope
): Promise<ProjectedNotesMutation> {
  try {
    return {
      workspace: await workspaceForScope(context, mutation.workspace, scope)
    };
  } catch (cause) {
    if (!mutation.atomic) {
      throw cause;
    }
    return {
      workspace: mutation.workspace,
      projectionError: errorMessage(cause)
    };
  }
}

function directMutationResult(
  mutation: UnwrappedNotesMutation,
  projection: ProjectedNotesMutation,
  uiUpdate?: NotesWorkspaceUiUpdate
): NotesWorkspaceQueueResult {
  if (!projection.projectionError) {
    return authoritative(
      projection.workspace,
      uiUpdate,
      mutation.historyStatus,
      { invalidatesTagSummaries: true }
    );
  }
  return {
    kind: "failure",
    error: projection.projectionError,
    workspace: projection.workspace,
    uiUpdate,
    historyStatus: mutation.historyStatus,
    scopeAgnostic: true,
    invalidatesTagSummaries: true,
    ...(mutation.historyEntryId
      ? { committedHistoryEntryIds: [mutation.historyEntryId] }
      : {})
  };
}

interface NotesWorkspaceQueueStep {
  run(): Promise<NotesMutationResponse>;
  historyEntryId?: string;
}

interface BufferedWorkspaceCommand {
  work: NotesWorkspaceQueueWork;
  structural?: boolean;
  resolve(): void;
}

interface SearchNavigation {
  rootId: NoteId;
  expandedNodeIds: Set<NoteId>;
}

interface LiveNotesNavigation {
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  pendingFocusField: NotesHistoryFocusField | null;
}

interface TagFilterOrigin {
  scope: NotesWorkspaceScope;
  libraryView: Exclude<NotesLibraryView, "tags">;
  navigation: LiveNotesNavigation;
  locallyExpandedNodeIds: ReadonlySet<NoteId>;
}

interface TagSummaryRefreshWaiter {
  version: number;
  resolve(summaries: readonly NoteTagSummary[] | null): void;
}

const emptyLiveNavigation = (): LiveNotesNavigation => ({
  selectedId: null,
  zoomRootId: null,
  editingNoteId: null,
  pendingFocusId: null,
  pendingFocusField: null
});

function reconcileLiveNavigation(
  current: LiveNotesNavigation,
  workspace: NotesWorkspace,
  update?: NotesWorkspaceUiUpdate
): LiveNotesNavigation {
  const existingIds = new Set(workspace.nodes.map((item) => item.id));
  const existing = (nodeId: NoteId | null): NoteId | null =>
    nodeId !== null && existingIds.has(nodeId) ? nodeId : null;
  const selectedId = existing(
    update?.selectedId === undefined ? current.selectedId : update.selectedId
  );
  const zoomRootId = existing(
    update?.zoomRootId === undefined ? current.zoomRootId : update.zoomRootId
  );
  const editingNoteId = existing(
    update?.editingNoteId === undefined
      ? current.editingNoteId
      : update.editingNoteId
  );
  const pendingFocusId = existing(
    update?.pendingFocusId === undefined
      ? current.pendingFocusId
      : update.pendingFocusId
  );
  return {
    selectedId,
    zoomRootId,
    editingNoteId,
    pendingFocusId,
    pendingFocusField:
      pendingFocusId === null
        ? null
        : update?.pendingFocusField === undefined
          ? (current.pendingFocusField ?? "title")
          : update.pendingFocusField
  };
}

function resolveBufferedCommands(commands: BufferedWorkspaceCommand[]): void {
  for (const command of commands) {
    command.resolve();
  }
}

function enqueueBufferedCommands(
  session: NotesWorkspaceCoordinatorSession,
  commands: BufferedWorkspaceCommand[]
): void {
  for (const command of commands) {
    let completion: Promise<void>;
    try {
      completion = command.structural
        ? session.enqueueStructural(command.work)
        : session.enqueue(command.work);
    } catch {
      command.resolve();
      continue;
    }
    void completion.then(command.resolve, command.resolve);
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function scopeForLibraryView(
  view: Exclude<NotesLibraryView, "tags">
): NotesWorkspaceScope {
  switch (view) {
    case "all":
      return { kind: "active" };
    case "starred":
      return { kind: "starred" };
    case "recent":
      return { kind: "recent" };
    case "archive":
      return { kind: "archive" };
    case "trash":
      return { kind: "trash" };
  }
}

function sameScope(
  left: NotesWorkspaceScope,
  right: NotesWorkspaceScope
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function tagFilterKey(filter: NoteTagFilter): string {
  return `${filter.prefix}\u0000${filter.normalizedTag}`;
}

export function canonicalizeTagFilters(
  filters: readonly NoteTagFilter[]
): NoteTagFilter[] {
  const uniqueFilters = new Map(
    filters.map((filter) => [
      tagFilterKey(filter),
      {
        prefix: filter.prefix,
        normalizedTag: filter.normalizedTag
      }
    ])
  );
  return [...uniqueFilters.values()].sort(
    (left, right) =>
      (left.prefix === right.prefix ? 0 : left.prefix === "#" ? -1 : 1) ||
      left.normalizedTag.localeCompare(right.normalizedTag)
  );
}

function cloneWorkspaceScope(scope: NotesWorkspaceScope): NotesWorkspaceScope {
  return scope.kind === "tags"
    ? { kind: "tags", tags: canonicalizeTagFilters(scope.tags) }
    : { ...scope };
}

function libraryStateForScope(scope: NotesWorkspaceScope): {
  view: Exclude<NotesLibraryView, "tags"> | "tags";
  filters: readonly NoteTagFilter[];
} {
  switch (scope.kind) {
    case "active":
      return { view: "all", filters: [] };
    case "starred":
      return { view: "starred", filters: [] };
    case "recent":
      return { view: "recent", filters: [] };
    case "archive":
      return { view: "archive", filters: [] };
    case "trash":
      return { view: "trash", filters: [] };
    case "tag":
      return {
        view: "tags",
        filters: scope.tag.length > 1
          ? [
              {
                prefix: scope.tag[0] as "#" | "@",
                normalizedTag: scope.tag.slice(1).toLocaleLowerCase()
              }
            ]
          : []
      };
    case "tags":
      return { view: "tags", filters: canonicalizeTagFilters(scope.tags) };
  }
}

function restoredTagFilterNavigation(
  workspace: NotesWorkspace,
  origin: TagFilterOrigin
): { uiUpdate: NotesWorkspaceUiUpdate; expandedNodeIds: ReadonlySet<NoteId> } {
  const normalized = normalizeWorkspace(workspace);
  const existing = (nodeId: NoteId | null): NoteId | null | undefined =>
    nodeId === null
      ? null
      : normalized.nodesById[nodeId]
        ? nodeId
        : undefined;
  const fallbackId = normalized.rootIds[0] ?? null;
  const restoredZoomRootId = existing(origin.navigation.zoomRootId);
  const zoomRootId =
    restoredZoomRootId === undefined ? fallbackId : restoredZoomRootId;
  const restoredSelectedId = existing(origin.navigation.selectedId);
  const selectedId =
    restoredSelectedId === undefined ? zoomRootId ?? fallbackId : restoredSelectedId;
  const editingNoteId = existing(origin.navigation.editingNoteId) ?? null;
  const pendingFocusId = existing(origin.navigation.pendingFocusId) ?? null;
  return {
    uiUpdate: {
      selectedId,
      zoomRootId,
      editingNoteId,
      pendingFocusId,
      pendingFocusField:
        pendingFocusId === null ? null : origin.navigation.pendingFocusField
    },
    expandedNodeIds: new Set(
      [...origin.locallyExpandedNodeIds].filter((nodeId) =>
        Boolean(normalized.nodesById[nodeId])
      )
    )
  };
}

function searchNavigation(
  workspace: NotesWorkspace,
  nodeId: NoteId
): SearchNavigation | null {
  const normalized = normalizeWorkspace(workspace);
  if (!normalized.nodesById[nodeId]) {
    return null;
  }
  const trail: NoteId[] = [];
  const visited = new Set<NoteId>();
  let currentId: NoteId | null = nodeId;
  while (currentId !== null && !visited.has(currentId)) {
    const node: NoteNode | undefined = normalized.nodesById[currentId];
    if (!node) {
      return null;
    }
    visited.add(currentId);
    trail.push(currentId);
    currentId = node.parentId;
  }
  const orderedTrail = trail.reverse();
  const rootId = orderedTrail[0];
  if (!rootId) {
    return null;
  }
  return {
    rootId,
    expandedNodeIds: new Set(
      orderedTrail
        .slice(0, -1)
        .filter((id) => normalized.nodesById[id]?.isCollapsed)
    )
  };
}

async function runCompoundQueueWork(
  context: NotesWorkspaceQueueContext,
  steps: NotesWorkspaceQueueStep[],
  uiUpdate?: NotesWorkspaceUiUpdate,
  scope: NotesWorkspaceScope = { kind: "active" }
): Promise<NotesWorkspaceQueueResult> {
  let workspace = context.confirmedWorkspace;
  let hasAuthoritativeStep = false;
  let historyStatus: NotesHistoryStatus | undefined;
  const committedHistoryEntryIds: string[] = [];

  try {
    for (const step of steps) {
      const mutation = unwrapNotesMutation(await step.run());
      workspace = mutation.workspace;
      hasAuthoritativeStep = true;
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
    }
    return authoritative(
      await workspaceForScope(context, workspace, scope),
      uiUpdate,
      historyStatus,
      committedHistoryEntryIds.length > 0
        ? { committedHistoryEntryIds, invalidatesTagSummaries: true }
        : { invalidatesTagSummaries: true }
    );
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

function notifySuccess(callback: (() => void) | undefined): void {
  if (!callback) {
    return;
  }
  try {
    callback();
  } catch {
    // Local completion handlers cannot change an authoritative queue result.
  }
}

function confirmedState(
  context: NotesWorkspaceQueueContext
): NormalizedNotesWorkspace {
  return normalizeWorkspace(context.confirmedWorkspace);
}

function focusedUiUpdate(
  focusNodeId: NoteId | null | undefined
): NotesWorkspaceUiUpdate | undefined {
  return focusNodeId == null
    ? undefined
    : {
        selectedId: focusNodeId,
        editingNoteId: focusNodeId,
        pendingFocusId: focusNodeId
      };
}

function duplicateRootId(
  before: NormalizedNotesWorkspace,
  after: NotesWorkspace,
  sourceId: NoteId
): NoteId | null {
  const source = before.nodesById[sourceId];
  if (!source) {
    return null;
  }
  return (
    after.nodes.find(
      (node) =>
        node.parentId === source.parentId && !before.nodesById[node.id]
    )?.id ?? null
  );
}

export interface NotesLifecycleNavigationSnapshot {
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  pendingFocusField: NotesHistoryFocusField | null;
  locallyExpandedNodeIds: ReadonlySet<NoteId>;
  scope: NotesWorkspaceScope;
}

export interface NotesLifecycleNavigationTransition {
  before: NotesLifecycleNavigationSnapshot;
  after: NotesLifecycleNavigationSnapshot;
}

function rootIdForNode(
  workspace: NormalizedNotesWorkspace,
  nodeId: NoteId | null
): NoteId | null {
  let currentId = nodeId;
  const visited = new Set<NoteId>();
  while (currentId !== null && !visited.has(currentId)) {
    const node = workspace.nodesById[currentId];
    if (!node) {
      return null;
    }
    if (node.parentId === null) {
      return node.id;
    }
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
  if (removedIndex < 0) {
    return afterRootIds[0] ?? null;
  }
  for (let index = removedIndex + 1; index < beforeRootIds.length; index += 1) {
    const candidate = beforeRootIds[index];
    if (remaining.has(candidate)) {
      return candidate;
    }
  }
  for (let index = removedIndex - 1; index >= 0; index -= 1) {
    const candidate = beforeRootIds[index];
    if (remaining.has(candidate)) {
      return candidate;
    }
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
  const focusFallback =
    fallbackRoot !== undefined &&
    fallbackRoot.deletedAt === null;
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

function hasMoveDependencies(
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

export function useNotesWorkspace({
  vaultRoot,
  repository,
  attachmentUi = nativeNotesAttachmentUi
}: UseNotesWorkspaceOptions): UseNotesWorkspaceResult {
  const [state, dispatch] = useReducer(
    notesWorkspaceReducer,
    undefined,
    (): NormalizedNotesWorkspace => ({
      ...normalizeWorkspace({ nodes: [] }),
      status: "loading"
    })
  );
  const [libraryView, setLibraryView] = useState<NotesLibraryView>("all");
  const libraryViewRef = useRef(libraryView);
  libraryViewRef.current = libraryView;
  const [activeTagFilters, setActiveTagFilters] = useState<
    readonly NoteTagFilter[]
  >([]);
  const [tagSummaries, setTagSummaries] = useState<readonly NoteTagSummary[]>([]);
  const tagSummaryRequestedVersionRef = useRef(0);
  const tagSummarySettledVersionRef = useRef(0);
  const tagSummaryRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const tagSummaryRefreshWaitersRef = useRef<TagSummaryRefreshWaiter[]>([]);
  const pumpTagSummaryRefreshRef = useRef<(() => void) | null>(null);
  const [locallyExpandedNodeIds, setLocallyExpandedNodeIds] = useState<
    ReadonlySet<NoteId>
  >(() => new Set());
  const [attachmentUploadErrorsByNodeId, setAttachmentUploadErrorsByNodeId] =
    useState<Readonly<Record<NoteId, string>>>({});
  const [
    attachmentUploadRetryAttemptIdsByNodeId,
    setAttachmentUploadRetryAttemptIdsByNodeId
  ] = useState<Readonly<Record<NoteId, string>>>({});
  const attachmentUploadAttemptsByNodeIdRef = useRef(
    new Map<NoteId, Map<string, AttachmentUploadAttempt>>()
  );
  const imageImportMaxDisplayWidthRef = useRef<number | null>(null);
  const [deletingNotesData, setDeletingNotesData] = useState(false);
  const [historyStatus, setHistoryStatus] = useState({
    canUndo: false,
    canRedo: false
  });
  const historyVersionRef = useRef(0);
  const activeScopeRef = useRef<NotesWorkspaceScope>({ kind: "active" });
  const activeWorkspaceGenerationRef = useRef(0);
  const movePreparationTokenRef = useRef(0);
  const vaultRootRef = useRef(vaultRoot);
  vaultRootRef.current = vaultRoot;
  const requestedTagFiltersRef = useRef<readonly NoteTagFilter[]>([]);
  const tagFilterOriginRef = useRef<TagFilterOrigin | null>(null);
  const tagFilterRequestRef = useRef(0);
  const locallyExpandedNodeIdsRef = useRef<ReadonlySet<NoteId>>(new Set());
  const stateRef = useRef(state);
  stateRef.current = state;
  const liveNavigationRef = useRef<LiveNotesNavigation>(emptyLiveNavigation());
  const navigationVersionRef = useRef(0);
  const deletingNotesDataRef = useRef(false);
  const deletionTokenRef = useRef<object | null>(null);
  const sessionRef = useRef<NotesWorkspaceCoordinatorSession | null>(null);
  const historyOwnerByEntryIdRef = useRef(
    createNotesHistoryOwnerRegistry<NotesWorkspaceCoordinatorSession>(200)
  );
  const sessionRecordRef = useRef<NotesWorkspaceSessionRecord | null>(null);
  const draftEngineRef = useRef<NotesDraftEngine | null>(null);
  const draftsListenersRef = useRef(new Set<() => void>());
  const writeErrorListenersRef = useRef(new Set<() => void>());
  const bufferedCommandsRef = useRef<BufferedWorkspaceCommand[]>([]);
  const finalCleanupTokenRef = useRef<object | null>(null);
  const closedRef = useRef(false);

  // The draft engine is the external store behind the drafts slice. A stable
  // subscribe/getSnapshot pair reads whichever engine is currently active so
  // the store facade survives vault switches without resubscribing.
  const subscribeDrafts = useCallback((listener: () => void): (() => void) => {
    draftsListenersRef.current.add(listener);
    return () => {
      draftsListenersRef.current.delete(listener);
    };
  }, []);
  const getDraftsSnapshot = useCallback(
    (): Readonly<Record<NoteId, NotesNodeDraft>> =>
      draftEngineRef.current?.getDraftsSnapshot() ?? EMPTY_DRAFTS,
    []
  );
  const draftsByNodeId = useSyncExternalStore(subscribeDrafts, getDraftsSnapshot);
  const subscribeWriteError = useCallback(
    (listener: () => void): (() => void) => {
      writeErrorListenersRef.current.add(listener);
      return () => {
        writeErrorListenersRef.current.delete(listener);
      };
    },
    []
  );
  const getWriteErrorSnapshot = useCallback(
    (): NotesStoreError | null =>
      draftEngineRef.current?.getWriteErrorSnapshot() ?? null,
    []
  );
  const currentWriteError = useSyncExternalStore(
    subscribeWriteError,
    getWriteErrorSnapshot
  );
  const notifyDraftsListeners = useCallback((): void => {
    for (const listener of draftsListenersRef.current) {
      listener();
    }
  }, []);
  const notifyWriteErrorListeners = useCallback((): void => {
    for (const listener of writeErrorListenersRef.current) {
      listener();
    }
  }, []);

  const discardAttachmentUploadAttempts = useCallback((): void => {
    for (const attempts of attachmentUploadAttemptsByNodeIdRef.current.values()) {
      for (const attempt of attempts.values()) {
        const context = attempt.historyContext;
        if (!context) continue;
        historyOwnerByEntryIdRef.current
          .owner(context.entryId)
          ?.history.discard(context.entryId);
        historyOwnerByEntryIdRef.current.discard(context.entryId);
      }
    }
    attachmentUploadAttemptsByNodeIdRef.current.clear();
  }, []);

  const settleTagSummaryRefreshWaiters = useCallback(
    (version: number, summaries: readonly NoteTagSummary[] | null): void => {
      const settled: TagSummaryRefreshWaiter[] = [];
      const pending: TagSummaryRefreshWaiter[] = [];
      for (const waiter of tagSummaryRefreshWaitersRef.current) {
        (waiter.version <= version ? settled : pending).push(waiter);
      }
      tagSummaryRefreshWaitersRef.current = pending;
      for (const waiter of settled) {
        waiter.resolve(summaries);
      }
    },
    []
  );

  const pumpTagSummaryRefresh = useCallback((): void => {
    if (tagSummaryRefreshPromiseRef.current) {
      return;
    }
    let completion!: Promise<void>;
    completion = (async () => {
      while (
        tagSummarySettledVersionRef.current <
        tagSummaryRequestedVersionRef.current
      ) {
        const version = tagSummaryRequestedVersionRef.current;
        const record = sessionRecordRef.current;
        const session = record?.session ?? null;
        let summaries: readonly NoteTagSummary[] | null = null;
        if (
          record &&
          !record.closing &&
          sessionRef.current === session
        ) {
          try {
            summaries = await record.repository.listTagsWithCounts(
              record.vaultRoot
            );
          } catch {
            summaries = null;
          }
        }

        tagSummarySettledVersionRef.current = Math.max(
          tagSummarySettledVersionRef.current,
          version
        );
        if (version !== tagSummaryRequestedVersionRef.current) {
          continue;
        }
        const recordStillCurrent =
          record !== null &&
          !record.closing &&
          sessionRecordRef.current === record &&
          sessionRef.current === session;
        if (recordStillCurrent && summaries) {
          setTagSummaries(summaries);
        }
        settleTagSummaryRefreshWaiters(
          version,
          recordStillCurrent ? summaries : null
        );
      }
    })().finally(() => {
      if (tagSummaryRefreshPromiseRef.current !== completion) {
        return;
      }
      tagSummaryRefreshPromiseRef.current = null;
      if (
        tagSummarySettledVersionRef.current <
        tagSummaryRequestedVersionRef.current
      ) {
        pumpTagSummaryRefreshRef.current?.();
      }
    });
    tagSummaryRefreshPromiseRef.current = completion;
  }, [settleTagSummaryRefreshWaiters]);
  pumpTagSummaryRefreshRef.current = pumpTagSummaryRefresh;

  const requestTagSummaryRefresh = useCallback(() => {
    const version = ++tagSummaryRequestedVersionRef.current;
    const completion = new Promise<readonly NoteTagSummary[] | null>(
      (resolve) => {
        tagSummaryRefreshWaitersRef.current.push({ version, resolve });
      }
    );
    pumpTagSummaryRefreshRef.current?.();
    return completion;
  }, []);

  useLayoutEffect(() => {
    closedRef.current = false;
    const previousEngine = draftEngineRef.current;
    if (previousEngine) {
      void previousEngine.beginShutdown();
    }
    dispatch({ type: "startWorkspaceLoad" });
    setAttachmentUploadErrorsByNodeId({});
    setAttachmentUploadRetryAttemptIdsByNodeId({});
    discardAttachmentUploadAttempts();
    deletingNotesDataRef.current = false;
    deletionTokenRef.current = null;
    setDeletingNotesData(false);
    setHistoryStatus({ canUndo: false, canRedo: false });
    historyVersionRef.current = 0;
    activeScopeRef.current = { kind: "active" };
    activeWorkspaceGenerationRef.current += 1;
    movePreparationTokenRef.current += 1;
    requestedTagFiltersRef.current = [];
    tagFilterOriginRef.current = null;
    tagFilterRequestRef.current += 1;
    locallyExpandedNodeIdsRef.current = new Set();
    liveNavigationRef.current = emptyLiveNavigation();
    setLibraryView("all");
    setActiveTagFilters([]);
    const invalidatedTagSummaryVersion =
      ++tagSummaryRequestedVersionRef.current;
    tagSummarySettledVersionRef.current = Math.max(
      tagSummarySettledVersionRef.current,
      invalidatedTagSummaryVersion
    );
    settleTagSummaryRefreshWaiters(invalidatedTagSummaryVersion, null);
    setTagSummaries([]);
    setLocallyExpandedNodeIds(locallyExpandedNodeIdsRef.current);
    let engine!: NotesDraftEngine;
    const session = notesWorkspaceCoordinatorRegistry.openSession({
      repository,
      vaultRoot,
      onEvent(event) {
        if (engine.record.closing || sessionRecordRef.current !== engine.record) {
          return;
        }
        if (event.type === "pending") {
          dispatch({ type: "setLoading" });
          return;
        }
        if (
          event.result.kind === "authoritative" ||
          (event.result.kind === "failure" && event.result.workspace)
        ) {
          activeWorkspaceGenerationRef.current += 1;
        }
        if (
          event.result.kind !== "skipped" &&
          event.result.historyStatus &&
          (event.result.historyVersion === undefined ||
            event.result.historyVersion >= historyVersionRef.current)
        ) {
          if (event.result.historyVersion !== undefined) {
            historyVersionRef.current = event.result.historyVersion;
          }
          setHistoryStatus(event.result.historyStatus);
        }
        if (
          event.result.kind !== "skipped" &&
          event.result.invalidatesTagSummaries
        ) {
          void requestTagSummaryRefresh();
        }
        const expansionWorkspace =
          event.result.kind === "authoritative"
            ? event.result.workspace
            : event.result.kind === "failure"
              ? event.result.workspace
              : undefined;
        if (
          expansionWorkspace &&
          event.result.kind !== "skipped" &&
          event.result.clearLocalExpansionSubtreeId
        ) {
          const next = expansionsOutsideSubtree(
            locallyExpandedNodeIdsRef.current,
            expansionWorkspace,
            event.result.clearLocalExpansionSubtreeId
          );
          locallyExpandedNodeIdsRef.current = next;
          setLocallyExpandedNodeIds(next);
        }
        if (
          event.type === "synchronized" &&
          (event.sourceScope === null ||
            !sameScope(event.sourceScope, activeScopeRef.current))
        ) {
          const refreshScope = activeScopeRef.current;
          void session.enqueue(async (context) => {
            const workspace = await context.repository.loadWorkspace(
              context.vaultRoot,
              refreshScope
            );
            if (
              engine.record.closing ||
              sessionRecordRef.current !== engine.record ||
              sessionRef.current !== session ||
              !sameScope(activeScopeRef.current, refreshScope)
            ) {
              return { kind: "skipped" };
            }
            return {
              kind: "authoritative",
              workspace,
              suppressSynchronization: true
            };
          });
          return;
        }
        const authoritativeWorkspace =
          event.result.kind === "authoritative"
            ? event.result.workspace
            : event.result.kind === "failure"
              ? event.result.workspace
              : undefined;
        if (authoritativeWorkspace) {
          liveNavigationRef.current = reconcileLiveNavigation(
            liveNavigationRef.current,
            authoritativeWorkspace,
            event.result.kind === "skipped" ? undefined : event.result.uiUpdate
          );
        }
        dispatch({
          type: "settleQueueWork",
          result: event.result,
          hasPendingWork: event.hasPendingWork
        });
      },
      captureDraftCutoff: () => engine.captureDraftCutoff(),
      beforeStructural: (cutoff) => engine.flushDraftBarrier(cutoff),
      afterStructural: (cutoff) => engine.releaseDraftBarrier(cutoff),
      isCurrent: () =>
        !engine.record.closing &&
        sessionRecordRef.current === engine.record &&
        sessionRef.current === session,
      getScope: () => activeScopeRef.current
    });
    const host: NotesDraftEngineHost = {
      beginTextEntry,
      beginStandaloneTextEntry,
      completeHistoryOwner,
      discardHistoryEntry,
      persistDraftMutation,
      setDraftEditingNavigation,
      currentRecord: () => sessionRecordRef.current,
      currentSession: () => sessionRef.current,
      isDeletingNotesData: () => deletingNotesDataRef.current,
      onDraftsChanged: notifyDraftsListeners,
      onWriteErrorChanged: notifyWriteErrorListeners
    };
    engine = new NotesDraftEngine({
      repository,
      vaultRoot,
      session,
      writeQueue: createNotesWriteQueue(),
      host
    });
    sessionRecordRef.current = engine.record;
    sessionRef.current = session;
    draftEngineRef.current = engine;
    // Point the drafts external store at the freshly opened engine (empty
    // buffer). The engine wires its own recovery subscription internally.
    notifyDraftsListeners();
    notifyWriteErrorListeners();
    enqueueBufferedCommands(
      session,
      bufferedCommandsRef.current.splice(0)
    );

    return () => {
      engine.dispose();
      if (sessionRef.current === session) {
        sessionRef.current = null;
        // ref array is never reassigned; draining current buffered commands at teardown is intended
        // eslint-disable-next-line react-hooks/exhaustive-deps
        resolveBufferedCommands(bufferedCommandsRef.current.splice(0));
      }
    };
    // Session subscribe/teardown effect keyed on vault/repository; the engine's
    // host collaborators are stable callbacks invoked from the effect but omitted
    // so a re-render does not tear down and re-open the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    discardAttachmentUploadAttempts,
    repository,
    requestTagSummaryRefresh,
    settleTagSummaryRefreshWaiters,
    vaultRoot
  ]);

  useEffect(() => {
    finalCleanupTokenRef.current = null;
    return () => {
      const engine = draftEngineRef.current;
      if (engine) {
        void engine.beginShutdown();
      }
      const token = {};
      finalCleanupTokenRef.current = token;
      queueMicrotask(() => {
        if (finalCleanupTokenRef.current !== token) {
          return;
        }
        finalCleanupTokenRef.current = null;
        closedRef.current = true;
        const finalRecord = sessionRecordRef.current;
        sessionRecordRef.current = null;
        if (finalRecord && sessionRef.current === finalRecord.session) {
          sessionRef.current = null;
        }
        discardAttachmentUploadAttempts();
        // ref array is never reassigned; draining current buffered commands at teardown is intended
        // eslint-disable-next-line react-hooks/exhaustive-deps
        resolveBufferedCommands(bufferedCommandsRef.current.splice(0));
      });
    };
  }, [discardAttachmentUploadAttempts]);

  const runCommand = useCallback((work: NotesWorkspaceQueueWork): Promise<void> => {
    if (deletingNotesDataRef.current) {
      return Promise.resolve();
    }
    const session = sessionRef.current;
    if (session) {
      return session.enqueue(work);
    }
    if (closedRef.current) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      bufferedCommandsRef.current.push({ work, resolve });
    });
  }, []);

  const replaceLocalExpansions = useCallback(
    (nodeIds: ReadonlySet<NoteId>): void => {
      navigationVersionRef.current += 1;
      locallyExpandedNodeIdsRef.current = nodeIds;
      setLocallyExpandedNodeIds(nodeIds);
    },
    []
  );

  const captureHistorySnapshot = useCallback(
    (focus?: NotesHistoryFocus | null): NotesHistorySnapshot => {
      const navigation = liveNavigationRef.current;
      const resolvedFocus =
        focus === undefined
          ? navigation.editingNoteId
            ? {
                nodeId: navigation.editingNoteId,
                field: navigation.pendingFocusField ?? "title"
              }
            : null
          : focus;
      const origin = tagFilterOriginRef.current;
      const tagFilterOrigin: NotesHistoryLocationSnapshot | null = origin
        ? {
            scope: cloneWorkspaceScope(origin.scope),
            selectedId: origin.navigation.selectedId,
            zoomRootId: origin.navigation.zoomRootId,
            locallyExpandedNodeIds: [...origin.locallyExpandedNodeIds],
            focus: origin.navigation.editingNoteId
              ? {
                  nodeId: origin.navigation.editingNoteId,
                  field: origin.navigation.pendingFocusField ?? "title"
                }
              : null
          }
        : null;
      return {
        scope: activeScopeRef.current,
        selectedId: navigation.selectedId,
        zoomRootId: navigation.zoomRootId,
        locallyExpandedNodeIds: [...locallyExpandedNodeIdsRef.current],
        focus: resolvedFocus,
        tagFilterOrigin
      };
    },
    []
  );

  const registerHistoryOwner = useCallback(
    (
      context: NotesHistoryContext,
      owner: NotesWorkspaceCoordinatorSession
    ): NotesHistoryContext => {
      const owners = historyOwnerByEntryIdRef.current;
      owners.begin(context.entryId, owner);
      return context;
    },
    []
  );

  const beginTextEntry = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      nodeId: NoteId,
      focus: NotesHistoryFocus
    ): NotesHistoryContext | null =>
      supportsHistory(record.repository)
        ? registerHistoryOwner(
            record.session.history.beginTextBurst(
              nodeId,
              captureHistorySnapshot(focus)
            ),
            record.session
          )
        : null,
    [captureHistorySnapshot, registerHistoryOwner]
  );

  const beginStandaloneTextEntry = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      nodeId: NoteId,
      focus: NotesHistoryFocus
    ): NotesHistoryContext | null => {
      if (!supportsHistory(record.repository)) {
        return null;
      }
      record.session.history.closeTextBurst();
      const context = registerHistoryOwner(
        record.session.history.beginTextBurst(
          nodeId,
          captureHistorySnapshot(focus)
        ),
        record.session
      );
      record.session.history.closeTextBurst(context.entryId);
      return context;
    },
    [captureHistorySnapshot, registerHistoryOwner]
  );

  const closeTextBurst = useCallback((): void => {
    sessionRef.current?.history.closeTextBurst();
  }, []);

  const beginStructuralEntry = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      commandKind: string
    ): NotesHistoryContext | null => {
      if (!supportsHistory(record.repository)) {
        return null;
      }
      return registerHistoryOwner(
        record.session.history.beginStructuralEntry(
          commandKind,
          captureHistorySnapshot()
        ),
        record.session
      );
    },
    [captureHistorySnapshot, registerHistoryOwner]
  );

  const completeHistoryOwner = useCallback((entryId: string): void => {
    historyOwnerByEntryIdRef.current.complete(entryId);
  }, []);

  const rememberHistoryAfter = useCallback(
    (
      context: NotesHistoryContext | null | undefined,
      workspace: NotesWorkspace,
      uiUpdate?: NotesWorkspaceUiUpdate,
      focus?: NotesHistoryFocus | null,
      expandedNodeIds?: ReadonlySet<NoteId>
    ): void => {
      if (!context) {
        return;
      }
      const owner = historyOwnerByEntryIdRef.current.owner(context.entryId);
      if (
        !owner || sessionRef.current !== owner
      ) {
        owner?.history.discard(context.entryId);
        historyOwnerByEntryIdRef.current.discard(context.entryId);
        return;
      }
      liveNavigationRef.current = reconcileLiveNavigation(
        liveNavigationRef.current,
        workspace,
        uiUpdate
      );
      const after = captureHistorySnapshot(focus);
      owner.history.rememberAfter(context.entryId, {
        ...after,
        locallyExpandedNodeIds:
          expandedNodeIds === undefined
            ? after.locallyExpandedNodeIds
            : [...expandedNodeIds]
      });
      if (context.commandKind !== "text") {
        completeHistoryOwner(context.entryId);
      }
    },
    [captureHistorySnapshot, completeHistoryOwner]
  );

  const discardHistoryEntry = useCallback(
    (context: NotesHistoryContext | null | undefined): void => {
      if (!context) {
        return;
      }
      const owner = historyOwnerByEntryIdRef.current.owner(context.entryId);
      owner?.history.discard(context.entryId);
      historyOwnerByEntryIdRef.current.discard(context.entryId);
    },
    []
  );

  const settleInlineTextEntry = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      context: NotesHistoryContext | null,
      result: NotesWorkspaceQueueResult
    ): void => {
      if (!context) {
        return;
      }
      record.session.history.closeTextBurst(context.entryId);
      if (
        result.kind !== "skipped" &&
        result.committedHistoryEntryIds?.includes(context.entryId) &&
        historyOwnerByEntryIdRef.current.owner(context.entryId) ===
          record.session &&
        sessionRef.current === record.session
      ) {
        completeHistoryOwner(context.entryId);
      } else {
        discardHistoryEntry(context);
      }
    },
    [completeHistoryOwner, discardHistoryEntry]
  );

  const runStructuralCommand = useCallback(
    (
      commandKind: string,
      work: (
        context: NotesWorkspaceQueueContext,
        historyContext: NotesHistoryContext | null,
        record: NotesWorkspaceSessionRecord
      ) => Promise<NotesWorkspaceQueueResult> | NotesWorkspaceQueueResult,
      options?: StructuralCommandOptions
    ): Promise<void> => {
      if (deletingNotesDataRef.current || closedRef.current) {
        discardHistoryEntry(options?.historyContext);
        return Promise.resolve();
      }
      const currentRecord = sessionRecordRef.current;
      const invocationRecord =
        currentRecord?.repository === repository &&
        currentRecord.vaultRoot === vaultRoot
          ? currentRecord
          : null;
      const queueWork: NotesWorkspaceQueueWork = async (context) => {
        const record = invocationRecord ?? sessionRecordRef.current;
        if (
          !record ||
          context.repository !== repository ||
          context.vaultRoot !== vaultRoot ||
          record.repository !== context.repository ||
          record.vaultRoot !== context.vaultRoot
        ) {
          return { kind: "skipped" };
        }
        const historyContext =
          options && "historyContext" in options
            ? options.historyContext ?? null
            : beginStructuralEntry(record, commandKind);
        try {
          const result = await work(context, historyContext, record);
          const owner = historyContext
            ? historyOwnerByEntryIdRef.current.owner(historyContext.entryId)
            : undefined;
          const structuralCommitted = Boolean(
            historyContext &&
              result.kind === "failure" &&
              result.committedHistoryEntryIds?.includes(historyContext.entryId)
          );
          const retainHistory =
            options?.retainHistoryOnFailure === true &&
            result.kind === "failure";
          if (
            !retainHistory &&
            ((result.kind !== "authoritative" && !structuralCommitted) ||
              (historyContext !== null &&
                (owner === undefined ||
                  historyOwnerByEntryIdRef.current.isInFlight(
                    historyContext.entryId
                  ))))
          ) {
            discardHistoryEntry(historyContext);
          }
          return result;
        } catch (cause) {
          if (!options?.retainHistoryOnFailure) {
            discardHistoryEntry(historyContext);
          }
          throw cause;
        }
      };
      const record = sessionRecordRef.current;
      if (
        record &&
        !record.closing &&
        record.repository === repository &&
        record.vaultRoot === vaultRoot
      ) {
        return record.session.enqueueStructural(queueWork);
      }
      return new Promise<void>((resolve) => {
        bufferedCommandsRef.current.push({
          work: queueWork,
          structural: true,
          resolve
        });
      });
    },
    [beginStructuralEntry, discardHistoryEntry, repository, vaultRoot]
  );

  const persistDraftMutation = useCallback(
    async (
      context: NotesWorkspaceQueueContext,
      attempt: DraftWriteAttempt
    ): Promise<NotesWorkspaceQueueResult> => {
      const { nodeId, draft, historyContext } = attempt;
      if (!confirmedState(context).nodesById[nodeId]) {
        return { kind: "skipped" };
      }
      try {
        const mutation = unwrapNotesMutation(
          await context.repository.updateNode(
            context.vaultRoot,
            {
              id: nodeId,
              title: draft.title,
              note: draft.note
            },
            ...historyArguments(historyContext)
          )
        );
        const projection = await projectNotesMutation(
          context,
          mutation,
          activeScopeRef.current
        );
        const appliedContext = appliedHistoryContext(historyContext, mutation);
        if (historyContext && mutation.atomic && !appliedContext) {
          discardHistoryEntry(historyContext);
        }
        rememberHistoryAfter(
          appliedContext,
          projection.workspace,
          undefined,
          attempt.focus
        );
        return directMutationResult(mutation, projection);
      } catch (cause) {
        return { kind: "failure", error: errorMessage(cause) };
      }
    },
    [discardHistoryEntry, rememberHistoryAfter]
  );

  const setDraftEditingNavigation = useCallback(
    (nodeId: NoteId, field: NotesHistoryFocusField): void => {
      liveNavigationRef.current = {
        ...liveNavigationRef.current,
        selectedId: nodeId,
        editingNoteId: nodeId,
        pendingFocusField: field
      };
    },
    []
  );

  // The draft pipeline lives in NotesDraftEngine; these are thin, stable
  // delegators onto the currently active engine so action identity never churns.
  const updateNodeDraft = useCallback(
    (
      nodeId: NoteId,
      patch: Pick<NoteNode, "title" | "note">,
      field: NotesHistoryFocusField = "title"
    ): void => {
      draftEngineRef.current?.updateNodeDraft(nodeId, patch, field);
    },
    []
  );

  const flushNodeDraft = useCallback(
    (nodeId: NoteId): Promise<boolean> =>
      draftEngineRef.current?.flushNodeDraft(nodeId) ?? Promise.resolve(false),
    []
  );

  const retryFailedDraft = useCallback(
    (nodeId: NoteId): Promise<void> =>
      draftEngineRef.current?.retryFailedDraft(nodeId) ?? Promise.resolve(),
    []
  );

  const retryLastFailedWrite = useCallback(
    (): Promise<void> =>
      draftEngineRef.current?.retryLastFailedWrite() ?? Promise.resolve(),
    []
  );

  const flushAllDraftsBeforeStructural = useCallback(
    (): Promise<boolean> =>
      draftEngineRef.current?.flushAllDrafts() ?? Promise.resolve(false),
    []
  );

  const flushDraftBeforeStructural = useCallback(
    (_nodeId: NoteId): Promise<boolean> => flushAllDraftsBeforeStructural(),
    [flushAllDraftsBeforeStructural]
  );

  const replayHistory = useCallback(
    async (direction: "undo" | "redo"): Promise<void> => {
      const record = sessionRecordRef.current;
      const session = sessionRef.current;
      if (!record || !session || record.session !== session) {
        return;
      }
      let replayedSnapshot: NotesHistorySnapshot | null = null;
      let replayedExpansionIds: ReadonlySet<NoteId> | null = null;
      let replayedScope: NotesWorkspaceScope | null = null;
      let replayedTagFilterOrigin: TagFilterOrigin | null | undefined;
      await session.enqueueStructural(async (context) => {
        const replay =
          direction === "undo" ? context.repository.undo : context.repository.redo;
        if (!replay) {
          return { kind: "skipped" };
        }
        const currentScope = activeScopeRef.current;
        const result = await replay(
          context.vaultRoot,
          session.history.sessionId,
          currentScope
        );
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== session
        ) {
          return authoritative(
            result.workspace,
            undefined,
            {
              canUndo: result.canUndo,
              canRedo: result.canRedo
            },
            {
              scopeAgnostic: currentScope.kind !== "active",
              invalidatesTagSummaries: true
            }
          );
        }
        const replayOwner = result.replayedEntryId
          ? historyOwnerByEntryIdRef.current.owner(result.replayedEntryId)
          : undefined;
        replayedSnapshot =
          replayOwner === session
            ? session.history.snapshotForReplay(
                result.replayedEntryId,
                direction
              )
            : null;
        replayedScope = replayedSnapshot?.scope ?? currentScope;
        if (replayedSnapshot) {
          const origin = replayedSnapshot.tagFilterOrigin;
          replayedTagFilterOrigin = origin
            ? {
                scope: cloneWorkspaceScope(origin.scope),
                libraryView: (() => {
                  const library = libraryStateForScope(origin.scope).view;
                  return library === "tags" ? "all" : library;
                })(),
                navigation: {
                  selectedId: origin.selectedId,
                  zoomRootId: origin.zoomRootId,
                  editingNoteId: origin.focus?.nodeId ?? null,
                  pendingFocusId: origin.focus?.nodeId ?? null,
                  pendingFocusField: origin.focus?.field ?? null
                },
                locallyExpandedNodeIds: new Set(
                  origin.locallyExpandedNodeIds
                )
              }
            : null;
        }
        let replayedWorkspace = result.workspace;
        if (!sameScope(replayedScope, currentScope)) {
          replayedWorkspace = await context.repository.loadWorkspace(
            context.vaultRoot,
            replayedScope
          );
          if (
            record.closing ||
            sessionRecordRef.current !== record ||
            sessionRef.current !== session
          ) {
            return authoritative(
              result.workspace,
              undefined,
              {
                canUndo: result.canUndo,
                canRedo: result.canRedo
              },
              {
                scopeAgnostic: currentScope.kind !== "active",
                invalidatesTagSummaries: true
              }
            );
          }
        }
        activeScopeRef.current = replayedScope;
        const existingIds = new Set(replayedWorkspace.nodes.map((item) => item.id));
        replayedExpansionIds = new Set(
          (replayedSnapshot?.locallyExpandedNodeIds ?? [
            ...locallyExpandedNodeIdsRef.current
          ]).filter((nodeId) => existingIds.has(nodeId))
        );
        const focus = replayedSnapshot?.focus ?? null;
        return authoritative(
          replayedWorkspace,
          replayedSnapshot
            ? {
                selectedId: replayedSnapshot.selectedId,
                zoomRootId: replayedSnapshot.zoomRootId,
                editingNoteId: focus?.nodeId ?? null,
                pendingFocusId: focus?.nodeId ?? null,
                pendingFocusField: focus?.field ?? null
              }
            : undefined,
          { canUndo: result.canUndo, canRedo: result.canRedo },
          { invalidatesTagSummaries: true }
        );
      });
      if (
        record.closing ||
        sessionRecordRef.current !== record ||
        sessionRef.current !== session
      ) {
        return;
      }
      if (replayedExpansionIds) {
        replaceLocalExpansions(replayedExpansionIds);
      }
      if (replayedScope) {
        const library = libraryStateForScope(replayedScope);
        setLibraryView(library.view);
        requestedTagFiltersRef.current = library.filters;
        setActiveTagFilters(library.filters);
        if (replayedTagFilterOrigin !== undefined) {
          tagFilterOriginRef.current = replayedTagFilterOrigin;
        }
      }
    },
    [
      replaceLocalExpansions,
    ]
  );

  const undo = useCallback(() => replayHistory("undo"), [replayHistory]);
  const redo = useCallback(() => replayHistory("redo"), [replayHistory]);

  const loadLibraryScope = useCallback(
    async (
      view: NotesLibraryView,
      scope: NotesWorkspaceScope
    ): Promise<void> => {
      if (
        (sessionRecordRef.current?.drafts.size ?? 0) > 0 &&
        !(await flushAllDraftsBeforeStructural())
      ) {
        return;
      }
      const record = sessionRecordRef.current;
      if (!record) return;
      const session = record.session;
      let loaded = false;
      await runCommand(async (context) => {
        const workspace = await context.repository.loadWorkspace(
          context.vaultRoot,
          scope
        );
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== session
        ) {
          return { kind: "skipped" };
        }
        loaded = true;
        activeScopeRef.current = scope;
        return authoritative(workspace, {
          selectedId: null,
          zoomRootId: null,
          editingNoteId: null,
          pendingFocusId: null
        });
      });
      if (
        !loaded ||
        record.closing ||
        sessionRecordRef.current !== record ||
        sessionRef.current !== session
      ) {
        return;
      }
      setLibraryView(view);
      requestedTagFiltersRef.current = [];
      tagFilterOriginRef.current = null;
      tagFilterRequestRef.current += 1;
      setActiveTagFilters([]);
      replaceLocalExpansions(new Set());
    },
    [flushAllDraftsBeforeStructural, replaceLocalExpansions, runCommand]
  );

  const selectLibraryView = useCallback(
    async (view: NotesLibraryView): Promise<void> => {
      if (view !== "tags") {
        await loadLibraryScope(view, scopeForLibraryView(view));
        return;
      }
      if (requestedTagFiltersRef.current.length > 0) {
        return;
      }
      if (
        (sessionRecordRef.current?.drafts.size ?? 0) > 0 &&
        !(await flushAllDraftsBeforeStructural())
      ) {
        return;
      }
      const record = sessionRecordRef.current;
      if (!record) {
        return;
      }
      const originLibrary = libraryStateForScope(activeScopeRef.current);
      const chooserOrigin: TagFilterOrigin = {
        scope: cloneWorkspaceScope(activeScopeRef.current),
        libraryView:
          originLibrary.view === "tags" ? "all" : originLibrary.view,
        navigation: { ...liveNavigationRef.current },
        locallyExpandedNodeIds: new Set(locallyExpandedNodeIdsRef.current)
      };
      let listedTags: readonly NoteTagSummary[] | null = null;
      await runCommand(async () => {
        listedTags = await requestTagSummaryRefresh();
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== record.session
        ) {
          return { kind: "skipped" };
        }
        return authoritative(
          { nodes: [] },
          {
            selectedId: null,
            zoomRootId: null,
            editingNoteId: null,
            pendingFocusId: null
          }
        );
      });
      if (
        !listedTags ||
        record.closing ||
        sessionRecordRef.current !== record ||
        sessionRef.current !== record.session
      ) {
        return;
      }
      tagFilterOriginRef.current = chooserOrigin;
      setLibraryView("tags");
      replaceLocalExpansions(new Set());
    }, [
      flushAllDraftsBeforeStructural,
      loadLibraryScope,
      replaceLocalExpansions,
      requestTagSummaryRefresh,
      runCommand
    ]
  );

  const toggleTagFilter = useCallback(
    async (filter: NoteTagFilter): Promise<void> => {
      const currentFilters = requestedTagFiltersRef.current;
      const key = tagFilterKey(filter);
      const exists = currentFilters.some(
        (candidate) => tagFilterKey(candidate) === key
      );
      const nextFilters = canonicalizeTagFilters(
        exists
          ? currentFilters.filter((candidate) => tagFilterKey(candidate) !== key)
          : [...currentFilters, filter]
      );
      const requestId = ++tagFilterRequestRef.current;
      requestedTagFiltersRef.current = nextFilters;
      let capturedOrigin = false;
      const rollbackRequestedFilters = () => {
        if (tagFilterRequestRef.current !== requestId) {
          return;
        }
        requestedTagFiltersRef.current = currentFilters;
        if (capturedOrigin) {
          tagFilterOriginRef.current = null;
        }
      };

      if (
        currentFilters.length === 0 &&
        nextFilters.length > 0 &&
        tagFilterOriginRef.current === null
      ) {
        const originLibrary = libraryStateForScope(activeScopeRef.current);
        tagFilterOriginRef.current = {
          scope: cloneWorkspaceScope(activeScopeRef.current),
          libraryView:
            originLibrary.view === "tags" ? "all" : originLibrary.view,
          navigation: { ...liveNavigationRef.current },
          locallyExpandedNodeIds: new Set(locallyExpandedNodeIdsRef.current)
        };
        capturedOrigin = true;
      }

      if (
        (sessionRecordRef.current?.drafts.size ?? 0) > 0 &&
        !(await flushAllDraftsBeforeStructural())
      ) {
        rollbackRequestedFilters();
        return;
      }
      const record = sessionRecordRef.current;
      if (!record) {
        rollbackRequestedFilters();
        return;
      }
      const session = record.session;
      const origin = tagFilterOriginRef.current;
      const nextScope: NotesWorkspaceScope =
        nextFilters.length > 0
          ? { kind: "tags", tags: nextFilters }
          : cloneWorkspaceScope(origin?.scope ?? { kind: "active" });
      let loaded = false;
      let restoredExpansions: ReadonlySet<NoteId> = new Set();

      await runCommand(async (context) => {
        if (tagFilterRequestRef.current !== requestId) {
          return { kind: "skipped" };
        }
        const [workspace, countedTags] = await Promise.all([
          context.repository.loadWorkspace(context.vaultRoot, nextScope),
          requestTagSummaryRefresh()
        ]);
        if (
          tagFilterRequestRef.current !== requestId ||
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== session
        ) {
          return { kind: "skipped" };
        }
        if (!countedTags) {
          return { kind: "skipped" };
        }
        loaded = true;
        activeScopeRef.current = nextScope;
        if (nextFilters.length > 0) {
          return authoritative(workspace, {
            selectedId: null,
            zoomRootId: null,
            editingNoteId: null,
            pendingFocusId: null
          });
        }
        const restoration = origin
          ? restoredTagFilterNavigation(workspace, origin)
          : {
              uiUpdate: {
                selectedId: null,
                zoomRootId: null,
                editingNoteId: null,
                pendingFocusId: null
              },
              expandedNodeIds: new Set<NoteId>()
            };
        restoredExpansions = restoration.expandedNodeIds;
        return authoritative(workspace, restoration.uiUpdate);
      });

      if (
        !loaded ||
        tagFilterRequestRef.current !== requestId ||
        record.closing ||
        sessionRecordRef.current !== record ||
        sessionRef.current !== session
      ) {
        rollbackRequestedFilters();
        return;
      }
      setActiveTagFilters(nextFilters);
      if (nextFilters.length > 0) {
        setLibraryView("tags");
        replaceLocalExpansions(new Set());
        return;
      }
      setLibraryView(origin?.libraryView ?? "all");
      replaceLocalExpansions(restoredExpansions);
      tagFilterOriginRef.current = null;
    },
    [
      flushAllDraftsBeforeStructural,
      replaceLocalExpansions,
      requestTagSummaryRefresh,
      runCommand
    ]
  );

  const searchNotes = useCallback(
    async (query: string): Promise<NoteSearchResult[]> => {
      const parsed = parseAndValidateNoteSearchQuery(query);
      if (!parsed.ok) {
        throw new Error(parsed.error.message);
      }
      const structured =
        parsed.query.requiredTags.length > 0 ||
        parsed.query.excludedTags.length > 0 ||
        parsed.query.orGroups.length > 0;
      if (!structured) {
        return repository.search(vaultRoot, parsed.query.text);
      }
      if (!repository.searchStructured) {
        throw new Error("Structured Notes search is unavailable.");
      }
      return repository.searchStructured(vaultRoot, parsed.query);
    },
    [repository, vaultRoot]
  );

  const openSearchResult = useCallback(
    async (nodeId: NoteId): Promise<void> => {
      if (
        (sessionRecordRef.current?.drafts.size ?? 0) > 0 &&
        !(await flushAllDraftsBeforeStructural())
      ) {
        return;
      }
      const record = sessionRecordRef.current;
      if (!record) return;
      const session = record.session;
      let expandedNodeIds: ReadonlySet<NoteId> = new Set();
      let loaded = false;
      await runCommand(async (context) => {
        const workspace = await context.repository.loadWorkspace(
          context.vaultRoot,
          { kind: "active" }
        );
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== session
        ) {
          return { kind: "skipped" };
        }
        loaded = true;
        activeScopeRef.current = { kind: "active" };
        const navigation = searchNavigation(workspace, nodeId);
        expandedNodeIds = navigation?.expandedNodeIds ?? new Set();
        return authoritative(
          workspace,
          navigation
            ? {
                selectedId: nodeId,
                zoomRootId: navigation.rootId,
                editingNoteId: nodeId,
                pendingFocusId: nodeId
              }
            : {
                selectedId: null,
                zoomRootId: null,
                editingNoteId: null,
                pendingFocusId: null
              }
        );
      });
      if (
        !loaded ||
        record.closing ||
        sessionRecordRef.current !== record ||
        sessionRef.current !== session
      ) {
        return;
      }
      setLibraryView("all");
      requestedTagFiltersRef.current = [];
      tagFilterOriginRef.current = null;
      tagFilterRequestRef.current += 1;
      setActiveTagFilters([]);
      replaceLocalExpansions(expandedNodeIds);
    },
    [flushAllDraftsBeforeStructural, replaceLocalExpansions, runCommand]
  );

  const acknowledgeFocus = useCallback(async (nodeId: NoteId) => {
    if (liveNavigationRef.current.pendingFocusId === nodeId) {
      liveNavigationRef.current = {
        ...liveNavigationRef.current,
        pendingFocusId: null,
        pendingFocusField: null
      };
    }
    dispatch({ type: "acknowledgePendingFocus", nodeId });
  }, []);

  const focusNode = useCallback(async (nodeId: NoteId) => {
    void flushNodeDraft(nodeId);
    navigationVersionRef.current += 1;
    liveNavigationRef.current = {
      ...liveNavigationRef.current,
      selectedId: nodeId,
      editingNoteId: nodeId,
      pendingFocusId: nodeId,
      pendingFocusField: "title"
    };
    dispatch({ type: "focusNode", nodeId });
  }, [flushNodeDraft]);

  const createRoot = useCallback(async () => {
    const transitionToAll = libraryViewRef.current !== "all";
    let created = false;
    const creation = { record: null as NotesWorkspaceSessionRecord | null };
    await runStructuralCommand("create", async (context, historyContext) => {
      const ownerRecord = sessionRecordRef.current;
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
      if (
        ownerRecord.closing ||
        sessionRecordRef.current !== ownerRecord ||
        sessionRef.current !== ownerRecord.session
      ) {
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
      if (
        ownerRecord.closing ||
        sessionRecordRef.current !== ownerRecord ||
        sessionRef.current !== ownerRecord.session
      ) {
        return authoritative(
          mutation.workspace,
          undefined,
          mutation.historyStatus,
          { invalidatesTagSummaries: true }
        );
      }
      created = true;
      creation.record = ownerRecord;
      activeScopeRef.current = { kind: "active" };
      const uiUpdate = {
        selectedId: id,
        editingNoteId: id,
        pendingFocusId: id,
        pendingFocusField: "title" as const,
        zoomRootId: null
      };
      rememberHistoryAfter(
        appliedHistoryContext(historyContext, mutation),
        mutation.workspace,
        uiUpdate,
        undefined,
        transitionToAll ? new Set() : locallyExpandedNodeIdsRef.current
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
      !creation.record.closing &&
      sessionRecordRef.current === creation.record &&
      sessionRef.current === creation.record.session &&
      transitionToAll
    ) {
      setLibraryView("all");
      requestedTagFiltersRef.current = [];
      tagFilterOriginRef.current = null;
      tagFilterRequestRef.current += 1;
      setActiveTagFilters([]);
      replaceLocalExpansions(new Set());
    }
  }, [
    runStructuralCommand,
    rememberHistoryAfter,
    replaceLocalExpansions,
  ]);

  const createChild = useCallback(
    async (nodeId: NoteId) => {
      return runStructuralCommand("create", async (context, historyContext) => {
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
          activeScopeRef.current
        );
        const uiUpdate = {
          selectedId: id,
          editingNoteId: id,
          pendingFocusId: id,
          pendingFocusField: "title" as const
        };
        rememberHistoryAfter(
          appliedHistoryContext(historyContext, mutation),
          projection.workspace,
          uiUpdate
        );
        return directMutationResult(mutation, projection, uiUpdate);
      });
    },
    [
      runStructuralCommand,
      rememberHistoryAfter,
    ]
  );

  const splitNode = useCallback(
    async (
      nodeId: NoteId,
      newNodeId: NoteId,
      prefix: string,
      suffix: string,
      options?: NotesWorkspaceCompoundOptions
    ) => {
      const hadCentralDraft =
        sessionRecordRef.current?.drafts.has(nodeId) ?? false;
      const record = sessionRecordRef.current;
      const centralDraft = record?.drafts.get(nodeId);
      const hasCentralDraft = centralDraft !== undefined;
      const inlineDraft =
        hadCentralDraft || hasCentralDraft ? undefined : options?.draft;
      let succeeded = false;
      const completion = runStructuralCommand(
        "split",
        async (context, historyContext, executionRecord) => {
          if (!confirmedState(context).nodesById[nodeId]) {
            return { kind: "skipped" };
          }
          const inlineTextContext = inlineDraft
            ? beginTextEntry(executionRecord, nodeId, {
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
                rememberHistoryAfter(
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
            activeScopeRef.current
          );
          settleInlineTextEntry(executionRecord, inlineTextContext, result);
          if (result.kind === "authoritative") {
            rememberHistoryAfter(
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
      return completion.then(() => {
        if (succeeded) {
          notifySuccess(options?.onSuccess);
        }
      });
    },
    [
      runStructuralCommand,
      beginTextEntry,
      rememberHistoryAfter,
      settleInlineTextEntry,
    ]
  );

  const updateNode = useCallback(
    async (nodeId: NoteId, patch: Pick<NoteNode, "title" | "note">) => {
      return runStructuralCommand("update", async (context, historyContext) => {
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
          activeScopeRef.current
        );
        rememberHistoryAfter(
          appliedHistoryContext(historyContext, mutation),
          projection.workspace
        );
        return directMutationResult(mutation, projection);
      });
    },
    [
      rememberHistoryAfter,
      runStructuralCommand
    ]
  );

  const moveNode = useCallback(
    async (
      input: MoveNoteNodeInput,
      focusNodeId?: NoteId | null,
      options?: NotesWorkspaceCompoundOptions
    ) => {
      const hadCentralDraft =
        sessionRecordRef.current?.drafts.has(input.id) ?? false;
      const record = sessionRecordRef.current;
      const centralDraft = record?.drafts.get(input.id);
      const hasCentralDraft = centralDraft !== undefined;
      const inlineDraft =
        hadCentralDraft || hasCentralDraft ? undefined : options?.draft;
      let succeeded = false;
      await runStructuralCommand("move", async (context, historyContext, executionRecord) => {
        const before = confirmedState(context);
        const expandNodeId = options?.expandNodeId;
        if (
          !hasMoveDependencies(before, input) ||
          (expandNodeId !== undefined && !before.nodesById[expandNodeId])
        ) {
          return { kind: "skipped" };
        }
        const inlineTextContext = inlineDraft
          ? beginTextEntry(executionRecord, input.id, {
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
              rememberHistoryAfter(
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
          activeScopeRef.current
        );
        settleInlineTextEntry(executionRecord, inlineTextContext, result);
        if (result.kind === "authoritative") {
          rememberHistoryAfter(
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
          rememberHistoryAfter(
            historyContext,
            result.workspace
          );
        }
        succeeded =
          result.kind === "authoritative" &&
          (!historyContext ||
            Boolean(
              result.committedHistoryEntryIds?.includes(
                historyContext.entryId
              )
            ));
        return result;
      });
      return succeeded;
    },
    [
      runStructuralCommand,
      beginTextEntry,
      rememberHistoryAfter,
      settleInlineTextEntry,
    ]
  );

  const toggleComplete = useCallback(
    async (nodeId: NoteId) => {
      return runStructuralCommand("complete", async (context, historyContext) => {
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
          activeScopeRef.current
        );
        rememberHistoryAfter(
          appliedHistoryContext(historyContext, mutation),
          projection.workspace
        );
        return directMutationResult(mutation, projection);
      });
    },
    [
      runStructuralCommand,
      rememberHistoryAfter,
    ]
  );

  const toggleCollapsed = useCallback(
    async (nodeId: NoteId) => {
      closeTextBurst();
      if (locallyExpandedNodeIdsRef.current.has(nodeId)) {
        const next = new Set(locallyExpandedNodeIdsRef.current);
        next.delete(nodeId);
        replaceLocalExpansions(next);
        return;
      }
      return runStructuralCommand("collapse", async (context, historyContext) => {
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
          activeScopeRef.current
        );
        rememberHistoryAfter(
          appliedHistoryContext(historyContext, mutation),
          projection.workspace
        );
        return directMutationResult(mutation, projection);
      });
    },
    [
      runStructuralCommand,
      closeTextBurst,
      rememberHistoryAfter,
      replaceLocalExpansions,
    ]
  );

  const runAtomicSubtreeCommand = useCallback(
    async (
      commandKind: string,
      method:
        | "expandAll"
        | "collapseAll"
        | "sortSubtreeAscending"
        | "sortSubtreeDescending",
      nodeId: NoteId,
      reconcileExpansions: boolean
    ) => {
      return runStructuralCommand(
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
            activeScopeRef.current
          );
          const appliedContext = appliedHistoryContext(
            historyContext,
            mutation
          );
          let expandedNodeIds: ReadonlySet<NoteId> | undefined;
          if (reconcileExpansions) {
            const next = expansionsOutsideSubtree(
              locallyExpandedNodeIdsRef.current,
              mutation.workspace,
              nodeId
            );
            replaceLocalExpansions(next);
            expandedNodeIds = next;
          }
          rememberHistoryAfter(
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
    },
    [rememberHistoryAfter, replaceLocalExpansions, runStructuralCommand]
  );

  const expandAll = useCallback(
    (nodeId: NoteId) =>
      runAtomicSubtreeCommand("expand-all", "expandAll", nodeId, true),
    [runAtomicSubtreeCommand]
  );

  const collapseAll = useCallback(
    (nodeId: NoteId) =>
      runAtomicSubtreeCommand("collapse-all", "collapseAll", nodeId, true),
    [runAtomicSubtreeCommand]
  );

  const sortSubtreeAscending = useCallback(
    (nodeId: NoteId) =>
      runAtomicSubtreeCommand(
        "sort-ascending",
        "sortSubtreeAscending",
        nodeId,
        false
      ),
    [runAtomicSubtreeCommand]
  );

  const sortSubtreeDescending = useCallback(
    (nodeId: NoteId) =>
      runAtomicSubtreeCommand(
        "sort-descending",
        "sortSubtreeDescending",
        nodeId,
        false
      ),
    [runAtomicSubtreeCommand]
  );

  const toggleStar = useCallback(
    async (nodeId: NoteId) => {
      return runStructuralCommand("star", async (context, historyContext) => {
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
          activeScopeRef.current
        );
        rememberHistoryAfter(
          appliedHistoryContext(historyContext, mutation),
          projection.workspace
        );
        return directMutationResult(mutation, projection);
      });
    },
    [
      runStructuralCommand,
      rememberHistoryAfter,
    ]
  );

  const duplicateNode = useCallback(
    async (nodeId: NoteId) => {
      return runStructuralCommand("duplicate", async (context, historyContext) => {
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
          activeScopeRef.current
        );
        const uiUpdate = duplicateId
          ? {
              selectedId: duplicateId,
              editingNoteId: duplicateId,
              pendingFocusId: duplicateId,
              pendingFocusField: "title" as const
            }
          : undefined;
        rememberHistoryAfter(
          appliedHistoryContext(historyContext, mutation),
          projection.workspace,
          uiUpdate
        );
        return directMutationResult(mutation, projection, uiUpdate);
      });
    },
    [
      runStructuralCommand,
      rememberHistoryAfter,
    ]
  );

  const runRootLifecycle = useCallback(
    async (
      nodeId: NoteId,
      mutation: "archive" | "unarchive" | "trash"
    ): Promise<void> => {
      const ownerRecord = sessionRecordRef.current;
      if (!ownerRecord) {
        return;
      }
      const visibleNode = stateRef.current.nodesById[nodeId];
      if (!visibleNode || visibleNode.parentId !== null) {
        return;
      }

      const liveNavigation = liveNavigationRef.current;
      const beforeNavigation: NotesLifecycleNavigationSnapshot = {
        selectedId: liveNavigation.selectedId,
        zoomRootId: liveNavigation.zoomRootId,
        editingNoteId: liveNavigation.editingNoteId,
        pendingFocusId: liveNavigation.pendingFocusId,
        pendingFocusField: liveNavigation.pendingFocusField,
        locallyExpandedNodeIds: new Set(locallyExpandedNodeIdsRef.current),
        scope: activeScopeRef.current
      };
      const beforeNavigationVersion = navigationVersionRef.current;
      const isLifecycleOwnerActive = (): boolean =>
        !ownerRecord.closing &&
        sessionRecordRef.current === ownerRecord &&
        sessionRef.current === ownerRecord.session;
      const lifecycleResult: {
        transition: NotesLifecycleNavigationTransition | null;
        recoveredToActive: boolean;
        resolvedNavigationVersion: number | null;
      } = {
        transition: null,
        recoveredToActive: false,
        resolvedNavigationVersion: null
      };

      await runStructuralCommand(
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
          if (
            ownerRecord.closing ||
            sessionRecordRef.current !== ownerRecord ||
            sessionRef.current !== ownerRecord.session
          ) {
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
          const requestedScope = activeScopeRef.current;
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
            activeScopeRef.current = { kind: "active" };
            try {
              projectedWorkspace = await context.repository.loadWorkspace(
                context.vaultRoot,
                activeScopeRef.current
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
          const navigationVersion = navigationVersionRef.current;
          const navigation =
            navigationVersion === beforeNavigationVersion
              ? beforeNavigation
              : {
                  selectedId: liveNavigationRef.current.selectedId,
                  zoomRootId: liveNavigationRef.current.zoomRootId,
                  editingNoteId: liveNavigationRef.current.editingNoteId,
                  pendingFocusId: liveNavigationRef.current.pendingFocusId,
                  pendingFocusField:
                    liveNavigationRef.current.pendingFocusField,
                  locallyExpandedNodeIds: new Set(
                    locallyExpandedNodeIdsRef.current
                  ),
                  scope: activeScopeRef.current
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
          rememberHistoryAfter(
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

      if (
        ownerRecord.closing ||
        sessionRecordRef.current !== ownerRecord ||
        sessionRef.current !== ownerRecord.session
      ) {
        return;
      }

      if (lifecycleResult.transition) {
        if (
          lifecycleResult.resolvedNavigationVersion ===
          navigationVersionRef.current
        ) {
          replaceLocalExpansions(
            lifecycleResult.transition.after.locallyExpandedNodeIds
          );
        }
      }
      if (lifecycleResult.recoveredToActive) {
        setLibraryView("all");
        requestedTagFiltersRef.current = [];
        tagFilterOriginRef.current = null;
        tagFilterRequestRef.current += 1;
        setActiveTagFilters([]);
      }
    },
    [
      runStructuralCommand,
      rememberHistoryAfter,
      replaceLocalExpansions,
    ]
  );

  const archiveNode = useCallback(
    (nodeId: NoteId) => runRootLifecycle(nodeId, "archive"),
    [runRootLifecycle]
  );

  const unarchiveNode = useCallback(
    (nodeId: NoteId) => runRootLifecycle(nodeId, "unarchive"),
    [runRootLifecycle]
  );

  const removeEmptyNode = useCallback(
    async (
      nodeId: NoteId,
      focusNodeId?: NoteId | null,
      options?: NotesWorkspaceCompoundOptions
    ) => {
      const hadCentralDraft =
        sessionRecordRef.current?.drafts.has(nodeId) ?? false;
      const record = sessionRecordRef.current;
      const centralDraft = record?.drafts.get(nodeId);
      const hasCentralDraft = centralDraft !== undefined;
      const inlineDraft =
        hadCentralDraft || hasCentralDraft ? undefined : options?.draft;
      return runStructuralCommand(
        "remove",
        async (context, historyContext, executionRecord) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        const inlineTextContext = inlineDraft
          ? beginTextEntry(executionRecord, nodeId, {
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
              rememberHistoryAfter(
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
          activeScopeRef.current
        );
        settleInlineTextEntry(executionRecord, inlineTextContext, result);
        if (result.kind === "authoritative") {
          rememberHistoryAfter(
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
    },
    [
      runStructuralCommand,
      beginTextEntry,
      rememberHistoryAfter,
      settleInlineTextEntry,
    ]
  );

  const deleteNode = useCallback(
    async (nodeId: NoteId) => {
      if (stateRef.current.nodesById[nodeId]?.parentId === null) {
        return runRootLifecycle(nodeId, "trash");
      }
      return runStructuralCommand("trash", async (context, historyContext) => {
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
          activeScopeRef.current
        );
        rememberHistoryAfter(
          appliedHistoryContext(historyContext, mutation),
          projection.workspace
        );
        return directMutationResult(mutation, projection);
      });
    },
    [
      runStructuralCommand,
      rememberHistoryAfter,
      runRootLifecycle
    ]
  );

  const restoreNode = useCallback(
    async (nodeId: NoteId) => {
      closeTextBurst();
      const ownerRecord = sessionRecordRef.current;
      const beforeNavigationVersion = navigationVersionRef.current;
      const followsViewedTrashRoot =
        activeScopeRef.current.kind === "trash" &&
        rootIdForNode(
          stateRef.current,
          liveNavigationRef.current.zoomRootId
        ) === nodeId;
      let followedIntoActive = false;
      await runStructuralCommand("restore", async (context, historyContext) => {
        const mutation = unwrapNotesMutation(await context.repository.restoreNode(
          context.vaultRoot,
          nodeId,
          ...historyArguments(historyContext)
        ));
        const canFollowIntoActive =
          followsViewedTrashRoot &&
          ownerRecord !== null &&
          !ownerRecord.closing &&
          sessionRecordRef.current === ownerRecord &&
          sessionRef.current === ownerRecord.session &&
          navigationVersionRef.current === beforeNavigationVersion &&
          activeScopeRef.current.kind === "trash";
        const nextScope: NotesWorkspaceScope = canFollowIntoActive
          ? { kind: "active" }
          : activeScopeRef.current;
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
          activeScopeRef.current = nextScope;
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
        rememberHistoryAfter(
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
        ownerRecord.closing ||
        sessionRecordRef.current !== ownerRecord ||
        sessionRef.current !== ownerRecord.session ||
        navigationVersionRef.current !== beforeNavigationVersion
      ) {
        return;
      }
      setLibraryView("all");
      requestedTagFiltersRef.current = [];
      tagFilterOriginRef.current = null;
      tagFilterRequestRef.current += 1;
      setActiveTagFilters([]);
      replaceLocalExpansions(new Set());
    },
    [
      closeTextBurst,
      rememberHistoryAfter,
      replaceLocalExpansions,
      runStructuralCommand
    ]
  );

  const emptyTrash = useCallback(() => {
    closeTextBurst();
    const record = sessionRecordRef.current;
    if (!record) {
      return Promise.resolve();
    }
    const scope = activeScopeRef.current;
    return record.session.enqueueStructural(async (context) => {
      const workspace = await context.repository.emptyTrash(context.vaultRoot);
      record.session.history.clearSnapshots();
      const projectedWorkspace = await workspaceForScope(
        context,
        workspace,
        scope
      );
      const isOwnerActive =
        !record.closing &&
        sessionRecordRef.current === record &&
        sessionRef.current === record.session;
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
  }, [closeTextBurst]);

  const deleteAllNotesData = useCallback(
    async (options?: NotesDeleteAllOptions): Promise<NotesDeleteAllResult> => {
      const record = sessionRecordRef.current;
      if (!record || record.closing || sessionRef.current !== record.session) {
        throw new Error("The Notes workspace is unavailable.");
      }
      if (deletingNotesDataRef.current) {
        throw new Error("Notes data deletion is already in progress.");
      }

      const discardDrafts = options?.discardDrafts === true;
      const deletionToken = {};
      deletionTokenRef.current = deletionToken;
      deletingNotesDataRef.current = true;
      setDeletingNotesData(true);

      try {
        if (record.drafts.size > 0) {
          if (discardDrafts) {
            draftEngineRef.current?.discardPendingDrafts();
          } else if (!(await flushAllDraftsBeforeStructural())) {
            throw notesDraftsFlushFailedError(record.writeError);
          }
        }

        let deletionError: unknown = null;
        let deleted = false;
        let attachmentCleanupFailed = false;
        await record.session.enqueueStructural(async (context) => {
          try {
            const outcome = (await context.repository.deleteDatabase(
              context.vaultRoot
            )) as unknown;
            attachmentCleanupFailed =
              hasAttachmentCleanupFlag(outcome) && outcome.attachmentCleanupFailed;
            deleted = true;
            return authoritative(
              { nodes: [] },
              {
                selectedId: null,
                zoomRootId: null,
                editingNoteId: null,
                pendingFocusId: null
              }
            );
          } catch (cause) {
            deletionError = cause;
            return { kind: "failure", error: errorMessage(cause) };
          }
        });
        if (deletionError) {
          throw deletionError;
        }
        if (!deleted) {
          throw new Error("Notes data deletion did not complete.");
        }

        draftEngineRef.current?.resetAfterDataDeletion();
        if (
          sessionRecordRef.current === record &&
          sessionRef.current === record.session
        ) {
          activeScopeRef.current = { kind: "active" };
          setLibraryView("all");
          requestedTagFiltersRef.current = [];
          tagFilterOriginRef.current = null;
          tagFilterRequestRef.current += 1;
          setActiveTagFilters([]);
          setTagSummaries([]);
          replaceLocalExpansions(new Set());
        }
        return { attachmentCleanupFailed };
      } finally {
        if (deletionTokenRef.current === deletionToken) {
          deletionTokenRef.current = null;
          deletingNotesDataRef.current = false;
          setDeletingNotesData(false);
        }
      }
    },
    [flushAllDraftsBeforeStructural, replaceLocalExpansions]
  );

  const zoomTo = useCallback(async (nodeId: NoteId | null) => {
    navigationVersionRef.current += 1;
    liveNavigationRef.current = {
      ...liveNavigationRef.current,
      zoomRootId: nodeId
    };
    dispatch({ type: "setZoomRoot", zoomRootId: nodeId });
  }, []);

  const setAttachmentUploadError = useCallback(
    (
      nodeId: NoteId,
      error: string | null,
      retryAttemptId?: string
    ): void => {
      if (error !== null && retryAttemptId === undefined) {
        const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(nodeId);
        if (attempts) {
          for (const [attemptId, attempt] of attempts) {
            if (attempt.status !== "failed") continue;
            attempts.delete(attemptId);
            discardHistoryEntry(attempt.historyContext);
          }
          if (attempts.size === 0) {
            attachmentUploadAttemptsByNodeIdRef.current.delete(nodeId);
          }
        }
      }
      setAttachmentUploadErrorsByNodeId((current) => {
        if (error === null) {
          if (current[nodeId] === undefined) return current;
          const next = { ...current };
          delete next[nodeId];
          return next;
        }
        return current[nodeId] === error
          ? current
          : { ...current, [nodeId]: error };
      });
      setAttachmentUploadRetryAttemptIdsByNodeId((current) => {
        if (error === null || retryAttemptId === undefined) {
          if (current[nodeId] === undefined) return current;
          const next = { ...current };
          delete next[nodeId];
          return next;
        }
        return current[nodeId] === retryAttemptId
          ? current
          : { ...current, [nodeId]: retryAttemptId };
      });
    },
    [discardHistoryEntry]
  );

  const publishLatestAttachmentAttemptError = useCallback(
    (nodeId: NoteId): void => {
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(nodeId);
      let latestFailedAttempt: AttachmentUploadAttempt | undefined;
      for (const attempt of attempts?.values() ?? []) {
        if (attempt.status === "failed") latestFailedAttempt = attempt;
      }
      setAttachmentUploadError(
        nodeId,
        latestFailedAttempt?.error ?? null,
        latestFailedAttempt?.attemptId
      );
    },
    [setAttachmentUploadError]
  );

  const setImageImportMaxDisplayWidth = useCallback(
    (displayWidth: number | null): void => {
      imageImportMaxDisplayWidthRef.current =
        displayWidth !== null &&
        Number.isSafeInteger(displayWidth) &&
        displayWidth > 0
          ? displayWidth
          : null;
    },
    []
  );

  const removeAttachmentUploadAttempt = useCallback(
    (attempt: AttachmentUploadAttempt): void => {
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(
        attempt.nodeId
      );
      if (attempts?.get(attempt.attemptId) !== attempt) return;
      attempts.delete(attempt.attemptId);
      if (attempts.size === 0) {
        attachmentUploadAttemptsByNodeIdRef.current.delete(attempt.nodeId);
      }
    },
    []
  );

  const createAttachmentUploadAttempt = useCallback(
    (
      nodeId: NoteId,
      request: AttachmentImportRequest,
      initialMaxDisplayWidth: number
    ): AttachmentUploadAttempt | null => {
      const record = sessionRecordRef.current;
      if (
        !record ||
        record.closing ||
        record.repository !== repository ||
        record.vaultRoot !== vaultRoot
      ) {
        return null;
      }
      const attempt: AttachmentUploadAttempt = {
        attemptId: globalThis.crypto.randomUUID(),
        nodeId,
        request,
        initialMaxDisplayWidth,
        historyContext: beginStructuralEntry(record, "attachment-import"),
        record,
        status: "pending",
        error: null
      };
      const attempts =
        attachmentUploadAttemptsByNodeIdRef.current.get(nodeId) ?? new Map();
      attempts.set(attempt.attemptId, attempt);
      attachmentUploadAttemptsByNodeIdRef.current.set(nodeId, attempts);
      publishLatestAttachmentAttemptError(nodeId);
      return attempt;
    },
    [
      beginStructuralEntry,
      publishLatestAttachmentAttemptError,
      repository,
      vaultRoot
    ]
  );

  const executeAttachmentUploadAttempt = useCallback(
    async (attempt: AttachmentUploadAttempt): Promise<void> => {
      attempt.status = "pending";
      attempt.error = null;
      publishLatestAttachmentAttemptError(attempt.nodeId);

      return runStructuralCommand(
        "attachment-import",
        async (context, historyContext, record) => {
          if (
            record !== attempt.record ||
            !confirmedState(context).nodesById[attempt.nodeId]
          ) {
            removeAttachmentUploadAttempt(attempt);
            publishLatestAttachmentAttemptError(attempt.nodeId);
            return { kind: "skipped" };
          }
          const operationGeneration = activeWorkspaceGenerationRef.current;
          const isCurrent = (): boolean =>
            sessionRecordRef.current === attempt.record &&
            !attempt.record.closing &&
            sessionRef.current === attempt.record.session &&
            activeWorkspaceGenerationRef.current === operationGeneration;
          try {
            const response =
              attempt.request.kind === "paths"
                ? await context.repository.importAttachmentPaths(
                    context.vaultRoot,
                    {
                      nodeId: attempt.nodeId,
                      attachments: attempt.request.items,
                      initialMaxDisplayWidth: attempt.initialMaxDisplayWidth
                    },
                    ...historyArguments(historyContext)
                  )
                : await context.repository.importAttachmentBytes(
                    context.vaultRoot,
                    {
                      nodeId: attempt.nodeId,
                      attachments: attempt.request.items,
                      initialMaxDisplayWidth: attempt.initialMaxDisplayWidth
                    },
                    ...historyArguments(historyContext)
                  );
            if (!isCurrent()) {
              removeAttachmentUploadAttempt(attempt);
              return { kind: "skipped" };
            }
            const mutation = unwrapNotesMutation(response);
            const projection = await projectNotesMutation(
              context,
              mutation,
              activeScopeRef.current
            );
            if (!isCurrent()) {
              removeAttachmentUploadAttempt(attempt);
              return { kind: "skipped" };
            }
            rememberHistoryAfter(
              appliedHistoryContext(historyContext, mutation),
              projection.workspace
            );
            removeAttachmentUploadAttempt(attempt);
            publishLatestAttachmentAttemptError(attempt.nodeId);
            return directMutationResult(mutation, projection);
          } catch (cause) {
            if (!isCurrent()) {
              removeAttachmentUploadAttempt(attempt);
              return { kind: "skipped" };
            }
            const attempts =
              attachmentUploadAttemptsByNodeIdRef.current.get(attempt.nodeId);
            for (const [attemptId, candidate] of attempts ?? []) {
              if (
                candidate !== attempt &&
                candidate.status === "failed"
              ) {
                attempts!.delete(attemptId);
                discardHistoryEntry(candidate.historyContext);
              }
            }
            const message = `Image upload failed: ${errorMessage(cause)}`;
            attempt.status = "failed";
            attempt.error = message;
            publishLatestAttachmentAttemptError(attempt.nodeId);
            return { kind: "failure", error: message };
          }
        },
        {
          historyContext: attempt.historyContext,
          retainHistoryOnFailure: true
        }
      );
    },
    [
      discardHistoryEntry,
      publishLatestAttachmentAttemptError,
      rememberHistoryAfter,
      removeAttachmentUploadAttempt,
      runStructuralCommand
    ]
  );

  const importImagePaths = useCallback(
    async (
      nodeId: NoteId,
      paths: readonly string[],
      initialMaxDisplayWidth: number
    ): Promise<void> => {
      if (paths.length === 0) return;
      if (
        !Number.isSafeInteger(initialMaxDisplayWidth) ||
        initialMaxDisplayWidth <= 0
      ) {
        setAttachmentUploadError(nodeId, "Image area is not ready.");
        return;
      }
      try {
        const request: AttachmentImportRequest = {
          kind: "paths",
          items: paths.map((sourcePath) => ({
            id: createNoteId(),
            sourcePath
          }))
        };
        const attempt = createAttachmentUploadAttempt(
          nodeId,
          request,
          initialMaxDisplayWidth
        );
        if (attempt) await executeAttachmentUploadAttempt(attempt);
      } catch (cause) {
        setAttachmentUploadError(nodeId, errorMessage(cause));
      }
    },
    [
      createAttachmentUploadAttempt,
      executeAttachmentUploadAttempt,
      setAttachmentUploadError
    ]
  );

  const importClipboardImages = useCallback(
    async (
      nodeId: NoteId,
      items: readonly PendingNoteAttachmentByteItem[]
    ): Promise<void> => {
      if (items.length === 0) return;
      const initialMaxDisplayWidth = imageImportMaxDisplayWidthRef.current ?? 0;
      if (
        !Number.isSafeInteger(initialMaxDisplayWidth) ||
        initialMaxDisplayWidth <= 0
      ) {
        setAttachmentUploadError(nodeId, "Image area is not ready.");
        return;
      }
      try {
        const request: AttachmentImportRequest = {
          kind: "bytes",
          items: items.map((item) => ({ id: createNoteId(), ...item }))
        };
        const attempt = createAttachmentUploadAttempt(
          nodeId,
          request,
          initialMaxDisplayWidth
        );
        if (attempt) await executeAttachmentUploadAttempt(attempt);
      } catch (cause) {
        setAttachmentUploadError(nodeId, errorMessage(cause));
      }
    },
    [
      createAttachmentUploadAttempt,
      executeAttachmentUploadAttempt,
      setAttachmentUploadError
    ]
  );

  const importDroppedImagePaths = useCallback(
    async (nodeId: NoteId, paths: readonly string[]): Promise<void> => {
      await importImagePaths(
        nodeId,
        paths,
        imageImportMaxDisplayWidthRef.current ?? 0
      );
    },
    [importImagePaths]
  );

  const uploadImage = useCallback(
    async (nodeId: NoteId): Promise<void> => {
      const invocationRecord = sessionRecordRef.current;
      const initialMaxDisplayWidth =
        imageImportMaxDisplayWidthRef.current ?? 0;
      try {
        const sourcePaths = await attachmentUi.openImageFiles();
        if (
          !invocationRecord ||
          invocationRecord.closing ||
          sessionRecordRef.current !== invocationRecord ||
          invocationRecord.repository !== repository ||
          invocationRecord.vaultRoot !== vaultRoot
        ) {
          return;
        }
        if (sourcePaths === null || sourcePaths.length === 0) return;
        await importImagePaths(nodeId, sourcePaths, initialMaxDisplayWidth);
      } catch (cause) {
        if (
          !invocationRecord ||
          invocationRecord.closing ||
          sessionRecordRef.current !== invocationRecord
        ) {
          return;
        }
        setAttachmentUploadError(
          nodeId,
          `Image picker failed: ${errorMessage(cause)}`
        );
      }
    },
    [
      attachmentUi,
      importImagePaths,
      repository,
      setAttachmentUploadError,
      vaultRoot
    ]
  );

  const retryImageUpload = useCallback(
    async (nodeId: NoteId, attemptId?: string): Promise<void> => {
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(nodeId);
      const failedAttempt = attemptId
        ? attempts?.get(attemptId)
        : undefined;
      if (attemptId) {
        if (failedAttempt?.status === "failed") {
          for (const [candidateId, candidate] of attempts ?? []) {
            if (candidate !== failedAttempt && candidate.status === "failed") {
              attempts!.delete(candidateId);
              discardHistoryEntry(candidate.historyContext);
            }
          }
          await executeAttachmentUploadAttempt(failedAttempt);
        }
        return;
      }
      await uploadImage(nodeId);
    },
    [discardHistoryEntry, executeAttachmentUploadAttempt, uploadImage]
  );

  const loadAttachmentBytes = useCallback(
    async (attachmentId: string): Promise<Uint8Array> => {
      if (!repository.readAttachmentBytes) {
        throw new Error("Image loading is unavailable.");
      }
      return repository.readAttachmentBytes(vaultRoot, attachmentId);
    },
    [repository, vaultRoot]
  );

  const resizeImage = useCallback(
    async (attachmentId: string, displayWidth: number): Promise<void> =>
      runStructuralCommand(
        "attachment-resize",
        async (context, historyContext) => {
          const attachmentExists = Object.values(
            confirmedState(context).attachmentsByNodeId
          ).some((attachments) =>
            attachments.some((attachment) => attachment.id === attachmentId)
          );
          if (!attachmentExists || !context.repository.resizeAttachment) {
            return { kind: "skipped" };
          }
          const mutation = unwrapNotesMutation(
            await context.repository.resizeAttachment(
              context.vaultRoot,
              { id: attachmentId, displayWidth },
              ...historyArguments(historyContext)
            )
          );
          const projection = await projectNotesMutation(
            context,
            mutation,
            activeScopeRef.current
          );
          rememberHistoryAfter(
            appliedHistoryContext(historyContext, mutation),
            projection.workspace
          );
          return directMutationResult(mutation, projection);
        }
      ),
    [rememberHistoryAfter, runStructuralCommand]
  );

  const removeImage = useCallback(
    async (attachmentId: string): Promise<void> =>
      runStructuralCommand(
        "attachment-remove",
        async (context, historyContext) => {
          const attachmentExists = Object.values(
            confirmedState(context).attachmentsByNodeId
          ).some((attachments) =>
            attachments.some((attachment) => attachment.id === attachmentId)
          );
          if (!attachmentExists || !context.repository.removeAttachment) {
            return { kind: "skipped" };
          }
          const mutation = unwrapNotesMutation(
            await context.repository.removeAttachment(
              context.vaultRoot,
              attachmentId,
              ...historyArguments(historyContext)
            )
          );
          const projection = await projectNotesMutation(
            context,
            mutation,
            activeScopeRef.current
          );
          rememberHistoryAfter(
            appliedHistoryContext(historyContext, mutation),
            projection.workspace
          );
          return directMutationResult(mutation, projection);
        }
      ),
    [rememberHistoryAfter, runStructuralCommand]
  );

  const actions = useMemo<NotesWorkspaceActions>(() => {
    const gate = <Args extends unknown[]>(
      action: (...args: Args) => Promise<void>
    ) =>
      (...args: Args): Promise<void> =>
        deletingNotesDataRef.current ? Promise.resolve() : action(...args);

    return {
      acknowledgeFocus: gate(acknowledgeFocus),
      focusNode: gate(focusNode),
      createRoot: gate(createRoot),
      splitNode: gate(splitNode),
      createChild: gate(createChild),
      updateNode: gate(updateNode),
      updateNodeDraft: (nodeId, patch, field) => {
        if (!deletingNotesDataRef.current) {
          updateNodeDraft(nodeId, patch, field);
        }
      },
      flushNodeDraft: (nodeId) =>
        deletingNotesDataRef.current
          ? Promise.resolve(false)
          : flushNodeDraft(nodeId),
      flushAllDrafts: () =>
        deletingNotesDataRef.current
          ? Promise.resolve(false)
          : flushAllDraftsBeforeStructural(),
      moveNode: gate(async (...args) => {
        await moveNode(...args);
      }),
      toggleComplete: gate(toggleComplete),
      toggleCollapsed: gate(toggleCollapsed),
      expandAll: gate(expandAll),
      collapseAll: gate(collapseAll),
      sortSubtreeAscending: gate(sortSubtreeAscending),
      sortSubtreeDescending: gate(sortSubtreeDescending),
      toggleStar: gate(toggleStar),
      duplicateNode: gate(duplicateNode),
      removeEmptyNode: gate(removeEmptyNode),
      deleteNode: gate(deleteNode),
      restoreNode: gate(restoreNode),
      archiveNode: gate(archiveNode),
      unarchiveNode: gate(unarchiveNode),
      emptyTrash: gate(emptyTrash),
      selectLibraryView: gate(selectLibraryView),
      toggleTagFilter: gate(toggleTagFilter),
      searchNotes: (query) =>
        deletingNotesDataRef.current
          ? Promise.resolve([])
          : searchNotes(query),
      openSearchResult: gate(openSearchResult),
      deleteAllNotesData,
      zoomTo: gate(zoomTo),
      uploadImage: gate(uploadImage),
      importDroppedImagePaths: gate(importDroppedImagePaths),
      importClipboardImages: gate(importClipboardImages),
      retryImageUpload: gate(retryImageUpload),
      setImageImportMaxDisplayWidth,
      loadAttachmentBytes,
      resizeImage: gate(resizeImage),
      removeImage: gate(removeImage),
      undo: gate(undo),
      redo: gate(redo)
    };
  }, [
    acknowledgeFocus,
    focusNode,
    createRoot,
    splitNode,
    createChild,
    updateNode,
    updateNodeDraft,
    flushNodeDraft,
    flushAllDraftsBeforeStructural,
    moveNode,
    toggleComplete,
    toggleCollapsed,
    expandAll,
    collapseAll,
    sortSubtreeAscending,
    sortSubtreeDescending,
    toggleStar,
    duplicateNode,
    removeEmptyNode,
    deleteNode,
    restoreNode,
    archiveNode,
    unarchiveNode,
    emptyTrash,
    selectLibraryView,
    toggleTagFilter,
    searchNotes,
    openSearchResult,
    deleteAllNotesData,
    zoomTo,
    uploadImage,
    importDroppedImagePaths,
    importClipboardImages,
    retryImageUpload,
    setImageImportMaxDisplayWidth,
    loadAttachmentBytes,
    resizeImage,
    removeImage,
    undo,
    redo
  ]);

  const loadActiveNodesForMove = useCallback(
    async (): Promise<readonly NoteNode[]> =>
      (await repository.loadWorkspace(vaultRoot, { kind: "active" })).nodes,
    [repository, vaultRoot]
  );

  const prepareMoveNode = useCallback(
    async (nodeId: NoteId): Promise<NotesPreparedMove> => {
      const token = movePreparationTokenRef.current + 1;
      movePreparationTokenRef.current = token;
      const preparedVaultRoot = vaultRoot;
      const preparedScope = cloneWorkspaceScope(activeScopeRef.current);
      const generation = activeWorkspaceGenerationRef.current;
      const nodes = (await loadActiveNodesForMove()).map((node) => ({
        ...node
      }));
      if (
        token !== movePreparationTokenRef.current ||
        vaultRootRef.current !== preparedVaultRoot ||
        !sameScope(activeScopeRef.current, preparedScope) ||
        activeWorkspaceGenerationRef.current !== generation
      ) {
        throw new Error("Notes changed while Move To was opening.");
      }
      const nodesById = Object.fromEntries(
        nodes.map((node) => [node.id, node])
      ) as Record<NoteId, NoteNode>;
      if (!isActiveMoveNode(nodesById[nodeId])) {
        throw new Error("This note is no longer active.");
      }
      return {
        token,
        vaultRoot: preparedVaultRoot,
        scope: preparedScope,
        generation,
        sourceId: nodeId,
        nodes
      };
    },
    [loadActiveNodesForMove, vaultRoot]
  );

  const commitPreparedMove = useCallback(
    async (
      prepared: NotesPreparedMove,
      destinationId: NoteId | null
    ): Promise<NotesPreparedMoveCommitResult> => {
      const staleError: NotesPreparedMoveCommitResult = {
        ok: false,
        error: "Notes changed while Move To was open. Refresh Move To and try again."
      };
      let outcome: NotesPreparedMoveCommitResult = staleError;
      await runStructuralCommand(
        "move",
        async (context, historyContext) => {
          const stale = () =>
            prepared.token !== movePreparationTokenRef.current ||
            prepared.vaultRoot !== vaultRootRef.current ||
            prepared.vaultRoot !== context.vaultRoot ||
            !sameScope(prepared.scope, activeScopeRef.current) ||
            prepared.generation !== activeWorkspaceGenerationRef.current;
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
            outcome = {
              ok: false,
              error: "Could not refresh move destinations. Try again."
            };
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
            outcome = {
              ok: false,
              error: "Move could not be completed. Refresh Move To and try again."
            };
            throw cause;
          }
          const projection = await projectNotesMutation(
            context,
            mutation,
            activeScopeRef.current
          );
          const appliedContext = appliedHistoryContext(
            historyContext,
            mutation
          );
          rememberHistoryAfter(
            appliedContext,
            projection.workspace,
            focusedUiUpdate(prepared.sourceId)
          );
          if (!historyContext || appliedContext) {
            movePreparationTokenRef.current += 1;
            outcome = { ok: true };
          }
          return directMutationResult(
            mutation,
            projection,
            focusedUiUpdate(prepared.sourceId)
          );
        }
      );
      return outcome;
    },
    [rememberHistoryAfter, runStructuralCommand]
  );

  const stateSlice = useMemo<NotesStateSlice>(
    () => ({
      state,
      deletingNotesData,
      libraryView,
      activeTagFilters,
      tagSummaries,
      locallyExpandedNodeIds,
      status: state.status,
      loading: state.status === "loading",
      error: state.error,
      canUndo: historyStatus.canUndo,
      canRedo: historyStatus.canRedo
    }),
    [
      state,
      deletingNotesData,
      libraryView,
      activeTagFilters,
      tagSummaries,
      locallyExpandedNodeIds,
      historyStatus
    ]
  );

  const draftsSlice = useMemo<NotesDraftsSlice>(
    () => ({
      draftsByNodeId,
      writeError: currentWriteError,
      attachmentUploadErrorsByNodeId,
      attachmentUploadRetryAttemptIdsByNodeId
    }),
    [
      draftsByNodeId,
      currentWriteError,
      attachmentUploadErrorsByNodeId,
      attachmentUploadRetryAttemptIdsByNodeId
    ]
  );

  const actionsSlice = useMemo<NotesActionsSlice>(
    () => ({
      actions,
      retryFailedDraft,
      retryLastFailedWrite,
      loadActiveNodesForMove,
      prepareMoveNode,
      commitPreparedMove
    }),
    [
      actions,
      retryFailedDraft,
      retryLastFailedWrite,
      loadActiveNodesForMove,
      prepareMoveNode,
      commitPreparedMove
    ]
  );

  return {
    ...stateSlice,
    ...draftsSlice,
    ...actionsSlice,
    stateSlice,
    draftsSlice,
    actionsSlice
  };
}
