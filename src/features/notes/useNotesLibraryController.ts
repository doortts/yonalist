import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import type {
  NoteId,
  NoteSearchResult,
  NoteTagFilter,
  NoteTagSummary,
  NotesStore,
  NotesWorkspace,
  NotesWorkspaceScope
} from "../../domain/notes";
import { imageLogicalLength } from "./imageAtomModel";
import type { NotesWorkspaceCoordinatorSession } from "./notesWorkspaceCoordinator";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import {
  notesExpansionSnapshotPool,
  type NotesHistorySnapshot
} from "./notesHistory";
import { parseAndValidateNoteSearchQuery } from "./noteSearchQuery";
import {
  canonicalizeTagFilters,
  tagFilterKey
} from "./notesWorkspaceScope";
import {
  cloneOwnedHistorySnapshot,
  cloneWorkspaceScope,
  releaseOwnedHistorySnapshot,
  restoredTagFilterNavigation,
  scopeForLibraryView,
  searchNavigation,
  snapshotForTagFilterOrigin,
  tagFilterOriginFromHistoryLocation,
  type NavigationIntent,
  type ResolvedHistoryLocation
} from "./notesWorkspaceNavigationSupport";
import type {
  NotesLibraryView,
  TagFilterOrigin
} from "./notesWorkspaceTypes";

interface LiveRef<T> {
  current: T;
}

interface TagSummaryRefreshWaiter {
  version: number;
  resolve(summaries: readonly NoteTagSummary[] | null): void;
}

export interface NotesLibraryStateController {
  readonly libraryView: NotesLibraryView;
  readonly libraryViewRef: LiveRef<NotesLibraryView>;
  readonly activeTagFilters: readonly NoteTagFilter[];
  readonly tagSummaries: readonly NoteTagSummary[];
  readonly activeScopeRef: LiveRef<NotesWorkspaceScope>;
  readonly requestedTagFiltersRef: LiveRef<readonly NoteTagFilter[]>;
  readonly tagFilterOriginRef: LiveRef<TagFilterOrigin | null>;
  readonly tagFilterRequestRef: LiveRef<number>;
  readonly setLibraryView: Dispatch<SetStateAction<NotesLibraryView>>;
  readonly setActiveTagFilters: Dispatch<
    SetStateAction<readonly NoteTagFilter[]>
  >;
  readonly setTagSummaries: Dispatch<
    SetStateAction<readonly NoteTagSummary[]>
  >;
  requestTagSummaryRefresh(): Promise<readonly NoteTagSummary[] | null>;
  invalidateTagSummaries(): void;
  resetTagFilterTracking(): void;
}

