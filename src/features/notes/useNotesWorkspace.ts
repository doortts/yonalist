import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from "react";
import { createNoteId } from "../../domain/notes";
import type {
  MoveNoteNodeInput,
  NoteId,
  NoteNode,
  NotesHistoryContext,
  NoteSearchResult,
  NotesStore,
  NotesStoreError,
  NotesWorkspace,
  NotesWorkspaceScope
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
  type NotesHistorySnapshot
} from "./notesHistory";
import {
  normalizeWorkspace,
  notesWorkspaceReducer,
  type NormalizedNotesWorkspace
} from "./notesWorkspaceReducer";

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
  selectTag(tag: string): Promise<void>;
  searchNotes(query: string): Promise<NoteSearchResult[]>;
  openSearchResult(nodeId: NoteId): Promise<void>;
  deleteAllNotesData(): Promise<void>;
  zoomTo(nodeId: NoteId | null): Promise<void>;
  undo?(): Promise<void>;
  redo?(): Promise<void>;
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
}

export interface UseNotesWorkspaceResult {
  state: NormalizedNotesWorkspace;
  actions: NotesWorkspaceActions;
  deletingNotesData: boolean;
  libraryView: NotesLibraryView;
  activeTag: string | null;
  tags: readonly string[];
  locallyExpandedNodeIds: ReadonlySet<NoteId>;
  draftsByNodeId: Readonly<Record<NoteId, NotesNodeDraft>>;
  writeError: NotesStoreError | null;
  retryFailedDraft(nodeId: NoteId): Promise<void>;
  retryLastFailedWrite(): Promise<void>;
  status: NormalizedNotesWorkspace["status"];
  loading: boolean;
  error: string | null;
  canUndo?: boolean;
  canRedo?: boolean;
}

export interface NotesNodeDraft extends Pick<NoteNode, "title" | "note"> {
  revision: number;
  status: "pending" | "failed";
}

function authoritative(
  workspace: NotesWorkspace,
  uiUpdate?: NotesWorkspaceUiUpdate,
  historyStatus?: { canUndo: boolean; canRedo: boolean },
  options?: Pick<
    Extract<NotesWorkspaceQueueResult, { kind: "authoritative" }>,
    "scopeAgnostic" | "committedHistoryEntryIds"
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

function historyArguments(
  context: NotesHistoryContext | null | undefined
): [] | [NotesHistoryContext] {
  return context ? [context] : [];
}

function supportsHistory(repository: NotesStore): boolean {
  return repository.undo !== undefined && repository.redo !== undefined;
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

interface NotesWorkspaceQueueStep {
  run(): Promise<NotesWorkspace>;
  historyEntryId?: string;
}

interface BufferedWorkspaceCommand {
  work: NotesWorkspaceQueueWork;
  structural?: boolean;
  resolve(): void;
}

interface FailedDraftWrite {
  patch: Pick<NoteNode, "title" | "note">;
  revision: number;
  error: NotesStoreError;
}

interface NotesWorkspaceRecoveryEntry {
  status: "pending" | "failed";
  drafts: Map<NoteId, NotesNodeDraft>;
  failedWritesByNodeId: Map<NoteId, FailedDraftWrite>;
  subscribers: Set<(entry: NotesWorkspaceRecoveryEntry) => void>;
}

interface NotesWorkspaceSessionRecord {
  repository: NotesStore;
  vaultRoot: string;
  session: NotesWorkspaceCoordinatorSession;
  writeQueue: NotesWriteQueue;
  drafts: Map<NoteId, NotesNodeDraft>;
  pendingDebounceByNodeId: Map<NoteId, number>;
  inFlightDraftByNodeId: Map<NoteId, number>;
  retryWriteByNodeId: Map<NoteId, () => Promise<boolean>>;
  draftHistoryContextByNodeId: Map<NoteId, NotesHistoryContext>;
  draftHistoryFocusByNodeId: Map<NoteId, NotesHistoryFocus>;
  nextDraftRevision: number;
  structuralIntents: Array<{
    cutoff: number;
    historyContexts: Set<NotesHistoryContext>;
  }>;
  failedWritesByNodeId: Map<NoteId, FailedDraftWrite>;
  writeError: NotesStoreError | null;
  recoveryEntry: NotesWorkspaceRecoveryEntry | null;
  closing: boolean;
  closeCompletion: Promise<void> | null;
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

const notesWorkspaceRecoveryRegistry = new WeakMap<
  NotesStore,
  Map<string, NotesWorkspaceRecoveryEntry>
>();

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

function libraryStateForScope(scope: NotesWorkspaceScope): {
  view: Exclude<NotesLibraryView, "tags"> | "tags";
  tag: string | null;
} {
  switch (scope.kind) {
    case "active":
      return { view: "all", tag: null };
    case "starred":
      return { view: "starred", tag: null };
    case "recent":
      return { view: "recent", tag: null };
    case "archive":
      return { view: "archive", tag: null };
    case "trash":
      return { view: "trash", tag: null };
    case "tag":
      return { view: "tags", tag: scope.tag };
    case "tags":
      return { view: "tags", tag: null };
  }
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

function writeError(cause: unknown): NotesStoreError {
  return Object.assign(new Error(errorMessage(cause)), {
    operation: "write" as const,
    retryable: true
  });
}

function draftSnapshot(
  drafts: Map<NoteId, NotesNodeDraft>
): Record<NoteId, NotesNodeDraft> {
  return Object.fromEntries(drafts) as Record<NoteId, NotesNodeDraft>;
}

function cloneDrafts(
  drafts: Map<NoteId, NotesNodeDraft>
): Map<NoteId, NotesNodeDraft> {
  return new Map(
    [...drafts].map(([nodeId, draft]) => [nodeId, { ...draft }])
  );
}

function cloneFailedWrites(
  failedWrites: Map<NoteId, FailedDraftWrite>,
  drafts?: Map<NoteId, NotesNodeDraft>
): Map<NoteId, FailedDraftWrite> {
  return new Map(
    [...failedWrites]
      .filter(([nodeId]) => !drafts || drafts.has(nodeId))
      .map(([nodeId, failed]) => [
        nodeId,
        { ...failed, patch: { ...failed.patch } }
      ])
  );
}

function latestWriteError(
  failedWrites: Map<NoteId, FailedDraftWrite>
): NotesStoreError | null {
  return [...failedWrites.values()].at(-1)?.error ?? null;
}

function recoveryEntryFor(
  repository: NotesStore,
  vaultRoot: string
): NotesWorkspaceRecoveryEntry | null {
  return notesWorkspaceRecoveryRegistry.get(repository)?.get(vaultRoot) ?? null;
}

function setRecoveryEntry(
  repository: NotesStore,
  vaultRoot: string,
  entry: NotesWorkspaceRecoveryEntry
): void {
  let entries = notesWorkspaceRecoveryRegistry.get(repository);
  if (!entries) {
    entries = new Map();
    notesWorkspaceRecoveryRegistry.set(repository, entries);
  }
  entries.set(vaultRoot, entry);
}

function deleteRecoveryEntry(
  repository: NotesStore,
  vaultRoot: string,
  entry: NotesWorkspaceRecoveryEntry
): void {
  const entries = notesWorkspaceRecoveryRegistry.get(repository);
  if (entries?.get(vaultRoot) !== entry) {
    return;
  }
  entries.delete(vaultRoot);
  if (entries.size === 0) {
    notesWorkspaceRecoveryRegistry.delete(repository);
  }
}

function clearRecoveryEntry(repository: NotesStore, vaultRoot: string): void {
  const entry = recoveryEntryFor(repository, vaultRoot);
  if (!entry) {
    return;
  }
  deleteRecoveryEntry(repository, vaultRoot, entry);
  entry.subscribers.clear();
  entry.drafts.clear();
  entry.failedWritesByNodeId.clear();
}

function beginShutdownRecovery(
  record: NotesWorkspaceSessionRecord
): NotesWorkspaceRecoveryEntry {
  const existing = recoveryEntryFor(record.repository, record.vaultRoot);
  const entry: NotesWorkspaceRecoveryEntry = {
    status: "pending",
    drafts: cloneDrafts(record.drafts),
    failedWritesByNodeId: cloneFailedWrites(record.failedWritesByNodeId),
    subscribers: existing?.subscribers ?? new Set()
  };
  setRecoveryEntry(record.repository, record.vaultRoot, entry);
  record.recoveryEntry = entry;
  return entry;
}

function finishShutdownRecovery(
  record: NotesWorkspaceSessionRecord,
  entry: NotesWorkspaceRecoveryEntry
): void {
  if (record.drafts.size === 0) {
    deleteRecoveryEntry(record.repository, record.vaultRoot, entry);
    entry.subscribers.clear();
    record.recoveryEntry = null;
    return;
  }

  entry.status = "failed";
  entry.drafts = cloneDrafts(record.drafts);
  entry.failedWritesByNodeId = cloneFailedWrites(
    record.failedWritesByNodeId,
    record.drafts
  );
  for (const subscriber of entry.subscribers) {
    subscriber(entry);
  }
  entry.subscribers.clear();
}

function subscribeToRecovery(
  repository: NotesStore,
  vaultRoot: string,
  subscriber: (entry: NotesWorkspaceRecoveryEntry) => void
): () => void {
  const entry = recoveryEntryFor(repository, vaultRoot);
  if (!entry) {
    return () => undefined;
  }
  if (entry.status === "failed") {
    subscriber(entry);
    return () => undefined;
  }
  entry.subscribers.add(subscriber);
  return () => entry.subscribers.delete(subscriber);
}

function syncRecoveredDraft(
  record: NotesWorkspaceSessionRecord,
  nodeId: NoteId
): void {
  const entry = record.recoveryEntry;
  if (
    !entry ||
    entry.status !== "failed" ||
    recoveryEntryFor(record.repository, record.vaultRoot) !== entry ||
    !entry.drafts.has(nodeId)
  ) {
    return;
  }

  const draft = record.drafts.get(nodeId);
  const failed = record.failedWritesByNodeId.get(nodeId);
  if (draft) {
    entry.drafts.set(nodeId, { ...draft });
    if (failed) {
      entry.failedWritesByNodeId.set(nodeId, {
        ...failed,
        patch: { ...failed.patch }
      });
    }
    return;
  }

  entry.drafts.delete(nodeId);
  entry.failedWritesByNodeId.delete(nodeId);
  if (entry.drafts.size === 0) {
    deleteRecoveryEntry(record.repository, record.vaultRoot, entry);
    record.recoveryEntry = null;
  }
}

async function runCompoundQueueWork(
  context: NotesWorkspaceQueueContext,
  steps: NotesWorkspaceQueueStep[],
  uiUpdate?: NotesWorkspaceUiUpdate,
  scope: NotesWorkspaceScope = { kind: "active" }
): Promise<NotesWorkspaceQueueResult> {
  let workspace = context.confirmedWorkspace;
  let hasAuthoritativeStep = false;
  const committedHistoryEntryIds: string[] = [];

  try {
    for (const step of steps) {
      workspace = await step.run();
      hasAuthoritativeStep = true;
      if (step.historyEntryId) {
        committedHistoryEntryIds.push(step.historyEntryId);
      }
    }
    return authoritative(
      await workspaceForScope(context, workspace, scope),
      uiUpdate
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
  repository
}: UseNotesWorkspaceOptions): UseNotesWorkspaceResult {
  const [state, dispatch] = useReducer(
    notesWorkspaceReducer,
    undefined,
    (): NormalizedNotesWorkspace => ({
      ...normalizeWorkspace({ nodes: [] }),
      status: "loading"
    })
  );
  const [draftsByNodeId, setDraftsByNodeId] = useState<
    Readonly<Record<NoteId, NotesNodeDraft>>
  >({});
  const [libraryView, setLibraryView] = useState<NotesLibraryView>("all");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [tags, setTags] = useState<readonly string[]>([]);
  const [locallyExpandedNodeIds, setLocallyExpandedNodeIds] = useState<
    ReadonlySet<NoteId>
  >(() => new Set());
  const [currentWriteError, setCurrentWriteError] =
    useState<NotesStoreError | null>(null);
  const [deletingNotesData, setDeletingNotesData] = useState(false);
  const [historyStatus, setHistoryStatus] = useState({
    canUndo: false,
    canRedo: false
  });
  const historyVersionRef = useRef(0);
  const activeScopeRef = useRef<NotesWorkspaceScope>({ kind: "active" });
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
  const persistDraftRef = useRef<
    | ((
        record: NotesWorkspaceSessionRecord,
        nodeId: NoteId,
        draft: NotesNodeDraft
      ) => Promise<boolean>)
    | null
  >(null);
  const flushDraftBarrierRef = useRef<
    ((record: NotesWorkspaceSessionRecord, cutoff: number) => Promise<boolean>) | null
  >(null);
  const releaseDraftBarrierRef = useRef<
    ((record: NotesWorkspaceSessionRecord, cutoff: number) => void) | null
  >(null);
  const scheduleDeferredDraftsRef = useRef<
    ((record: NotesWorkspaceSessionRecord) => void) | null
  >(null);
  const bufferedCommandsRef = useRef<BufferedWorkspaceCommand[]>([]);
  const finalCleanupTokenRef = useRef<object | null>(null);
  const closedRef = useRef(false);

  const publishDraftState = useCallback(
    (record: NotesWorkspaceSessionRecord): void => {
      if (record.closing || sessionRecordRef.current !== record) {
        return;
      }
      setDraftsByNodeId(draftSnapshot(record.drafts));
      setCurrentWriteError(record.writeError);
    },
    []
  );

  const beginRecordShutdown = useCallback(
    (record: NotesWorkspaceSessionRecord): Promise<void> => {
      if (record.closeCompletion) {
        return record.closeCompletion;
      }
      record.closing = true;
      if (record.drafts.size === 0) {
        record.session.close();
        record.closeCompletion = Promise.resolve();
        return record.closeCompletion;
      }
      const recoveryEntry = beginShutdownRecovery(record);
      for (const [nodeId] of record.drafts) {
        if (
          record.pendingDebounceByNodeId.has(nodeId) ||
          record.inFlightDraftByNodeId.has(nodeId)
        ) {
          continue;
        }
        const retry = record.retryWriteByNodeId.get(nodeId);
        if (retry) {
          void record.writeQueue.enqueue(retry).catch(() => undefined);
        }
      }
      const finish = (): void => {
        finishShutdownRecovery(record, recoveryEntry);
        record.session.close();
      };
      record.closeCompletion = record.writeQueue.flush().then(
        finish,
        finish
      );
      return record.closeCompletion;
    },
    []
  );

  useLayoutEffect(() => {
    closedRef.current = false;
    const previousRecord = sessionRecordRef.current;
    if (previousRecord) {
      void beginRecordShutdown(previousRecord);
    }
    dispatch({ type: "startWorkspaceLoad" });
    setDraftsByNodeId({});
    setCurrentWriteError(null);
    deletingNotesDataRef.current = false;
    deletionTokenRef.current = null;
    setDeletingNotesData(false);
    setHistoryStatus({ canUndo: false, canRedo: false });
    historyVersionRef.current = 0;
    activeScopeRef.current = { kind: "active" };
    locallyExpandedNodeIdsRef.current = new Set();
    liveNavigationRef.current = emptyLiveNavigation();
    setLibraryView("all");
    setActiveTag(null);
    setTags([]);
    setLocallyExpandedNodeIds(locallyExpandedNodeIdsRef.current);
    let record!: NotesWorkspaceSessionRecord;
    const session = notesWorkspaceCoordinatorRegistry.openSession({
      repository,
      vaultRoot,
      onEvent(event) {
        if (record.closing || sessionRecordRef.current !== record) {
          return;
        }
        if (event.type === "pending") {
          dispatch({ type: "setLoading" });
          return;
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
              record.closing ||
              sessionRecordRef.current !== record ||
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
            event.result.kind === "authoritative"
              ? event.result.uiUpdate
              : undefined
          );
        }
        dispatch({
          type: "settleQueueWork",
          result: event.result,
          hasPendingWork: event.hasPendingWork
        });
      },
      captureDraftCutoff: () => {
        const cutoff = record.nextDraftRevision - 1;
        record.structuralIntents.push({
          cutoff,
          historyContexts: new Set(
            record.draftHistoryContextByNodeId.values()
          )
        });
        record.draftHistoryContextByNodeId.clear();
        record.session.history.closeTextBurst();
        return cutoff;
      },
      beforeStructural: (cutoff) =>
        flushDraftBarrierRef.current?.(record, cutoff) ?? Promise.resolve(true),
      afterStructural: (cutoff) =>
        releaseDraftBarrierRef.current?.(record, cutoff),
      isCurrent: () =>
        !record.closing &&
        sessionRecordRef.current === record &&
        sessionRef.current === session,
      getScope: () => activeScopeRef.current
    });
    record = {
      repository,
      vaultRoot,
      session,
      writeQueue: createNotesWriteQueue(),
      drafts: new Map(),
      pendingDebounceByNodeId: new Map(),
      inFlightDraftByNodeId: new Map(),
      retryWriteByNodeId: new Map(),
      draftHistoryContextByNodeId: new Map(),
      draftHistoryFocusByNodeId: new Map(),
      nextDraftRevision: 1,
      structuralIntents: [],
      failedWritesByNodeId: new Map(),
      writeError: null,
      recoveryEntry: null,
      closing: false,
      closeCompletion: null
    };
    sessionRecordRef.current = record;
    sessionRef.current = session;
    const unsubscribeRecovery = subscribeToRecovery(
      repository,
      vaultRoot,
      (entry) => {
        queueMicrotask(() => {
          if (
            entry.status !== "failed" ||
            recoveryEntryFor(repository, vaultRoot) !== entry ||
            record.closing ||
            sessionRecordRef.current !== record ||
            sessionRef.current !== session
          ) {
            return;
          }
          record.drafts = cloneDrafts(entry.drafts);
          record.failedWritesByNodeId = cloneFailedWrites(
            entry.failedWritesByNodeId,
            entry.drafts
          );
          record.nextDraftRevision = Math.max(
            record.nextDraftRevision,
            ...[...record.drafts.values()].map((draft) => draft.revision + 1)
          );
          record.writeError = latestWriteError(record.failedWritesByNodeId);
          record.recoveryEntry = entry;
          for (const [nodeId] of record.drafts) {
            record.retryWriteByNodeId.set(nodeId, () => {
              const latest = record.drafts.get(nodeId);
              const persist = persistDraftRef.current;
              return latest && persist
                ? persist(record, nodeId, latest)
                : Promise.resolve(false);
            });
          }
          publishDraftState(record);
        });
      }
    );
    enqueueBufferedCommands(
      session,
      bufferedCommandsRef.current.splice(0)
    );

    return () => {
      unsubscribeRecovery();
      if (sessionRef.current === session) {
        sessionRef.current = null;
        resolveBufferedCommands(bufferedCommandsRef.current.splice(0));
      }
    };
  }, [beginRecordShutdown, repository, vaultRoot]);

  useEffect(() => {
    finalCleanupTokenRef.current = null;
    return () => {
      const record = sessionRecordRef.current;
      if (record) {
        void beginRecordShutdown(record);
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
        resolveBufferedCommands(bufferedCommandsRef.current.splice(0));
      });
    };
  }, [beginRecordShutdown]);

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
      return {
        scope: activeScopeRef.current,
        selectedId: navigation.selectedId,
        zoomRootId: navigation.zoomRootId,
        locallyExpandedNodeIds: [...locallyExpandedNodeIdsRef.current],
        focus: resolvedFocus
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
        (result.kind === "authoritative" ||
          (result.kind === "failure" &&
            result.committedHistoryEntryIds?.includes(context.entryId))) &&
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
      ) => Promise<NotesWorkspaceQueueResult> | NotesWorkspaceQueueResult
    ): Promise<void> => {
      if (deletingNotesDataRef.current || closedRef.current) {
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
        const historyContext = beginStructuralEntry(record, commandKind);
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
          if (
            (result.kind !== "authoritative" && !structuralCommitted) ||
            (historyContext !== null &&
              (owner === undefined ||
                historyOwnerByEntryIdRef.current.isInFlight(
                  historyContext.entryId
                )))
          ) {
            discardHistoryEntry(historyContext);
          }
          return result;
        } catch (cause) {
          discardHistoryEntry(historyContext);
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

  const settleDraftWrite = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      nodeId: NoteId,
      draft: NotesNodeDraft,
      result: NotesWorkspaceQueueResult,
      writeSucceeded: boolean
    ): boolean => {
      const latest = record.drafts.get(nodeId);
      if (result.kind === "failure" && !writeSucceeded) {
        const failedHistoryContext =
          record.draftHistoryContextByNodeId.get(nodeId);
        discardHistoryEntry(failedHistoryContext);
        record.draftHistoryContextByNodeId.delete(nodeId);
        if (latest) {
          record.drafts.set(nodeId, { ...latest, status: "failed" });
        }
        const failure = writeError(result.error);
        record.failedWritesByNodeId.set(nodeId, {
          patch: { title: draft.title, note: draft.note },
          revision: draft.revision,
          error: failure
        });
        record.writeError = failure;
        syncRecoveredDraft(record, nodeId);
        publishDraftState(record);
        return false;
      }

      if (result.kind === "skipped") {
        discardHistoryEntry(record.draftHistoryContextByNodeId.get(nodeId));
        record.drafts.delete(nodeId);
        record.pendingDebounceByNodeId.delete(nodeId);
      } else if (writeSucceeded && latest?.revision === draft.revision) {
        record.drafts.delete(nodeId);
      }
      const failed = record.failedWritesByNodeId.get(nodeId);
      if (
        (result.kind === "skipped" || writeSucceeded) &&
        failed &&
        failed.revision <= draft.revision
      ) {
        record.failedWritesByNodeId.delete(nodeId);
      }
      record.writeError = latestWriteError(record.failedWritesByNodeId);
      if (!record.drafts.has(nodeId)) {
        record.retryWriteByNodeId.delete(nodeId);
        const historyContext = record.draftHistoryContextByNodeId.get(nodeId);
        record.draftHistoryContextByNodeId.delete(nodeId);
        record.draftHistoryFocusByNodeId.delete(nodeId);
        record.session.history.closeTextBurst(historyContext?.entryId);
        if (historyContext) {
          completeHistoryOwner(historyContext.entryId);
        }
      }
      syncRecoveredDraft(record, nodeId);
      publishDraftState(record);
      return result.kind !== "failure" || writeSucceeded;
    },
    [completeHistoryOwner, discardHistoryEntry, publishDraftState]
  );

  const persistDraft = useCallback(
    async (
      record: NotesWorkspaceSessionRecord,
      nodeId: NoteId,
      draft: NotesNodeDraft,
      scheduledHistoryContext?: NotesHistoryContext | null
    ): Promise<boolean> => {
      const current = record.drafts.get(nodeId);
      if (current?.revision === draft.revision && current.status !== "pending") {
        record.drafts.set(nodeId, { ...current, status: "pending" });
        publishDraftState(record);
      }
      record.inFlightDraftByNodeId.set(nodeId, draft.revision);
      let historyContext: NotesHistoryContext | null | undefined =
        scheduledHistoryContext ??
        record.draftHistoryContextByNodeId.get(nodeId);
      if (!historyContext) {
        const focus = record.draftHistoryFocusByNodeId.get(nodeId) ?? {
          nodeId,
          field: "title"
        };
        historyContext = beginTextEntry(record, nodeId, focus);
        if (historyContext) {
          record.draftHistoryContextByNodeId.set(nodeId, historyContext);
        }
        record.draftHistoryFocusByNodeId.set(nodeId, focus);
      }

      let result: NotesWorkspaceQueueResult | undefined;
      await record.session.enqueue(async (context) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          result = { kind: "skipped" };
          return result;
        }
        try {
          const mutationWorkspace = await context.repository.updateNode(
            context.vaultRoot,
            {
              id: nodeId,
              title: draft.title,
              note: draft.note
            },
            ...historyArguments(historyContext)
          );
          const projectedWorkspace = await workspaceForScope(
            context,
            mutationWorkspace,
            activeScopeRef.current
          );
          rememberHistoryAfter(
            historyContext,
            projectedWorkspace,
            undefined,
            record.draftHistoryFocusByNodeId.get(nodeId) ?? null
          );
          result = authoritative(
            projectedWorkspace
          );
        } catch (cause) {
          result = { kind: "failure", error: errorMessage(cause) };
        }
        return result;
      });
      if (record.inFlightDraftByNodeId.get(nodeId) === draft.revision) {
        record.inFlightDraftByNodeId.delete(nodeId);
      }

      if (!result) {
        return false;
      }

      return settleDraftWrite(
        record,
        nodeId,
        draft,
        result,
        result.kind === "authoritative"
      );
    },
    [beginTextEntry, publishDraftState, rememberHistoryAfter, settleDraftWrite]
  );
  persistDraftRef.current = persistDraft;

  const writeScheduledDraft = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      nodeId: NoteId,
      draft: NotesNodeDraft,
      historyContext?: NotesHistoryContext | null
    ): Promise<boolean> => {
      if (record.pendingDebounceByNodeId.get(nodeId) === draft.revision) {
        record.pendingDebounceByNodeId.delete(nodeId);
      }
      return persistDraft(record, nodeId, draft, historyContext);
    },
    [persistDraft]
  );

  const scheduleDraftWrite = useCallback(
    (
      record: NotesWorkspaceSessionRecord,
      nodeId: NoteId,
      draft: NotesNodeDraft,
      historyContext?: NotesHistoryContext | null
    ): void => {
      record.pendingDebounceByNodeId.set(nodeId, draft.revision);
      void record.writeQueue
        .enqueueDebounced(nodeId, () =>
          writeScheduledDraft(record, nodeId, draft, historyContext)
        )
        .catch(() => undefined);
    },
    [writeScheduledDraft]
  );

  const updateNodeDraft = useCallback(
    (
      nodeId: NoteId,
      patch: Pick<NoteNode, "title" | "note">,
      field: NotesHistoryFocusField = "title"
    ): void => {
      const record = sessionRecordRef.current;
      if (!record || record.closing || sessionRef.current !== record.session) {
        return;
      }
      const previous = record.drafts.get(nodeId);
      const focus = { nodeId, field } satisfies NotesHistoryFocus;
      liveNavigationRef.current = {
        ...liveNavigationRef.current,
        selectedId: nodeId,
        editingNoteId: nodeId,
        pendingFocusField: field
      };
      if (!previous || !record.draftHistoryContextByNodeId.has(nodeId)) {
        const historyContext = beginTextEntry(record, nodeId, focus);
        if (historyContext) {
          record.draftHistoryContextByNodeId.set(nodeId, historyContext);
        }
      }
      record.draftHistoryFocusByNodeId.set(nodeId, focus);
      const draft: NotesNodeDraft = {
        ...patch,
        revision: record.nextDraftRevision++,
        status: previous?.status === "failed" ? "failed" : "pending"
      };
      record.drafts.set(nodeId, draft);
      record.retryWriteByNodeId.set(nodeId, () => {
        const latest = record.drafts.get(nodeId);
        return latest
          ? persistDraft(record, nodeId, latest)
          : Promise.resolve(true);
      });
      const scheduledHistoryContext =
        record.draftHistoryContextByNodeId.get(nodeId);
      syncRecoveredDraft(record, nodeId);
      publishDraftState(record);
      const earliestCutoff = record.structuralIntents.at(0)?.cutoff;
      if (earliestCutoff === undefined || draft.revision <= earliestCutoff) {
        scheduleDraftWrite(
          record,
          nodeId,
          draft,
          scheduledHistoryContext
        );
      }
    },
    [beginTextEntry, persistDraft, publishDraftState, scheduleDraftWrite]
  );

  const flushNodeDraft = useCallback(
    async (nodeId: NoteId): Promise<boolean> => {
      const record = sessionRecordRef.current;
      if (!record || record.closing || sessionRef.current !== record.session) {
        return false;
      }
      const draft = record.drafts.get(nodeId);
      if (draft) {
        try {
          if (
            draft.status === "failed" &&
            record.pendingDebounceByNodeId.get(nodeId) !== draft.revision
          ) {
            await record.writeQueue.enqueue(() =>
              persistDraft(record, nodeId, draft)
            );
          } else {
            await record.writeQueue.flush(nodeId);
          }
        } catch {
          return false;
        }
      }
      return (
        !record.closing &&
        sessionRecordRef.current === record &&
        sessionRef.current === record.session &&
        !record.drafts.has(nodeId)
      );
    },
    [persistDraft]
  );

  const retryFailedDraft = useCallback(
    async (nodeId: NoteId): Promise<void> => {
      if (deletingNotesDataRef.current) {
        return;
      }
      const record = sessionRecordRef.current;
      if (
        !record ||
        !record.failedWritesByNodeId.has(nodeId) ||
        record.closing ||
        sessionRef.current !== record.session
      ) {
        return;
      }
      const latest = record.drafts.get(nodeId);
      if (!latest) {
        record.failedWritesByNodeId.delete(nodeId);
        record.writeError = latestWriteError(record.failedWritesByNodeId);
        syncRecoveredDraft(record, nodeId);
        publishDraftState(record);
        return;
      }

      if (
        record.pendingDebounceByNodeId.get(nodeId) === latest.revision ||
        record.inFlightDraftByNodeId.get(nodeId) === latest.revision
      ) {
        await record.writeQueue.flush(nodeId);
        return;
      }
      await record.writeQueue.enqueue(() => persistDraft(record, nodeId, latest));
    },
    [persistDraft, publishDraftState]
  );

  const retryLastFailedWrite = useCallback(async (): Promise<void> => {
    const record = sessionRecordRef.current;
    const nodeId = record
      ? [...record.failedWritesByNodeId.keys()].at(-1)
      : undefined;
    if (nodeId) {
      await retryFailedDraft(nodeId);
    }
  }, [retryFailedDraft]);

  const flushAllDraftsBeforeStructural = useCallback(
    async (): Promise<boolean> => {
      const record = sessionRecordRef.current;
      if (!record || record.closing || sessionRef.current !== record.session) {
        return false;
      }
      while (true) {
        for (const [nodeId, draft] of record.drafts) {
          if (
            draft.status !== "failed" ||
            record.pendingDebounceByNodeId.has(nodeId) ||
            record.inFlightDraftByNodeId.has(nodeId)
          ) {
            continue;
          }
          const retry = record.retryWriteByNodeId.get(nodeId);
          if (retry) {
            void record.writeQueue.enqueue(retry).catch(() => undefined);
          }
        }
        await record.writeQueue.flush();
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== record.session
        ) {
          return false;
        }
        if (record.drafts.size === 0) {
          record.session.history.closeTextBurst();
          return true;
        }
        const hasRetryableWork = [...record.drafts].some(
          ([nodeId, draft]) =>
            draft.status !== "failed" ||
            record.pendingDebounceByNodeId.has(nodeId) ||
            record.inFlightDraftByNodeId.has(nodeId)
        );
        if (!hasRetryableWork) {
          return false;
        }
      }
    },
    [closeTextBurst]
  );

  const flushDraftsThroughCutoff = useCallback(
    async (
      record: NotesWorkspaceSessionRecord,
      cutoff: number
    ): Promise<boolean> => {
      while (true) {
        for (const [nodeId, draft] of record.drafts) {
          if (
            draft.revision > cutoff ||
            draft.status !== "failed" ||
            record.pendingDebounceByNodeId.has(nodeId) ||
            record.inFlightDraftByNodeId.has(nodeId)
          ) {
            continue;
          }
          const retry = record.retryWriteByNodeId.get(nodeId);
          if (retry) {
            void record.writeQueue.enqueue(retry).catch(() => undefined);
          }
        }
        await record.writeQueue.flush();
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== record.session
        ) {
          return false;
        }
        const remaining = [...record.drafts].filter(
          ([, draft]) => draft.revision <= cutoff
        );
        if (remaining.length === 0) {
          const intent = record.structuralIntents.find(
            (candidate) => candidate.cutoff === cutoff
          );
          for (const context of intent?.historyContexts ?? []) {
            completeHistoryOwner(context.entryId);
          }
          intent?.historyContexts.clear();
          return true;
        }
        const retryable = remaining.some(
          ([nodeId, draft]) =>
            draft.status !== "failed" ||
            record.pendingDebounceByNodeId.has(nodeId) ||
            record.inFlightDraftByNodeId.has(nodeId)
        );
        if (!retryable) {
          return false;
        }
      }
    },
    [completeHistoryOwner]
  );

  flushDraftBarrierRef.current = async (record, cutoff) => {
    if (
      record.closing ||
      sessionRecordRef.current !== record ||
      sessionRef.current !== record.session
    ) {
      return false;
    }
    return flushDraftsThroughCutoff(record, cutoff);
  };
  releaseDraftBarrierRef.current = (record, cutoff) => {
    const index = record.structuralIntents.findIndex(
      (intent) => intent.cutoff === cutoff
    );
    if (index >= 0) {
      const [intent] = record.structuralIntents.splice(index, 1);
      for (const context of intent?.historyContexts ?? []) {
        discardHistoryEntry(context);
      }
    }
    scheduleDeferredDraftsRef.current?.(record);
  };
  scheduleDeferredDraftsRef.current = (record) => {
    const nextCutoff = record.structuralIntents.at(0)?.cutoff;
    for (const [nodeId, draft] of record.drafts) {
      if (
        (nextCutoff !== undefined && draft.revision > nextCutoff) ||
        record.pendingDebounceByNodeId.has(nodeId) ||
        record.inFlightDraftByNodeId.has(nodeId)
      ) {
        continue;
      }
      scheduleDraftWrite(
        record,
        nodeId,
        draft,
        record.draftHistoryContextByNodeId.get(nodeId)
      );
    }
  };

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
          return authoritative(result.workspace, undefined, {
            canUndo: result.canUndo,
            canRedo: result.canRedo
          }, { scopeAgnostic: currentScope.kind !== "active" });
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
            return authoritative(result.workspace, undefined, {
              canUndo: result.canUndo,
              canRedo: result.canRedo
            }, { scopeAgnostic: currentScope.kind !== "active" });
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
          { canUndo: result.canUndo, canRedo: result.canRedo }
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
        setActiveTag(library.tag);
      }
    },
    [
      closeTextBurst,
      flushAllDraftsBeforeStructural,
      replaceLocalExpansions,
      runCommand
    ]
  );

  const undo = useCallback(() => replayHistory("undo"), [replayHistory]);
  const redo = useCallback(() => replayHistory("redo"), [replayHistory]);

  const loadLibraryScope = useCallback(
    async (
      view: NotesLibraryView,
      scope: NotesWorkspaceScope,
      tag: string | null = null
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
      setActiveTag(tag);
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
      let listedTags: string[] | null = null;
      await runCommand(async (context) => {
        listedTags = await context.repository.listTags(context.vaultRoot);
        if (
          record.closing ||
          sessionRecordRef.current !== record ||
          sessionRef.current !== record.session
        ) {
          return { kind: "skipped" };
        }
        activeScopeRef.current = { kind: "active" };
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
      setLibraryView("tags");
      setActiveTag(null);
      setTags(listedTags);
      replaceLocalExpansions(new Set());
    }, [
      flushAllDraftsBeforeStructural,
      loadLibraryScope,
      replaceLocalExpansions,
      runCommand
    ]
  );

  const selectTag = useCallback(
    async (tag: string): Promise<void> => {
      await loadLibraryScope("tags", { kind: "tag", tag }, tag);
    },
    [loadLibraryScope]
  );

  const searchNotes = useCallback(
    (query: string): Promise<NoteSearchResult[]> =>
      repository.search(vaultRoot, query),
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
      setActiveTag(null);
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
    const transitionToAll = libraryView !== "all";
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
      const workspace = await context.repository.createNode(
        context.vaultRoot,
        {
          id,
          parentId: null,
          afterId: before.rootIds.at(-1) ?? null,
          title: "",
          note: ""
        },
        ...historyArguments(historyContext)
      );
      if (
        ownerRecord.closing ||
        sessionRecordRef.current !== ownerRecord ||
        sessionRef.current !== ownerRecord.session
      ) {
        return authoritative(workspace);
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
        historyContext,
        workspace,
        uiUpdate,
        undefined,
        transitionToAll ? new Set() : locallyExpandedNodeIdsRef.current
      );
      return authoritative(
        workspace,
        uiUpdate
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
      setActiveTag(null);
      replaceLocalExpansions(new Set());
    }
  }, [
    flushAllDraftsBeforeStructural,
    beginStructuralEntry,
    runStructuralCommand,
    libraryView,
    rememberHistoryAfter,
    replaceLocalExpansions,
    runCommand
  ]);

  const createChild = useCallback(
    async (nodeId: NoteId) => {
      return runStructuralCommand("create", async (context, historyContext) => {
        const before = confirmedState(context);
        if (!before.nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        const id = createNoteId();
        const workspace = await context.repository.createNode(
          context.vaultRoot,
          {
            id,
            parentId: nodeId,
            afterId: before.childIdsByParent[nodeId]?.at(-1) ?? null,
            title: "",
            note: ""
          },
          ...historyArguments(historyContext)
        );
        const projectedWorkspace = await workspaceForScope(
          context,
          workspace,
          activeScopeRef.current
        );
        const uiUpdate = {
          selectedId: id,
          editingNoteId: id,
          pendingFocusId: id,
          pendingFocusField: "title" as const
        };
        rememberHistoryAfter(historyContext, projectedWorkspace, uiUpdate);
        return authoritative(
          projectedWorkspace,
          uiUpdate
        );
      });
    },
    [
      beginStructuralEntry,
      runStructuralCommand,
      flushDraftBeforeStructural,
      rememberHistoryAfter,
      runCommand
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
                const workspace = await context.repository.updateNode(
                  context.vaultRoot,
                  { id: nodeId, ...inlineDraft },
                  ...historyArguments(inlineTextContext)
                );
                rememberHistoryAfter(
                  inlineTextContext,
                  workspace,
                  undefined,
                  { nodeId, field: "title" }
                );
                return workspace;
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
              historyContext,
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
      beginStructuralEntry,
      runStructuralCommand,
      beginTextEntry,
      flushAllDraftsBeforeStructural,
      flushDraftBeforeStructural,
      rememberHistoryAfter,
      settleInlineTextEntry,
      runCommand
    ]
  );

  const updateNode = useCallback(
    async (nodeId: NoteId, patch: Pick<NoteNode, "title" | "note">) => {
      return runStructuralCommand("update", async (context, historyContext) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        const workspace = await context.repository.updateNode(
          context.vaultRoot,
          {
            id: nodeId,
            ...patch
          },
          ...historyArguments(historyContext)
        );
        const projectedWorkspace = await workspaceForScope(
          context,
          workspace,
          activeScopeRef.current
        );
        rememberHistoryAfter(historyContext, projectedWorkspace);
        return authoritative(
          projectedWorkspace
        );
      });
    },
    [
      beginStructuralEntry,
      flushAllDraftsBeforeStructural,
      rememberHistoryAfter,
      runCommand,
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
      return runStructuralCommand("move", async (context, historyContext, executionRecord) => {
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
              const workspace = await context.repository.updateNode(
                context.vaultRoot,
                { id: input.id, ...inlineDraft },
                ...historyArguments(inlineTextContext)
              );
              rememberHistoryAfter(
                inlineTextContext,
                workspace,
                undefined,
                { nodeId: input.id, field: "title" }
              );
              return workspace;
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
            historyContext,
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
        return result;
      });
    },
    [
      beginStructuralEntry,
      runStructuralCommand,
      flushAllDraftsBeforeStructural,
      beginTextEntry,
      flushDraftBeforeStructural,
      rememberHistoryAfter,
      settleInlineTextEntry,
      runCommand
    ]
  );

  const toggleComplete = useCallback(
    async (nodeId: NoteId) => {
      return runStructuralCommand("complete", async (context, historyContext) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        const workspace = await context.repository.toggleComplete(
          context.vaultRoot,
          nodeId,
          ...historyArguments(historyContext)
        );
        const projectedWorkspace = await workspaceForScope(
          context,
          workspace,
          activeScopeRef.current
        );
        rememberHistoryAfter(historyContext, projectedWorkspace);
        return authoritative(projectedWorkspace);
      });
    },
    [
      beginStructuralEntry,
      runStructuralCommand,
      flushDraftBeforeStructural,
      rememberHistoryAfter,
      runCommand
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
        const workspace = await context.repository.toggleCollapsed(
          context.vaultRoot,
          nodeId,
          ...historyArguments(historyContext)
        );
        const projectedWorkspace = await workspaceForScope(
          context,
          workspace,
          activeScopeRef.current
        );
        rememberHistoryAfter(historyContext, projectedWorkspace);
        return authoritative(projectedWorkspace);
      });
    },
    [
      beginStructuralEntry,
      runStructuralCommand,
      closeTextBurst,
      flushDraftBeforeStructural,
      rememberHistoryAfter,
      replaceLocalExpansions,
      runCommand
    ]
  );

  const toggleStar = useCallback(
    async (nodeId: NoteId) => {
      return runStructuralCommand("star", async (context, historyContext) => {
        if (!confirmedState(context).nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        const workspace = await context.repository.toggleStar(
          context.vaultRoot,
          nodeId,
          ...historyArguments(historyContext)
        );
        const projectedWorkspace = await workspaceForScope(
          context,
          workspace,
          activeScopeRef.current
        );
        rememberHistoryAfter(historyContext, projectedWorkspace);
        return authoritative(projectedWorkspace);
      });
    },
    [
      beginStructuralEntry,
      runStructuralCommand,
      flushDraftBeforeStructural,
      rememberHistoryAfter,
      runCommand
    ]
  );

  const duplicateNode = useCallback(
    async (nodeId: NoteId) => {
      return runStructuralCommand("duplicate", async (context, historyContext) => {
        const before = confirmedState(context);
        if (!before.nodesById[nodeId]) {
          return { kind: "skipped" };
        }
        const workspace = await context.repository.duplicateNode(
          context.vaultRoot,
          nodeId,
          ...historyArguments(historyContext)
        );
        const duplicateId = duplicateRootId(before, workspace, nodeId);
        const projectedWorkspace = await workspaceForScope(
          context,
          workspace,
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
        rememberHistoryAfter(historyContext, projectedWorkspace, uiUpdate);
        return authoritative(
          projectedWorkspace,
          uiUpdate
        );
      });
    },
    [
      beginStructuralEntry,
      runStructuralCommand,
      flushDraftBeforeStructural,
      rememberHistoryAfter,
      runCommand
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
        refreshedTags: string[] | null;
        recoveredToActive: boolean;
        resolvedNavigationVersion: number | null;
      } = {
        transition: null,
        refreshedTags: null,
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
          const mutationWorkspace = await (mutation === "archive"
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
                ));
          if (
            ownerRecord.closing ||
            sessionRecordRef.current !== ownerRecord ||
            sessionRef.current !== ownerRecord.session
          ) {
            return authoritative(
              mutationWorkspace,
              undefined,
              undefined,
              { scopeAgnostic: beforeNavigation.scope.kind !== "active" }
            );
          }
          const requestedScope = activeScopeRef.current;
          let projectedWorkspace: NotesWorkspace;
          try {
            projectedWorkspace = await workspaceForScope(
              context,
              mutationWorkspace,
              requestedScope
            );
            if (!isLifecycleOwnerActive()) {
              return authoritative(projectedWorkspace);
            }
          } catch {
            if (!isLifecycleOwnerActive()) {
              return authoritative(
                mutationWorkspace,
                undefined,
                undefined,
                { scopeAgnostic: beforeNavigation.scope.kind !== "active" }
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
                return authoritative(projectedWorkspace);
              }
            } catch {
              projectedWorkspace = mutationWorkspace;
            }
          }
          try {
            lifecycleResult.refreshedTags = await context.repository.listTags(
              context.vaultRoot
            );
            if (!isLifecycleOwnerActive()) {
              return authoritative(projectedWorkspace);
            }
          } catch {
            // The lifecycle result remains authoritative if tag discovery fails.
          }
          if (!isLifecycleOwnerActive()) {
            return authoritative(projectedWorkspace);
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
            historyContext,
            projectedWorkspace,
            uiUpdate,
            undefined,
            lifecycleResult.transition.after.locallyExpandedNodeIds
          );
          return authoritative(projectedWorkspace, uiUpdate);
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
        setActiveTag(null);
      }
      if (lifecycleResult.refreshedTags) {
        setTags(lifecycleResult.refreshedTags);
      }
    },
    [
      beginStructuralEntry,
      runStructuralCommand,
      flushAllDraftsBeforeStructural,
      rememberHistoryAfter,
      replaceLocalExpansions,
      runCommand
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
              const workspace = await context.repository.updateNode(
                context.vaultRoot,
                { id: nodeId, ...inlineDraft },
                ...historyArguments(inlineTextContext)
              );
              rememberHistoryAfter(
                inlineTextContext,
                workspace,
                undefined,
                { nodeId, field: "title" }
              );
              return workspace;
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
            historyContext,
            result.workspace,
            result.uiUpdate
          );
        }
        return result;
        }
      );
    },
    [
      beginStructuralEntry,
      runStructuralCommand,
      beginTextEntry,
      flushAllDraftsBeforeStructural,
      flushDraftBeforeStructural,
      rememberHistoryAfter,
      settleInlineTextEntry,
      runCommand
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
        const workspace = await context.repository.softDeleteNode(
          context.vaultRoot,
          nodeId,
          ...historyArguments(historyContext)
        );
        const projectedWorkspace = await workspaceForScope(
          context,
          workspace,
          activeScopeRef.current
        );
        rememberHistoryAfter(historyContext, projectedWorkspace);
        return authoritative(projectedWorkspace);
      });
    },
    [
      beginStructuralEntry,
      runStructuralCommand,
      flushDraftBeforeStructural,
      rememberHistoryAfter,
      runCommand,
      runRootLifecycle
    ]
  );

  const restoreNode = useCallback(
    (nodeId: NoteId) => {
      closeTextBurst();
      return runStructuralCommand("restore", async (context, historyContext) => {
        const workspace = await context.repository.restoreNode(
          context.vaultRoot,
          nodeId,
          ...historyArguments(historyContext)
        );
        const projectedWorkspace = await workspaceForScope(
          context,
          workspace,
          activeScopeRef.current
        );
        rememberHistoryAfter(historyContext, projectedWorkspace);
        return authoritative(projectedWorkspace);
      });
    },
    [
      beginStructuralEntry,
      closeTextBurst,
      rememberHistoryAfter,
      runCommand,
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
          : undefined
      );
    });
  }, [closeTextBurst]);

  const deleteAllNotesData = useCallback(async (): Promise<void> => {
    const record = sessionRecordRef.current;
    if (!record || record.closing || sessionRef.current !== record.session) {
      throw new Error("The Notes workspace is unavailable.");
    }
    if (deletingNotesDataRef.current) {
      throw new Error("Notes data deletion is already in progress.");
    }

    const deletionToken = {};
    deletionTokenRef.current = deletionToken;
    deletingNotesDataRef.current = true;
    setDeletingNotesData(true);

    try {
      if (
        record.drafts.size > 0 &&
        !(await flushAllDraftsBeforeStructural())
      ) {
        throw (
          record.writeError ??
          new Error("Pending Notes changes could not be saved.")
        );
      }

      let deletionError: unknown = null;
      let deleted = false;
      await record.session.enqueueStructural(async (context) => {
        try {
          await context.repository.deleteDatabase(context.vaultRoot);
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

      record.drafts.clear();
      record.pendingDebounceByNodeId.clear();
      record.inFlightDraftByNodeId.clear();
      record.retryWriteByNodeId.clear();
      record.draftHistoryContextByNodeId.clear();
      record.draftHistoryFocusByNodeId.clear();
      record.failedWritesByNodeId.clear();
      record.writeError = null;
      record.recoveryEntry = null;
      record.session.history.clearSnapshots();
      clearRecoveryEntry(repository, vaultRoot);
      publishDraftState(record);
      if (
        sessionRecordRef.current === record &&
        sessionRef.current === record.session
      ) {
        activeScopeRef.current = { kind: "active" };
        setLibraryView("all");
        setActiveTag(null);
        setTags([]);
        replaceLocalExpansions(new Set());
      }
    } finally {
      if (deletionTokenRef.current === deletionToken) {
        deletionTokenRef.current = null;
        deletingNotesDataRef.current = false;
        setDeletingNotesData(false);
      }
    }
  }, [
    flushAllDraftsBeforeStructural,
    publishDraftState,
    replaceLocalExpansions,
    repository,
    vaultRoot
  ]);

  const zoomTo = useCallback(async (nodeId: NoteId | null) => {
    navigationVersionRef.current += 1;
    liveNavigationRef.current = {
      ...liveNavigationRef.current,
      zoomRootId: nodeId
    };
    dispatch({ type: "setZoomRoot", zoomRootId: nodeId });
  }, []);

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
      moveNode: gate(moveNode),
      toggleComplete: gate(toggleComplete),
      toggleCollapsed: gate(toggleCollapsed),
      toggleStar: gate(toggleStar),
      duplicateNode: gate(duplicateNode),
      removeEmptyNode: gate(removeEmptyNode),
      deleteNode: gate(deleteNode),
      restoreNode: gate(restoreNode),
      archiveNode: gate(archiveNode),
      unarchiveNode: gate(unarchiveNode),
      emptyTrash: gate(emptyTrash),
      selectLibraryView: gate(selectLibraryView),
      selectTag: gate(selectTag),
      searchNotes: (query) =>
        deletingNotesDataRef.current
          ? Promise.resolve([])
          : searchNotes(query),
      openSearchResult: gate(openSearchResult),
      deleteAllNotesData,
      zoomTo: gate(zoomTo),
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
    toggleStar,
    duplicateNode,
    removeEmptyNode,
    deleteNode,
    restoreNode,
    archiveNode,
    unarchiveNode,
    emptyTrash,
    selectLibraryView,
    selectTag,
    searchNotes,
    openSearchResult,
    deleteAllNotesData,
    zoomTo,
    undo,
    redo
  ]);

  return {
    state,
    actions,
    deletingNotesData,
    libraryView,
    activeTag,
    tags,
    locallyExpandedNodeIds,
    draftsByNodeId,
    writeError: currentWriteError,
    retryFailedDraft,
    retryLastFailedWrite,
    status: state.status,
    loading: state.status === "loading",
    error: state.error,
    canUndo: historyStatus.canUndo,
    canRedo: historyStatus.canRedo
  };
}