export function useNotesLibraryState(
  sessionRecordRef: LiveRef<NotesWorkspaceSessionRecord | null>,
  sessionRef: LiveRef<NotesWorkspaceCoordinatorSession | null>
): NotesLibraryStateController {
  const [libraryView, setLibraryView] = useState<NotesLibraryView>("all");
  const libraryViewRef = useRef(libraryView);
  libraryViewRef.current = libraryView;
  const [activeTagFilters, setActiveTagFilters] = useState<
    readonly NoteTagFilter[]
  >([]);
  const [tagSummaries, setTagSummaries] = useState<readonly NoteTagSummary[]>([]);
  const activeScopeRef = useRef<NotesWorkspaceScope>({ kind: "active" });
  const requestedTagFiltersRef = useRef<readonly NoteTagFilter[]>([]);
  const tagFilterOriginRef = useRef<TagFilterOrigin | null>(null);
  const tagFilterRequestRef = useRef(0);
  const requestedVersionRef = useRef(0);
  const settledVersionRef = useRef(0);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const waitersRef = useRef<TagSummaryRefreshWaiter[]>([]);
  const pumpRef = useRef<(() => void) | null>(null);

  const settleWaiters = useCallback(
    (version: number, summaries: readonly NoteTagSummary[] | null): void => {
      const settled: TagSummaryRefreshWaiter[] = [];
      const pending: TagSummaryRefreshWaiter[] = [];
      for (const waiter of waitersRef.current) {
        (waiter.version <= version ? settled : pending).push(waiter);
      }
      waitersRef.current = pending;
      for (const waiter of settled) waiter.resolve(summaries);
    },
    []
  );
  const pump = useCallback((): void => {
    if (refreshPromiseRef.current) return;
    let completion!: Promise<void>;
    completion = (async () => {
      while (settledVersionRef.current < requestedVersionRef.current) {
        const version = requestedVersionRef.current;
        const record = sessionRecordRef.current;
        const session = record?.session ?? null;
        let summaries: readonly NoteTagSummary[] | null = null;
        if (record && !record.closing && sessionRef.current === session) {
          try {
            summaries = await record.repository.listTagsWithCounts(
              record.vaultRoot
            );
          } catch {
            summaries = null;
          }
        }
        settledVersionRef.current = Math.max(
          settledVersionRef.current,
          version
        );
        if (version !== requestedVersionRef.current) continue;
        const recordStillCurrent =
          record !== null &&
          !record.closing &&
          sessionRecordRef.current === record &&
          sessionRef.current === session;
        if (recordStillCurrent && summaries) setTagSummaries(summaries);
        settleWaiters(version, recordStillCurrent ? summaries : null);
      }
    })().finally(() => {
      if (refreshPromiseRef.current !== completion) return;
      refreshPromiseRef.current = null;
      if (settledVersionRef.current < requestedVersionRef.current) {
        pumpRef.current?.();
      }
    });
    refreshPromiseRef.current = completion;
  }, [sessionRecordRef, sessionRef, settleWaiters]);
  pumpRef.current = pump;

  const requestTagSummaryRefresh = useCallback(() => {
    const version = ++requestedVersionRef.current;
    const completion = new Promise<readonly NoteTagSummary[] | null>(
      (resolve) => waitersRef.current.push({ version, resolve })
    );
    pumpRef.current?.();
    return completion;
  }, []);
  const invalidateTagSummaries = useCallback((): void => {
    const version = ++requestedVersionRef.current;
    settledVersionRef.current = Math.max(settledVersionRef.current, version);
    settleWaiters(version, null);
    setTagSummaries([]);
  }, [settleWaiters]);
  const resetTagFilterTracking = useCallback((): void => {
    requestedTagFiltersRef.current = [];
    tagFilterOriginRef.current = null;
    tagFilterRequestRef.current += 1;
    setActiveTagFilters([]);
  }, []);

  return {
    libraryView,
    libraryViewRef,
    activeTagFilters,
    tagSummaries,
    activeScopeRef,
    requestedTagFiltersRef,
    tagFilterOriginRef,
    tagFilterRequestRef,
    setLibraryView,
    setActiveTagFilters,
    setTagSummaries,
    requestTagSummaryRefresh,
    invalidateTagSummaries,
    resetTagFilterTracking
  };
}

interface NotesLibraryActionsDependencies {
  readonly repository: NotesStore;
  readonly vaultRoot: string;
  readonly navigateWithHistory: (
    intent: NavigationIntent,
    workspaceGeneration?: number
  ) => Promise<void>;
  readonly resolveHistoryLocation: (
    requested: NotesHistorySnapshot,
    loadedWorkspace?: NotesWorkspace
  ) => Promise<ResolvedHistoryLocation | null>;
}

export interface NotesLibraryActionsController {
  selectLibraryView(view: NotesLibraryView): Promise<void>;
  toggleTagFilter(filter: NoteTagFilter): Promise<void>;
  searchNotes(query: string): Promise<NoteSearchResult[]>;
  openSearchResult(nodeId: NoteId): Promise<void>;
  zoomTo(nodeId: NoteId | null): Promise<void>;
}

export function useNotesLibraryActions({
  repository,
  vaultRoot,
  navigateWithHistory,
  resolveHistoryLocation
}: NotesLibraryActionsDependencies): NotesLibraryActionsController {
  const loadLibraryScope = useCallback(
    async (view: NotesLibraryView, scope: NotesWorkspaceScope): Promise<void> => {
      await navigateWithHistory(async () => {
        const requested: NotesHistorySnapshot = {
          scope: cloneWorkspaceScope(scope),
          libraryView: view,
          activeTagFilters: [],
          selectedId: null,
          zoomRootId: null,
          expansion: notesExpansionSnapshotPool.acquire([]),
          focus: null,
          tagFilterOrigin: null
        };
        try {
          const resolved = await resolveHistoryLocation(requested);
          if (!resolved) {
            throw new Error("The requested Notes library could not be loaded.");
          }
          return resolved;
        } finally {
          releaseOwnedHistorySnapshot(requested);
        }
      });
    },
    [navigateWithHistory, resolveHistoryLocation]
  );
  const selectLibraryView = useCallback(
    async (view: NotesLibraryView): Promise<void> => {
      if (view !== "tags") {
        await loadLibraryScope(view, scopeForLibraryView(view));
        return;
      }
      await navigateWithHistory(async ({ snapshot }) => {
        const currentFilters =
          snapshot.libraryView === "tags"
            ? canonicalizeTagFilters(snapshot.activeTagFilters)
            : [];
        if (currentFilters.length > 0) return null;
        const origin = tagFilterOriginFromHistoryLocation(
          snapshot.tagFilterOrigin ?? snapshot
        );
        const scope: NotesWorkspaceScope = { kind: "tags", tags: [] };
        const [loaded, summaries] = await Promise.all([
          repository.loadWorkspace(vaultRoot, scope),
          repository.listTagsWithCounts(vaultRoot)
        ]);
        const requested: NotesHistorySnapshot = {
          scope,
          libraryView: "tags",
          activeTagFilters: [],
          selectedId: null,
          zoomRootId: null,
          expansion: notesExpansionSnapshotPool.acquire([]),
          focus: null,
          tagFilterOrigin: snapshotForTagFilterOrigin(origin)
        };
        try {
          const resolved = await resolveHistoryLocation(requested, loaded);
          if (!resolved) throw new Error("The Tags chooser could not be loaded.");
          return { ...resolved, tagSummaries: summaries };
        } finally {
          releaseOwnedHistorySnapshot(requested);
        }
      });
    },
    [
      loadLibraryScope,
      navigateWithHistory,
      repository,
      resolveHistoryLocation,
      vaultRoot
    ]
  );
  const toggleTagFilter = useCallback(
    async (filter: NoteTagFilter): Promise<void> => {
      await navigateWithHistory(async ({ snapshot }) => {
        const currentFilters =
          snapshot.libraryView === "tags"
            ? canonicalizeTagFilters(snapshot.activeTagFilters)
            : [];
        const key = tagFilterKey(filter);
        const exists = currentFilters.some(
          (candidate) => tagFilterKey(candidate) === key
        );
        const nextFilters = canonicalizeTagFilters(
          exists
            ? currentFilters.filter(
                (candidate) => tagFilterKey(candidate) !== key
              )
            : [...currentFilters, filter]
        );
        const savedOrigin = snapshot.tagFilterOrigin
          ? tagFilterOriginFromHistoryLocation(snapshot.tagFilterOrigin)
          : null;
        const origin =
          currentFilters.length === 0
            ? savedOrigin ?? tagFilterOriginFromHistoryLocation(snapshot)
            : savedOrigin;
        const nextScope: NotesWorkspaceScope =
          nextFilters.length > 0
            ? { kind: "tags", tags: nextFilters }
            : cloneWorkspaceScope(origin?.scope ?? { kind: "active" });
        const [loaded, summaries] = await Promise.all([
          repository.loadWorkspace(vaultRoot, nextScope),
          repository.listTagsWithCounts(vaultRoot)
        ]);
        const restoration =
          nextFilters.length === 0 && origin
            ? restoredTagFilterNavigation(loaded, origin)
            : null;
        const requested: NotesHistorySnapshot = {
          scope: cloneWorkspaceScope(nextScope),
          libraryView:
            nextFilters.length > 0 ? "tags" : origin?.libraryView ?? "all",
          activeTagFilters: nextFilters,
          selectedId: restoration?.uiUpdate.selectedId ?? null,
          zoomRootId: restoration?.uiUpdate.zoomRootId ?? null,
          expansion: notesExpansionSnapshotPool.acquire(
            restoration ? [...restoration.expandedNodeIds] : []
          ),
          focus: restoration?.uiUpdate.editingNoteId
            ? {
                nodeId: restoration.uiUpdate.editingNoteId,
                field: restoration.uiUpdate.pendingFocusField ?? "title"
              }
            : null,
          tagFilterOrigin:
            nextFilters.length > 0 && origin
              ? snapshotForTagFilterOrigin(origin)
              : null
        };
        try {
          const resolved = await resolveHistoryLocation(requested, loaded);
          if (!resolved) {
            throw new Error("The requested tag filter could not be loaded.");
          }
          return { ...resolved, tagSummaries: summaries };
        } finally {
          releaseOwnedHistorySnapshot(requested);
        }
      });
    },
    [navigateWithHistory, repository, resolveHistoryLocation, vaultRoot]
  );
  const searchNotes = useCallback(
    async (query: string): Promise<NoteSearchResult[]> => {
      const parsed = parseAndValidateNoteSearchQuery(query);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const structured =
        parsed.query.requiredTags.length > 0 ||
        parsed.query.excludedTags.length > 0 ||
        parsed.query.orGroups.length > 0;
      if (!structured) return repository.search(vaultRoot, parsed.query.text);
      if (!repository.searchStructured) {
        throw new Error("Structured Notes search is unavailable.");
      }
      return repository.searchStructured(vaultRoot, parsed.query);
    },
    [repository, vaultRoot]
  );
  const openSearchResult = useCallback(
    (nodeId: NoteId): Promise<void> =>
      navigateWithHistory(async () => {
        const loaded = await repository.loadWorkspace(vaultRoot, {
          kind: "active"
        });
        const navigation = searchNavigation(loaded, nodeId);
        const requested: NotesHistorySnapshot = {
          scope: { kind: "active" },
          libraryView: "all",
          activeTagFilters: [],
          selectedId: navigation ? nodeId : null,
          zoomRootId: navigation?.rootId ?? null,
          expansion: notesExpansionSnapshotPool.acquire(
            navigation ? [...navigation.expandedNodeIds] : []
          ),
          focus: navigation ? { nodeId, field: "title" } : null,
          tagFilterOrigin: null
        };
        try {
          const resolved = await resolveHistoryLocation(requested, loaded);
          if (!resolved) throw new Error("The requested note could not be opened.");
          return resolved;
        } finally {
          releaseOwnedHistorySnapshot(requested);
        }
      }),
    [navigateWithHistory, repository, resolveHistoryLocation, vaultRoot]
  );
  const zoomTo = useCallback(
    (nodeId: NoteId | null): Promise<void> =>
      navigateWithHistory(async ({ workspace, snapshot }) => {
        const zoomNode =
          nodeId === null ? undefined : workspace.nodesById[nodeId];
        const zoomRootId = zoomNode ? nodeId : null;
        const destination = cloneOwnedHistorySnapshot(snapshot);
        const titleEnd = zoomNode
          ? zoomNode.nodeKind === "image"
            ? imageLogicalLength(zoomNode)
            : zoomNode.title.length
          : null;
        return {
          workspace,
          snapshot: {
            ...destination,
            selectedId: zoomRootId,
            zoomRootId,
            focus:
              zoomNode && titleEnd !== null
                ? {
                    nodeId: zoomNode.id,
                    field: "title",
                    primarySelection: {
                      anchorUtf16: titleEnd,
                      focusUtf16: titleEnd
                    }
                  }
                : null
          }
        };
      }),
    [navigateWithHistory]
  );

  return {
    selectLibraryView,
    toggleTagFilter,
    searchNotes,
    openSearchResult,
    zoomTo
  };
}
