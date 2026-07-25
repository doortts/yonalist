import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoteNode, NotesStore, NotesWorkspace } from "../../domain/notes";
import {
  createNotesWriteQueue,
  MAX_DEBOUNCE_LATENCY_MS,
} from "../../services/notesWriteQueue";
import type {
  NotesWorkspaceCommandOutcome,
  NotesDraftEngineCoordinatorSession,
  NotesWorkspaceQueueContext,
  NotesWorkspaceQueueResult,
} from "./notesWorkspaceCoordinator";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import {
  NotesDraftEngine,
  type NotesDraftEngineHost,
} from "./notesDraftEngine";
import { unwrapNotesMutation } from "./notesWorkspaceProjection";
import type { NotesImageAtomFlushAdapter } from "./notesImageAtomEditorRegistry";

// These tests exercise NotesDraftEngine as a plain object: no React, no
// renderHook, no context. The engine reaches history/scope/navigation through
// its host, and the coordinator session and write queue are the only external
// collaborators, so a lightweight fake session plus the real write queue is
// enough to drive every draft/queue/retry/recovery scenario the hook test file
// used to cover through React.

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    nodeKind: "text",
    parentId: null,
    sortKey: 1024,
    title: overrides.id,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet",
    markdownImageWidth: overrides.markdownImageWidth ?? null,
  };
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function repository(overrides: Partial<NotesStore> = {}): NotesStore {
  const empty = vi.fn().mockResolvedValue(workspace([]));
  const initialHistoryState = {
    canUndo: false,
    canRedo: false,
    historyEpoch: "epoch-a",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: [],
  };
  return {
    initialize: vi.fn().mockResolvedValue(initialHistoryState),
    loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
    createNode: empty,
    updateNode: empty,
    setReadonly: empty,
    materializeGithubNotificationAndCreateSibling: empty,
    materializeGithubNotificationAndReparent: empty,
    refreshMaterializedGithubNotifications: empty,
    setGithubGroupCollapsed: empty,
    markMaterializedGithubNotificationRead: empty,
    deleteNodes: empty,
    splitNode: empty,
    applyImageAtomEdit: vi.fn<NotesStore["applyImageAtomEdit"]>(),
    applyImageAtomPaste: vi.fn<NotesStore["applyImageAtomPaste"]>(),
    moveNode: empty,
    applyBatch: empty,
    importSubtree: empty,
    importMarkdown: vi.fn<NotesStore["importMarkdown"]>(),
    toggleComplete: empty,
    toggleCollapsed: empty,
    toggleStar: empty,
    duplicateNode: empty,
    removeEmptyNode: empty,
    softDeleteNode: empty,
    restoreNode: empty,
    archiveNode: empty,
    unarchiveNode: empty,
    undo: empty,
    redo: empty,
    lookupImageAtomOperation: vi.fn<NotesStore["lookupImageAtomOperation"]>(
      async (_vaultPath, _sessionId, historyEpoch) => ({
        kind: "missing",
        historyEpoch,
      }),
    ),
    ackImageAtomOperation: vi.fn<NotesStore["ackImageAtomOperation"]>(
      async () => undefined,
    ),
    clearHistory: vi.fn().mockResolvedValue({
      ...initialHistoryState,
      historyReset: true,
    }),
    pruneHistoryEntries: vi.fn().mockResolvedValue(initialHistoryState),
    prepareNavigation: vi.fn().mockResolvedValue(initialHistoryState),
    closeHistorySession: vi.fn().mockResolvedValue(undefined),
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi
      .fn()
      .mockResolvedValue({ attachmentCleanupFailed: false }),
    importAttachmentPaths: vi.fn().mockResolvedValue(workspace([])),
    importAttachmentBytes: vi.fn().mockResolvedValue(workspace([])),
    ...overrides,
  };
}

const textHistoryContext = expect.objectContaining({
  entryId: expect.stringMatching(/^entry-\d+$/),
  commandKind: "text",
});

interface Harness {
  engine: NotesDraftEngine;
  store: NotesStore;
  session: NotesDraftEngineCoordinatorSession;
  close: ReturnType<typeof vi.fn>;
  host: NotesDraftEngineHost;
  /** How many times each granular listener fired. */
  counts: { drafts: number; writeError: number };
  /** Point the "active" pointers at a different engine's record/session. */
  activate(
    engine: NotesDraftEngine,
    session: NotesDraftEngineCoordinatorSession,
  ): void;
  /** Detach the active pointers so the engine reads as no-longer-current. */
  deactivate(): void;
  setDeleting(value: boolean): void;
}

interface HarnessOptions {
  store?: NotesStore;
  vaultRoot?: string;
  confirmedWorkspace?: NotesWorkspace;
  /** Reuse a module-shared entry counter so entry ids stay globally unique. */
  entryIds?: { next: number };
}

function createSession(options: {
  store: NotesStore;
  vaultRoot: string;
  confirmedWorkspace: NotesWorkspace;
}): {
  session: NotesDraftEngineCoordinatorSession;
  close: ReturnType<typeof vi.fn>;
} {
  const { store, vaultRoot, confirmedWorkspace } = options;
  const close = vi.fn();
  let tail: Promise<unknown> = Promise.resolve();
  const context: NotesWorkspaceQueueContext = {
    repository: store,
    vaultRoot,
    confirmedWorkspace,
    sourceScope: { kind: "active" },
  };
  const runSerialized = (
    work: (context: NotesWorkspaceQueueContext) => unknown,
  ): Promise<NotesWorkspaceCommandOutcome> => {
    const run = tail.then(() => work(context));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(
      () => "committed" as const,
      () => "failed" as const,
    );
  };
  const history = {
    closeTextBurst: vi.fn(),
    clearSnapshots: vi.fn(),
  } as unknown as NotesDraftEngineCoordinatorSession["history"];
  const session: NotesDraftEngineCoordinatorSession = {
    activation: Promise.resolve(),
    history,
    enqueue: (work) => runSerialized(work),
    enqueueStructural: (work) => runSerialized(work),
    close,
  };
  return { session, close };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const store = options.store ?? repository();
  const vaultRoot = options.vaultRoot ?? "/vault";
  const confirmedWorkspace =
    options.confirmedWorkspace ?? workspace([node({ id: "root" })]);
  const entryIds = options.entryIds ?? { next: 1 };
  const { session, close } = createSession({
    store,
    vaultRoot,
    confirmedWorkspace,
  });

  const active: {
    record: NotesDraftEngine["record"] | null;
    session: NotesDraftEngineCoordinatorSession | null;
    deleting: boolean;
    engine: NotesDraftEngine | null;
  } = { record: null, session: null, deleting: false, engine: null };

  const counts = { drafts: 0, writeError: 0 };

  const newHistoryContext = () => ({
    sessionId: "session-0",
    historyEpoch: "epoch-a",
    entryId: `entry-${entryIds.next++}`,
    commandKind: "text" as const,
  });

  const host: NotesDraftEngineHost = {
    beginTextEntry: vi.fn(() => newHistoryContext()),
    beginStandaloneTextEntry: vi.fn(() => newHistoryContext()),
    completeHistoryOwner: vi.fn(),
    discardHistoryEntry: vi.fn(),
    // Faithful stand-in for the hook's real mutation runner: drives the
    // repository and maps the outcome the same way (skipped / authoritative /
    // failure) so the engine's settle logic sees identical results.
    persistDraftMutation: async (
      context,
      attempt,
    ): Promise<NotesWorkspaceQueueResult> => {
      const { nodeId, draft, historyContext } = attempt;
      if (!normalizeWorkspace(context.confirmedWorkspace).nodesById[nodeId]) {
        return { kind: "skipped" };
      }
      if (!historyContext) {
        throw new Error("A draft mutation requires a history context.");
      }
      try {
        const response = await context.repository.updateNode(
          context.vaultRoot,
          {
            id: nodeId,
            title: draft.title,
            note: draft.note,
            imageOffsetUtf16: draft.imageOffsetUtf16,
            markerKind: draft.markerKind ?? "bullet",
          },
          historyContext,
        );
        return {
          kind: "authoritative",
          workspace: unwrapNotesMutation(response, {
            workspace: context.confirmedWorkspace,
            scope: context.sourceScope
          }).workspace,
        };
      } catch (cause) {
        return {
          kind: "failure",
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    setDraftEditingNavigation: vi.fn(),
    currentRecord: () => active.record,
    currentSession: () => active.session,
    isDeletingNotesData: () => active.deleting,
    onDraftsChanged: () => {
      counts.drafts += 1;
    },
    onWriteErrorChanged: () => {
      counts.writeError += 1;
    },
  };

  const engine = new NotesDraftEngine({
    repository: store,
    vaultRoot,
    session,
    writeQueue: createNotesWriteQueue(),
    host,
  });
  active.record = engine.record;
  active.session = session;
  active.engine = engine;

  return {
    engine,
    store,
    session,
    close,
    host,
    counts,
    activate: (nextEngine, nextSession) => {
      active.record = nextEngine.record;
      active.session = nextSession;
      active.engine = nextEngine;
    },
    deactivate: () => {
      active.record = null;
      active.session = null;
    },
    setDeleting: (value) => {
      active.deleting = value;
    },
  };
}

/** Let queued microtasks (write-queue settling, recovery adoption) drain. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NotesDraftEngine", () => {
  describe("Backspace draft leases", () => {
    it("keeps gesture revisions out of the ordinary debounce", async () => {
      vi.useFakeTimers();
      const store = repository();
      const { engine } = createHarness({ store });
      engine.updateNodeDraft(
        "root",
        { title: "before", note: "", imageOffsetUtf16: 0 },
        "title",
      );
      const lease = engine.beginBackspaceGesture(7, "root");
      expect(lease).not.toBeNull();
      engine.updateNodeDraft(
        "root",
        { title: "after", note: "", imageOffsetUtf16: 0 },
        "title",
      );
      lease!.touch("root");

      await vi.advanceTimersByTimeAsync(MAX_DEBOUNCE_LATENCY_MS + 1);

      expect(store.updateNode).toHaveBeenCalledTimes(1);
      expect(store.updateNode).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({ id: "root", title: "before" }),
        textHistoryContext,
      );
      await expect(lease!.prepare([])).resolves.toEqual({
        baselineFlushed: true,
        titleUpdate: { id: "root", title: "after" },
      });
    });

    it("flushes a second touched node's captured baseline exactly once", async () => {
      vi.useFakeTimers();
      const confirmedWorkspace = workspace([
        node({ id: "root" }),
        node({ id: "other" }),
      ]);
      const store = repository({
        updateNode: vi.fn().mockResolvedValue(confirmedWorkspace),
      });
      const { engine } = createHarness({ store, confirmedWorkspace });
      const lease = engine.beginBackspaceGesture(8, "root")!;
      engine.updateNodeDraft("other", {
        title: "other before",
        note: "",
        imageOffsetUtf16: 0,
      });

      lease.touch("other");
      lease.touch("other");
      engine.updateNodeDraft("other", {
        title: "other after",
        note: "",
        imageOffsetUtf16: 0,
      });
      await vi.advanceTimersByTimeAsync(MAX_DEBOUNCE_LATENCY_MS + 1);

      expect(store.updateNode).toHaveBeenCalledOnce();
      expect(store.updateNode).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({ id: "other", title: "other before" }),
        textHistoryContext,
      );
      await expect(lease.prepare([])).resolves.toMatchObject({
        baselineFlushed: true,
      });
    });

    it("omits removed-node drafts from the prepared title update", async () => {
      vi.useFakeTimers();
      const { engine } = createHarness({
        confirmedWorkspace: workspace([
          node({ id: "root" }),
          node({ id: "other" }),
        ]),
      });
      const lease = engine.beginBackspaceGesture(9, "root")!;
      engine.updateNodeDraft("root", {
        title: "removed",
        note: "",
        imageOffsetUtf16: 0,
      });
      lease.touch("other");
      engine.updateNodeDraft("other", {
        title: "survivor",
        note: "",
        imageOffsetUtf16: 0,
      });

      await expect(lease.prepare(["root"])).resolves.toEqual({
        baselineFlushed: true,
        titleUpdate: { id: "other", title: "survivor" },
      });
    });

    it.each(["node", "all", "structural"] as const)(
      "keeps held revisions out of the ordinary %s flush path",
      async (kind) => {
        vi.useFakeTimers();
        const store = repository();
        const { engine, session } = createHarness({ store });
        const enqueue = vi.spyOn(session, "enqueue");
        engine.beginBackspaceGesture(10, "root");
        engine.updateNodeDraft("root", {
          title: "held",
          note: "",
          imageOffsetUtf16: 0,
        });

        const flushed =
          kind === "node"
            ? await engine.flushNodeDraft("root")
            : kind === "all"
              ? await engine.flushAllDrafts()
              : await engine.flushDraftBarrier(engine.captureDraftCutoff());
        await vi.advanceTimersByTimeAsync(MAX_DEBOUNCE_LATENCY_MS + 1);

        expect(flushed).toBe(kind === "structural");
        expect(enqueue).not.toHaveBeenCalled();
        expect(store.updateNode).not.toHaveBeenCalled();
        expect(engine.getDraftsSnapshot().root).toMatchObject({
          title: "held",
          status: "pending",
        });
      },
    );

    it("retires committed held drafts without another write", async () => {
      vi.useFakeTimers();
      const store = repository();
      const { engine, counts } = createHarness({ store });
      const lease = engine.beginBackspaceGesture(11, "root")!;
      engine.updateNodeDraft("root", {
        title: "committed in batch",
        note: "",
        imageOffsetUtf16: 0,
      });
      await lease.prepare([]);
      const publicationsBefore = counts.drafts;

      lease.settle("committed");
      lease.settle("committed");
      await vi.advanceTimersByTimeAsync(MAX_DEBOUNCE_LATENCY_MS + 1);

      expect(engine.getDraftsSnapshot()).toEqual({});
      expect(engine.record.retryWriteByNodeId.has("root")).toBe(false);
      expect(counts.drafts).toBe(publicationsBefore + 1);
      expect(store.updateNode).not.toHaveBeenCalled();
      await expect(engine.flushAllDrafts()).resolves.toBe(true);
      expect(store.updateNode).not.toHaveBeenCalled();
    });

    it.each(["failed", "cancelled"] as const)(
      "restores and reschedules the starting draft after %s settlement",
      async (outcome) => {
        vi.useFakeTimers();
        const store = repository({
          updateNode: vi
            .fn()
            .mockResolvedValue(
              workspace([node({ id: "root", title: "before" })]),
            ),
        });
        const { engine, counts } = createHarness({ store });
        engine.updateNodeDraft("root", {
          title: "before",
          note: "",
          imageOffsetUtf16: 0,
        });
        const startingDraft = { ...engine.getDraftsSnapshot().root };
        const lease = engine.beginBackspaceGesture(12, "root")!;
        engine.updateNodeDraft("root", {
          title: "after",
          note: "",
          imageOffsetUtf16: 0,
        });
        await expect(lease.prepare([])).resolves.toMatchObject({
          baselineFlushed: true,
        });
        expect(store.updateNode).toHaveBeenCalledOnce();
        const publicationsBefore = counts.drafts;

        lease.settle(outcome);
        lease.settle(outcome);

        expect(engine.getDraftsSnapshot().root).toEqual(startingDraft);
        expect(counts.drafts).toBe(publicationsBefore + 1);
        await vi.advanceTimersByTimeAsync(300);
        expect(store.updateNode).toHaveBeenCalledTimes(2);
        expect(engine.getDraftsSnapshot()).toEqual({});
      },
    );

    it("keeps a cancelled starting draft while its baseline write settles", async () => {
      vi.useFakeTimers();
      const baselineWrite = deferred<NotesWorkspace>();
      const store = repository({
        updateNode: vi.fn().mockReturnValue(baselineWrite.promise),
      });
      const { engine } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before",
        note: "",
        imageOffsetUtf16: 0,
      });
      const startingDraft = { ...engine.getDraftsSnapshot().root };
      const lease = engine.beginBackspaceGesture(13, "root")!;
      engine.updateNodeDraft("root", {
        title: "after",
        note: "",
        imageOffsetUtf16: 0,
      });
      await flushMicrotasks();
      expect(store.updateNode).toHaveBeenCalledOnce();

      lease.settle("cancelled");
      expect(engine.getDraftsSnapshot().root).toEqual(startingDraft);
      baselineWrite.resolve(
        workspace([node({ id: "root", title: "before" })]),
      );
      await flushMicrotasks();

      expect(engine.getDraftsSnapshot().root).toEqual(startingDraft);
      expect(store.updateNode).toHaveBeenCalledOnce();
    });

    it("returns a failed preparation without exposing a title update", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full")),
      });
      const { engine, host } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before",
        note: "",
        imageOffsetUtf16: 0,
      });
      const baselineHistory =
        engine.record.draftHistoryContextByNodeId.get("root");
      const lease = engine.beginBackspaceGesture(14, "root")!;
      engine.updateNodeDraft("root", {
        title: "after",
        note: "",
        imageOffsetUtf16: 0,
      });

      await expect(lease.prepare([])).resolves.toEqual({
        baselineFlushed: false,
        titleUpdate: null,
      });
      expect(store.updateNode).toHaveBeenCalledOnce();
      engine.discardPendingDrafts();
      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(baselineHistory);
    });

    it("persists the exact starting draft beyond an older structural cutoff", async () => {
      vi.useFakeTimers();
      const persistedWorkspace = workspace([
        node({
          id: "root",
          title: "exact starting title",
          note: "exact starting note",
          imageOffsetUtf16: 7,
          markerKind: "todo",
        }),
      ]);
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("old revision failed"))
          .mockResolvedValueOnce(persistedWorkspace),
      });
      const { engine } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "old failed title",
        note: "old failed note",
        imageOffsetUtf16: 1,
        markerKind: "bullet",
      });
      await expect(engine.flushNodeDraft("root")).resolves.toBe(false);
      engine.captureDraftCutoff();
      engine.updateNodeDraft("root", {
        title: "exact starting title",
        note: "exact starting note",
        imageOffsetUtf16: 7,
        markerKind: "todo",
      });

      const lease = engine.beginBackspaceGesture(23, "root")!;
      engine.updateNodeDraft("root", {
        title: "gesture title",
        note: "gesture note",
        imageOffsetUtf16: 9,
        markerKind: "todo",
      });

      await expect(lease.prepare([])).resolves.toEqual({
        baselineFlushed: true,
        titleUpdate: { id: "root", title: "gesture title" },
      });
      expect(store.updateNode).toHaveBeenCalledTimes(2);
      expect(store.updateNode).toHaveBeenNthCalledWith(
        2,
        "/vault",
        {
          id: "root",
          title: "exact starting title",
          note: "exact starting note",
          imageOffsetUtf16: 7,
          markerKind: "todo",
        },
        textHistoryContext,
      );
    });

    it("fails preparation when the exact starting attempt is unavailable", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("old revision failed")),
      });
      const { engine } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "old failed title",
        note: "",
        imageOffsetUtf16: 0,
      });
      await expect(engine.flushNodeDraft("root")).resolves.toBe(false);
      engine.captureDraftCutoff();
      engine.updateNodeDraft("root", {
        title: "unavailable starting title",
        note: "must not be skipped",
        imageOffsetUtf16: 5,
        markerKind: "todo",
      });
      engine.record.retryWriteByNodeId.delete("root");

      const lease = engine.beginBackspaceGesture(24, "root")!;

      await expect(lease.prepare([])).resolves.toEqual({
        baselineFlushed: false,
        titleUpdate: null,
      });
      expect(store.updateNode).toHaveBeenCalledOnce();
    });

    it("ignores manual retry while the failed node is held by a gesture", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full")),
      });
      const { engine, session } = createHarness({ store });
      const enqueue = vi.spyOn(session, "enqueue");
      engine.updateNodeDraft("root", {
        title: "before",
        note: "",
        imageOffsetUtf16: 0,
      });
      const lease = engine.beginBackspaceGesture(15, "root")!;
      engine.updateNodeDraft("root", {
        title: "held",
        note: "",
        imageOffsetUtf16: 0,
      });
      await expect(lease.prepare([])).resolves.toMatchObject({
        baselineFlushed: false,
      });
      expect(enqueue).toHaveBeenCalledOnce();

      await engine.retryFailedDraft("root");

      expect(enqueue).toHaveBeenCalledOnce();
      expect(store.updateNode).toHaveBeenCalledOnce();
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "held",
        status: "pending",
      });
    });

    it("admits one baseline when a failed settlement is followed by a second gesture", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValue(
            workspace([node({ id: "root", title: "before" })]),
          ),
      });
      const { engine } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before",
        note: "",
        imageOffsetUtf16: 0,
      });
      const firstLease = engine.beginBackspaceGesture(16, "root")!;
      engine.updateNodeDraft("root", {
        title: "first held",
        note: "",
        imageOffsetUtf16: 0,
      });
      await expect(firstLease.prepare([])).resolves.toMatchObject({
        baselineFlushed: false,
      });
      const failedAttemptId =
        engine.record.failedWritesByNodeId.get("root")!.attemptId;
      engine.record.manualRetryAttemptIds.add(failedAttemptId);

      firstLease.settle("failed");

      expect(engine.record.failedWritesByNodeId.has("root")).toBe(false);
      expect(engine.record.manualRetryAttemptIds.has(failedAttemptId)).toBe(
        false,
      );
      expect(store.updateNode).toHaveBeenCalledOnce();

      const secondLease = engine.beginBackspaceGesture(17, "root")!;
      await expect(secondLease.prepare([])).resolves.toMatchObject({
        baselineFlushed: true,
      });
      await flushMicrotasks();

      expect(store.updateNode).toHaveBeenCalledTimes(2);
    });

    it("hands only pre-gesture drafts to shutdown recovery", async () => {
      vi.useFakeTimers();
      const confirmedWorkspace = workspace([
        node({ id: "root" }),
        node({ id: "other" }),
      ]);
      const sharedRepository = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full")),
      });
      const first = createHarness({
        store: sharedRepository,
        vaultRoot: "/gesture-shutdown",
        confirmedWorkspace,
      });
      first.engine.updateNodeDraft("root", {
        title: "root before",
        note: "",
        imageOffsetUtf16: 0,
      });
      const lease = first.engine.beginBackspaceGesture(18, "root")!;
      first.engine.updateNodeDraft("root", {
        title: "root held",
        note: "",
        imageOffsetUtf16: 0,
      });
      lease.touch("other");
      first.engine.updateNodeDraft("other", {
        title: "other held",
        note: "",
        imageOffsetUtf16: 0,
      });
      first.deactivate();

      await first.engine.beginShutdown();

      const second = createHarness({
        store: sharedRepository,
        vaultRoot: "/gesture-shutdown",
        confirmedWorkspace,
      });
      await flushMicrotasks();

      expect(second.engine.getDraftsSnapshot().root).toMatchObject({
        title: "root before",
      });
      expect(second.engine.getDraftsSnapshot().other).toBeUndefined();
    });

    it("invalidates a lease before data deletion clears its drafts", async () => {
      vi.useFakeTimers();
      const baselineWrite = deferred<NotesWorkspace>();
      const store = repository({
        updateNode: vi.fn().mockReturnValue(baselineWrite.promise),
      });
      const { engine } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before",
        note: "",
        imageOffsetUtf16: 0,
      });
      const lease = engine.beginBackspaceGesture(19, "root")!;
      engine.updateNodeDraft("root", {
        title: "held",
        note: "",
        imageOffsetUtf16: 0,
      });
      await flushMicrotasks();

      engine.resetAfterDataDeletion();
      lease.settle("failed");
      baselineWrite.resolve(workspace([]));
      await flushMicrotasks();

      expect(engine.getDraftsSnapshot()).toEqual({});
      expect(engine.getWriteErrorSnapshot()).toBeNull();
      await expect(lease.prepare([])).resolves.toMatchObject({
        baselineFlushed: false,
      });
    });

    it("ignores a late rejected baseline after data-deletion reset", async () => {
      vi.useFakeTimers();
      const baselineWrite = deferred<NotesWorkspace>();
      const store = repository({
        updateNode: vi.fn().mockReturnValue(baselineWrite.promise),
      });
      const { engine, host } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before reset",
        note: "old note",
        imageOffsetUtf16: 2,
      });
      const oldHistory =
        engine.record.draftHistoryContextByNodeId.get("root");
      const lease = engine.beginBackspaceGesture(25, "root")!;
      await flushMicrotasks();
      expect(store.updateNode).toHaveBeenCalledOnce();

      engine.resetAfterDataDeletion();
      engine.updateNodeDraft("root", {
        title: "after reset",
        note: "new note",
        imageOffsetUtf16: 4,
        markerKind: "todo",
      });
      const futureHistory =
        engine.record.draftHistoryContextByNodeId.get("root");
      baselineWrite.reject(new Error("late disk failure"));
      await flushMicrotasks();

      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "after reset",
        note: "new note",
        imageOffsetUtf16: 4,
        markerKind: "todo",
        status: "pending",
      });
      expect(engine.record.failedWritesByNodeId.size).toBe(0);
      expect(engine.getWriteErrorSnapshot()).toBeNull();
      expect(engine.record.draftHistoryContextByNodeId.get("root")).toBe(
        futureHistory,
      );
      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
      expect(host.discardHistoryEntry).not.toHaveBeenCalledWith(futureHistory);
      await expect(lease.prepare([])).resolves.toMatchObject({
        baselineFlushed: false,
      });
    });

    it("ignores a late rejected baseline after pending drafts are discarded", async () => {
      vi.useFakeTimers();
      const baselineWrite = deferred<NotesWorkspace>();
      const store = repository({
        updateNode: vi.fn().mockReturnValue(baselineWrite.promise),
      });
      const { engine, host } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before discard",
        note: "old note",
        imageOffsetUtf16: 3,
      });
      const oldHistory =
        engine.record.draftHistoryContextByNodeId.get("root");
      const lease = engine.beginBackspaceGesture(26, "root")!;
      await flushMicrotasks();
      expect(store.updateNode).toHaveBeenCalledOnce();

      engine.discardPendingDrafts();
      engine.updateNodeDraft("root", {
        title: "after discard",
        note: "new note",
        imageOffsetUtf16: 6,
        markerKind: "todo",
      });
      const futureHistory =
        engine.record.draftHistoryContextByNodeId.get("root");
      baselineWrite.reject(new Error("late disk failure"));
      await flushMicrotasks();

      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "after discard",
        note: "new note",
        imageOffsetUtf16: 6,
        markerKind: "todo",
        status: "pending",
      });
      expect(engine.record.failedWritesByNodeId.size).toBe(0);
      expect(engine.getWriteErrorSnapshot()).toBeNull();
      expect(engine.record.draftHistoryContextByNodeId.get("root")).toBe(
        futureHistory,
      );
      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
      expect(host.discardHistoryEntry).not.toHaveBeenCalledWith(futureHistory);
      await expect(lease.prepare([])).resolves.toMatchObject({
        baselineFlushed: false,
      });
    });

    it("retires a cancelled baseline owner before discard and late success", async () => {
      vi.useFakeTimers();
      const baselineWrite = deferred<NotesWorkspace>();
      const store = repository({
        updateNode: vi.fn().mockReturnValue(baselineWrite.promise),
      });
      const { engine, host } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before cancel",
        note: "",
        imageOffsetUtf16: 0,
      });
      const oldHistory =
        engine.record.draftHistoryContextByNodeId.get("root")!;
      const lease = engine.beginBackspaceGesture(27, "root")!;
      await flushMicrotasks();

      lease.settle("cancelled");
      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
      engine.discardPendingDrafts();
      engine.updateNodeDraft("root", {
        title: "after discard",
        note: "later",
        imageOffsetUtf16: 2,
      });
      const laterHistory =
        engine.record.draftHistoryContextByNodeId.get("root")!;
      baselineWrite.resolve(
        workspace([node({ id: "root", title: "before cancel" })]),
      );
      await flushMicrotasks();

      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
      expect(host.discardHistoryEntry).not.toHaveBeenCalledWith(laterHistory);
      expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
        oldHistory.entryId,
      );
      expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
        laterHistory.entryId,
      );
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "after discard",
        note: "later",
        status: "pending",
      });
      expect(engine.record.backspaceHistoryOwnersByAttemptId.size).toBe(0);
      expect(store.updateNode).toHaveBeenCalledOnce();
    });

    it("retires a failed baseline owner before reset and late failure", async () => {
      vi.useFakeTimers();
      const baselineWrite = deferred<NotesWorkspace>();
      const store = repository({
        updateNode: vi.fn().mockReturnValue(baselineWrite.promise),
      });
      const { engine, host } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before failure",
        note: "",
        imageOffsetUtf16: 0,
      });
      const oldHistory =
        engine.record.draftHistoryContextByNodeId.get("root")!;
      const lease = engine.beginBackspaceGesture(28, "root")!;
      await flushMicrotasks();

      lease.settle("failed");
      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
      engine.resetAfterDataDeletion();
      engine.updateNodeDraft("root", {
        title: "after reset",
        note: "later",
        imageOffsetUtf16: 3,
      });
      const laterHistory =
        engine.record.draftHistoryContextByNodeId.get("root")!;
      baselineWrite.reject(new Error("late disk failure"));
      await flushMicrotasks();

      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
      expect(host.discardHistoryEntry).not.toHaveBeenCalledWith(laterHistory);
      expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
        oldHistory.entryId,
      );
      expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
        laterHistory.entryId,
      );
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "after reset",
        note: "later",
        status: "pending",
      });
      expect(engine.getWriteErrorSnapshot()).toBeNull();
      expect(engine.record.backspaceHistoryOwnersByAttemptId.size).toBe(0);
      expect(store.updateNode).toHaveBeenCalledOnce();
    });

    it("retires a cancelled baseline owner before readonly and late success", async () => {
      vi.useFakeTimers();
      const baselineWrite = deferred<NotesWorkspace>();
      const store = repository({
        updateNode: vi.fn().mockReturnValue(baselineWrite.promise),
      });
      const { engine, host } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before readonly",
        note: "",
        imageOffsetUtf16: 0,
      });
      const oldHistory =
        engine.record.draftHistoryContextByNodeId.get("root")!;
      const lease = engine.beginBackspaceGesture(29, "root")!;
      await flushMicrotasks();

      lease.settle("cancelled");
      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
      engine.reconcileReadonlyAuthority(
        workspace([node({ id: "root", isReadonly: true })]),
      );
      engine.updateNodeDraft("root", {
        title: "after readonly",
        note: "later",
        imageOffsetUtf16: 4,
      });
      const laterHistory =
        engine.record.draftHistoryContextByNodeId.get("root")!;
      baselineWrite.resolve(
        workspace([node({ id: "root", title: "before readonly" })]),
      );
      await flushMicrotasks();

      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
      expect(host.discardHistoryEntry).not.toHaveBeenCalledWith(laterHistory);
      expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
        oldHistory.entryId,
      );
      expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
        laterHistory.entryId,
      );
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "after readonly",
        note: "later",
        status: "pending",
      });
      expect(engine.record.backspaceHistoryOwnersByAttemptId.size).toBe(0);
      expect(store.updateNode).toHaveBeenCalledOnce();
    });

    it.each(["discard", "reset", "readonly"] as const)(
      "terminates a retired late failure after cancel then %s",
      async (invalidation) => {
        vi.useFakeTimers();
        const baselineWrite = deferred<NotesWorkspace>();
        const store = repository({
          updateNode: vi.fn().mockReturnValue(baselineWrite.promise),
        });
        const { engine, host } = createHarness({ store });
        engine.updateNodeDraft("root", {
          title: `before ${invalidation}`,
          note: "",
          imageOffsetUtf16: 0,
        });
        const oldHistory =
          engine.record.draftHistoryContextByNodeId.get("root")!;
        const lease = engine.beginBackspaceGesture(30, "root")!;
        await flushMicrotasks();

        lease.settle("cancelled");
        if (invalidation === "discard") {
          engine.discardPendingDrafts();
        } else if (invalidation === "reset") {
          engine.resetAfterDataDeletion();
        } else {
          engine.reconcileReadonlyAuthority(
            workspace([node({ id: "root", isReadonly: true })]),
          );
        }
        engine.updateNodeDraft("root", {
          title: `after ${invalidation}`,
          note: "later",
          imageOffsetUtf16: 5,
        });
        const laterHistory =
          engine.record.draftHistoryContextByNodeId.get("root")!;
        engine.pauseForAuthorityRecovery();
        baselineWrite.reject(new Error("late disk failure"));
        await engine.record.writeQueue.flush();

        expect(engine.getDraftsSnapshot().root).toMatchObject({
          title: `after ${invalidation}`,
          note: "later",
          imageOffsetUtf16: 5,
          status: "pending",
        });
        expect(engine.record.failedWritesByNodeId.size).toBe(0);
        expect(engine.getWriteErrorSnapshot()).toBeNull();
        expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
        expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
        expect(host.discardHistoryEntry).not.toHaveBeenCalledWith(laterHistory);
        expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
          oldHistory.entryId,
        );
        expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
          laterHistory.entryId,
        );
        expect(engine.record.backspaceHistoryOwnersByAttemptId.size).toBe(0);
        expect(store.updateNode).toHaveBeenCalledOnce();
      },
    );

    it("removes an owner when preflight finishes before cancellation", async () => {
      vi.useFakeTimers();
      const store = repository();
      const { engine, host } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before preflight",
        note: "",
        imageOffsetUtf16: 0,
      });
      const attempt = engine.record.retryWriteByNodeId.get("root")!;
      engine.record.manualRetryAttemptIds.add(attempt.attemptId);
      const oldHistory =
        engine.record.draftHistoryContextByNodeId.get("root")!;
      const lease = engine.beginBackspaceGesture(31, "root")!;

      await expect(lease.prepare([])).resolves.toMatchObject({
        baselineFlushed: false,
      });
      engine.pauseForAuthorityRecovery();
      lease.settle("cancelled");
      engine.updateNodeDraft("root", {
        title: "after preflight",
        note: "later",
        imageOffsetUtf16: 6,
      });
      const laterHistory =
        engine.record.draftHistoryContextByNodeId.get("root")!;

      expect(engine.record.backspaceHistoryOwnersByAttemptId.size).toBe(0);
      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
      expect(host.discardHistoryEntry).not.toHaveBeenCalledWith(laterHistory);
      expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
        oldHistory.entryId,
      );
      expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
        laterHistory.entryId,
      );
      expect(store.updateNode).not.toHaveBeenCalled();
    });

    it("removes an owner when an unknown outcome finishes before failure settlement", async () => {
      vi.useFakeTimers();
      const store = repository();
      const { engine, host } = createHarness({ store });
      vi.spyOn(host, "persistDraftMutation").mockRejectedValueOnce(
        new Error("unknown outcome"),
      );
      engine.updateNodeDraft("root", {
        title: "before unknown",
        note: "",
        imageOffsetUtf16: 0,
      });
      const oldHistory =
        engine.record.draftHistoryContextByNodeId.get("root")!;
      const lease = engine.beginBackspaceGesture(32, "root")!;

      await expect(lease.prepare([])).resolves.toMatchObject({
        baselineFlushed: false,
      });
      engine.pauseForAuthorityRecovery();
      lease.settle("failed");
      engine.updateNodeDraft("root", {
        title: "after unknown",
        note: "later",
        imageOffsetUtf16: 7,
      });
      const laterHistory =
        engine.record.draftHistoryContextByNodeId.get("root")!;

      expect(engine.record.backspaceHistoryOwnersByAttemptId.size).toBe(0);
      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(oldHistory);
      expect(host.discardHistoryEntry).not.toHaveBeenCalledWith(laterHistory);
      expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
        oldHistory.entryId,
      );
      expect(host.completeHistoryOwner).not.toHaveBeenCalledWith(
        laterHistory.entryId,
      );
      expect(store.updateNode).not.toHaveBeenCalled();
    });

    it("invalidates a lease before readonly authority retires its draft", async () => {
      vi.useFakeTimers();
      const baselineWrite = deferred<NotesWorkspace>();
      const store = repository({
        updateNode: vi.fn().mockReturnValue(baselineWrite.promise),
      });
      const { engine, host } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "before",
        note: "",
        imageOffsetUtf16: 0,
      });
      const baselineHistory =
        engine.record.draftHistoryContextByNodeId.get("root");
      const lease = engine.beginBackspaceGesture(20, "root")!;
      engine.updateNodeDraft("root", {
        title: "held",
        note: "",
        imageOffsetUtf16: 0,
      });
      await flushMicrotasks();

      engine.reconcileReadonlyAuthority(
        workspace([node({ id: "root", isReadonly: true })]),
      );
      lease.settle("cancelled");
      baselineWrite.resolve(
        workspace([node({ id: "root", isReadonly: true })]),
      );
      await flushMicrotasks();

      expect(engine.getDraftsSnapshot()).toEqual({});
      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();
      expect(host.discardHistoryEntry).toHaveBeenCalledWith(baselineHistory);
      await expect(lease.prepare([])).resolves.toMatchObject({
        baselineFlushed: false,
      });
    });

    it("freezes touched-node membership when preparation starts", async () => {
      vi.useFakeTimers();
      const confirmedWorkspace = workspace([
        node({ id: "root" }),
        node({ id: "other" }),
      ]);
      const baselineWrite = deferred<NotesWorkspace>();
      const store = repository({
        updateNode: vi.fn().mockReturnValue(baselineWrite.promise),
      });
      const { engine } = createHarness({ store, confirmedWorkspace });
      engine.updateNodeDraft("root", {
        title: "before",
        note: "",
        imageOffsetUtf16: 0,
      });
      const lease = engine.beginBackspaceGesture(21, "root")!;
      engine.updateNodeDraft("root", {
        title: "root held",
        note: "",
        imageOffsetUtf16: 0,
      });
      await flushMicrotasks();
      const preparation = lease.prepare([]);

      lease.touch("other");
      engine.updateNodeDraft("other", {
        title: "late other",
        note: "",
        imageOffsetUtf16: 0,
      });
      baselineWrite.resolve(
        workspace([node({ id: "root", title: "before" }), node({ id: "other" })]),
      );

      await expect(preparation).resolves.toEqual({
        baselineFlushed: true,
        titleUpdate: { id: "root", title: "root held" },
      });
    });

    it("closes the prior text burst before the first gesture-owned revision", () => {
      vi.useFakeTimers();
      const { engine, host, session } = createHarness();
      engine.updateNodeDraft("root", {
        title: "before",
        note: "",
        imageOffsetUtf16: 0,
      });
      const beginTextEntry = vi.mocked(host.beginTextEntry);
      expect(beginTextEntry).toHaveBeenCalledOnce();

      engine.beginBackspaceGesture(22, "root");
      engine.updateNodeDraft("root", {
        title: "after",
        note: "",
        imageOffsetUtf16: 0,
      });

      const closeTextBurst = vi.mocked(session.history.closeTextBurst);
      const setDraftEditingNavigation = vi.mocked(
        host.setDraftEditingNavigation,
      );
      expect(closeTextBurst).toHaveBeenCalledWith("entry-1");
      expect(beginTextEntry).toHaveBeenCalledOnce();
      expect(closeTextBurst.mock.invocationCallOrder[0]).toBeLessThan(
        setDraftEditingNavigation.mock.invocationCallOrder[1]!,
      );
    });
  });

  describe("debounced persistence", () => {
    it("coalesces rapid drafts and writes the latest patch after 300 ms", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(
            workspace([
              node({ id: "root", title: input.title, note: input.note }),
            ]),
          ),
        ),
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", {
        title: "first draft",
        note: "",
        imageOffsetUtf16: 0,
      });
      engine.updateNodeDraft("root", {
        title: "latest draft",
        note: "latest note",
        imageOffsetUtf16: 0,
      });

      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "latest draft",
        note: "latest note",
      });
      await vi.advanceTimersByTimeAsync(299);
      expect(store.updateNode).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(store.updateNode).toHaveBeenCalledOnce();
      expect(store.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "root",
          title: "latest draft",
          note: "latest note",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        textHistoryContext,
      );
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("persists a title edit and To-do marker in one draft write", async () => {
      vi.useFakeTimers();
      const store = repository();
      const { engine } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "Task",
        note: "",
        imageOffsetUtf16: 0,
        markerKind: "todo",
      });

      await vi.advanceTimersByTimeAsync(300);

      expect(store.updateNode).toHaveBeenCalledOnce();
      expect(store.updateNode).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({
          id: "root",
          title: "Task",
          markerKind: "todo",
        }),
        textHistoryContext,
      );
    });

    it("forces a write at the max-latency ceiling under continuous typing", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(
            workspace([node({ id: "root", title: input.title })]),
          ),
        ),
      });
      const { engine } = createHarness({ store });

      // Type every 250 ms so the 300 ms debounce timer is re-armed and never
      // fires on its own; only the 2000 ms hard ceiling can force the write.
      const step = 250;
      const steps = Math.ceil(MAX_DEBOUNCE_LATENCY_MS / step);
      for (let index = 0; index < steps; index += 1) {
        engine.updateNodeDraft("root", {
          title: `edit ${index}`,
          note: "",
          imageOffsetUtf16: 0,
        });
        await vi.advanceTimersByTimeAsync(step);
      }

      // The ceiling fired mid-typing even though we never paused for a full
      // debounce interval.
      expect(store.updateNode).toHaveBeenCalled();
      const elapsedAtFirstWrite = step * steps;
      expect(elapsedAtFirstWrite).toBeGreaterThanOrEqual(
        MAX_DEBOUNCE_LATENCY_MS,
      );
    });

    it("does not force a write before the ceiling while typing continuously", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(
            workspace([node({ id: "root", title: input.title })]),
          ),
        ),
      });
      const { engine } = createHarness({ store });

      for (let index = 0; index < 6; index += 1) {
        engine.updateNodeDraft("root", {
          title: `edit ${index}`,
          note: "",
          imageOffsetUtf16: 0,
        });
        await vi.advanceTimersByTimeAsync(250);
      }
      // 1500 ms of continuous 250 ms edits stays under the 2000 ms ceiling.
      expect(store.updateNode).not.toHaveBeenCalled();
    });

    it("pauses draft timers during authority recovery and resumes retained drafts", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(
            workspace([node({ id: "root", title: input.title })]),
          ),
        ),
      });
      const { engine } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "retained",
        note: "",
        imageOffsetUtf16: 0,
      });

      engine.pauseForAuthorityRecovery();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(store.updateNode).not.toHaveBeenCalled();
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "retained",
      });

      engine.resumeAfterAuthorityRecovery();
      await vi.advanceTimersByTimeAsync(300);

      expect(store.updateNode).toHaveBeenCalledOnce();
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("keeps an uncertain dispatched draft for manual retry and fails its structural barrier", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(
            workspace([node({ id: "root", title: input.title })]),
          ),
        ),
      });
      const { engine } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "uncertain",
        note: "",
        imageOffsetUtf16: 0,
      });
      const attempt = engine.record.retryWriteByNodeId.get("root")!;
      const cutoff = engine.captureDraftCutoff({
        kind: "keyboard-draft",
        intentToken: 41,
      });

      engine.pauseForAuthorityRecovery();
      engine.markDispatchedAttemptManualRetry(attempt.attemptId);
      engine.resumeAfterAuthorityRecovery();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(store.updateNode).not.toHaveBeenCalled();
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "uncertain",
        status: "failed",
      });
      await expect(engine.flushDraftBarrier(cutoff)).resolves.toBe(false);
      expect(store.updateNode).not.toHaveBeenCalled();

      await engine.retryFailedDraft("root");

      expect(store.updateNode).toHaveBeenCalledOnce();
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("retires a pending draft when synchronized authority makes the node readonly", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn().mockResolvedValue(workspace([])),
      });
      const { engine, host } = createHarness({ store });

      engine.updateNodeDraft("root", {
        title: "stale local draft",
        note: "must not persist",
        imageOffsetUtf16: 0,
      });

      engine.reconcileReadonlyAuthority(
        workspace([
          node({
            id: "root",
            title: "remote authority",
            isReadonly: true,
          }),
        ]),
      );

      expect(engine.getDraftsSnapshot()).toEqual({});
      expect(engine.getWriteErrorSnapshot()).toBeNull();
      expect(host.discardHistoryEntry).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(300);
      expect(store.updateNode).not.toHaveBeenCalled();
    });
  });

  describe("write-failure ledger", () => {
    it("populates the ledger and surfaces writeError when a write fails", async () => {
      const store = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full")),
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", {
        title: "unsaved",
        note: "",
        imageOffsetUtf16: 0,
      });
      const flushed = await engine.flushNodeDraft("root");

      expect(flushed).toBe(false);
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "unsaved",
        status: "failed",
      });
      expect(engine.getWriteErrorSnapshot()).toMatchObject({
        operation: "write",
        retryable: true,
        message: "disk full",
      });
    });

    it("clears the ledger and draft when a retry succeeds with a fresh history entry", async () => {
      const saved = workspace([node({ id: "root", title: "saved on retry" })]);
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(saved),
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", {
        title: "saved on retry",
        note: "",
        imageOffsetUtf16: 6,
      });
      expect(await engine.flushNodeDraft("root")).toBe(false);
      expect(engine.getWriteErrorSnapshot()).not.toBeNull();

      await engine.retryFailedDraft("root");

      expect(store.updateNode).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(store.updateNode).mock.calls;
      expect(calls[1]?.[2]?.entryId).not.toBe(calls[0]?.[2]?.entryId);
      expect(calls[1]).toEqual([
        "/vault",
        {
          id: "root",
          title: "saved on retry",
          note: "",
          imageOffsetUtf16: 6,
          markerKind: "bullet",
        },
        textHistoryContext,
      ]);
      expect(engine.getDraftsSnapshot()).toEqual({});
      expect(engine.getWriteErrorSnapshot()).toBeNull();
    });

    it("retries the last failed write across the ledger", async () => {
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(
            workspace([node({ id: "root", title: "ok" })]),
          ),
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", {
        title: "ok",
        note: "",
        imageOffsetUtf16: 0,
      });
      expect(await engine.flushNodeDraft("root")).toBe(false);

      await engine.retryLastFailedWrite();

      expect(store.updateNode).toHaveBeenCalledTimes(2);
      expect(engine.getDraftsSnapshot()).toEqual({});
      expect(engine.getWriteErrorSnapshot()).toBeNull();
    });
  });

  describe("flush outcomes", () => {
    it.each(["node", "all", "barrier"] as const)(
      "starts a text-only %s flush in the calling turn",
      async (kind) => {
        const store = repository({
          updateNode: vi.fn((_vaultRoot, input) =>
            Promise.resolve(
              workspace([node({ id: "root", title: input.title })]),
            ),
          ),
        });
        const { engine, session } = createHarness({ store });
        const enqueue = vi.spyOn(session, "enqueue");
        engine.updateNodeDraft("root", {
          title: "same-turn",
          note: "",
          imageOffsetUtf16: 0,
        });

        const completion =
          kind === "node"
            ? engine.flushNodeDraft("root")
            : kind === "all"
              ? engine.flushAllDrafts()
              : engine.flushDraftBarrier(engine.captureDraftCutoff());

        expect(enqueue).toHaveBeenCalledOnce();
        await expect(completion).resolves.toBe(true);
        expect(store.updateNode).toHaveBeenCalledOnce();
      },
    );

    it("publishes an Enter-owned draft with its explicit insertion token", async () => {
      const { engine, session } = createHarness();
      const enqueue = vi.spyOn(session, "enqueue");
      const publicationOwner = {
        kind: "keyboard-draft" as const,
        intentToken: 17,
      };
      engine.updateNodeDraft("root", {
        title: "dirty before split",
        note: "",
        imageOffsetUtf16: 0,
      });

      const cutoff = engine.captureDraftCutoff(publicationOwner);
      await expect(engine.flushDraftBarrier(cutoff)).resolves.toBe(true);

      expect(enqueue).toHaveBeenCalledWith(expect.any(Function), {
        silent: true,
        publicationOwner,
        unknownOutcomeExpectation: {
          kind: "draft",
          nodeId: "root",
          expectedText: {
            title: "dirty before split",
            note: "",
            imageOffsetUtf16: 0,
          },
          historyContext: {
            sessionId: "session-0",
            historyEpoch: "epoch-a",
            entryId: "entry-1",
            commandKind: "text",
          },
        },
      });
    });

    it("does not delay a node flush for an adapter registered to another node", async () => {
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(
            workspace([node({ id: "root", title: input.title })]),
          ),
        ),
      });
      const { engine, session } = createHarness({ store });
      const enqueue = vi.spyOn(session, "enqueue");
      const otherFlush = vi.fn().mockResolvedValue("flushed" as const);
      engine.registerImageAtomFlushAdapter({
        nodeId: "other",
        flush: otherFlush,
      });
      engine.updateNodeDraft("root", {
        title: "same-turn",
        note: "",
        imageOffsetUtf16: 0,
      });

      const completion = engine.flushNodeDraft("root");

      expect(enqueue).toHaveBeenCalledOnce();
      expect(otherFlush).not.toHaveBeenCalled();
      await expect(completion).resolves.toBe(true);
      expect(store.updateNode).toHaveBeenCalledOnce();
    });

    it("flushes a registered image editor before reserving its draft write", async () => {
      const order: string[] = [];
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) => {
          order.push(`write:${input.title}`);
          return Promise.resolve(
            workspace([
              node({
                id: "root",
                title: input.title,
                imageOffsetUtf16: input.imageOffsetUtf16,
              }),
            ]),
          );
        }),
      });
      const { engine } = createHarness({ store });
      const adapter: NotesImageAtomFlushAdapter = {
        nodeId: "root",
        flush: async () => {
          order.push("adapter");
          engine.updateNodeDraft("root", {
            title: "beforeafter",
            note: "",
            imageOffsetUtf16: 6,
          });
          return "flushed";
        },
      };
      engine.registerImageAtomFlushAdapter(adapter);

      await expect(engine.flushNodeDraft("root")).resolves.toBe(true);
      expect(order).toEqual(["adapter", "write:beforeafter"]);
      expect(store.updateNode).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({ imageOffsetUtf16: 6 }),
        textHistoryContext,
      );
    });

    it("flushes only the image editor for the requested node", async () => {
      const { engine } = createHarness();
      const root = {
        nodeId: "root",
        flush: vi.fn().mockResolvedValue("flushed" as const),
      };
      const other = {
        nodeId: "other",
        flush: vi.fn().mockResolvedValue("flushed" as const),
      };
      engine.registerImageAtomFlushAdapter(root);
      engine.registerImageAtomFlushAdapter(other);

      await expect(engine.flushNodeDraft("root")).resolves.toBe(true);

      expect(root.flush).toHaveBeenCalledOnce();
      expect(other.flush).not.toHaveBeenCalled();
    });

    it("waits for a deferred editor before completing an all-drafts barrier", async () => {
      const deferredFlush = deferred<"deferred" | "cancelled">();
      const { engine } = createHarness();
      engine.registerImageAtomFlushAdapter({
        nodeId: "root",
        flush: () => deferredFlush.promise,
      });

      let settled = false;
      const completion = engine.flushAllDrafts().then((value) => {
        settled = true;
        return value;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      deferredFlush.resolve("deferred");

      await expect(completion).resolves.toBe(true);
    });

    it("includes a composition-end draft created after structural cutoff capture", async () => {
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(
            workspace([
              node({
                id: "root",
                title: input.title,
                imageOffsetUtf16: input.imageOffsetUtf16,
              }),
            ]),
          ),
        ),
      });
      const { engine } = createHarness({ store });
      engine.registerImageAtomFlushAdapter({
        nodeId: "root",
        flush: async () => {
          engine.updateNodeDraft("root", {
            title: "composedafter",
            note: "",
            imageOffsetUtf16: 8,
          });
          return "deferred";
        },
      });
      const cutoff = engine.captureDraftCutoff();

      await expect(engine.flushDraftBarrier(cutoff)).resolves.toBe(true);
      expect(store.updateNode).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({
          title: "composedafter",
          imageOffsetUtf16: 8,
        }),
        textHistoryContext,
      );
    });

    it("fails closed and reports an interrupted composition", async () => {
      const { engine, host } = createHarness();
      const report = vi.fn();
      host.onCompositionInterrupted = report;
      engine.registerImageAtomFlushAdapter({
        nodeId: "root",
        flush: async () => "cancelled",
      });

      await expect(engine.flushNodeDraft("root")).resolves.toBe(false);
      expect(report).toHaveBeenCalledOnce();
    });

    it("returns true after flushing a draft that persists successfully", async () => {
      const store = repository({
        updateNode: vi
          .fn()
          .mockResolvedValue(workspace([node({ id: "root", title: "saved" })])),
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", {
        title: "saved",
        note: "",
        imageOffsetUtf16: 0,
      });
      const flushed = await engine.flushNodeDraft("root");

      expect(flushed).toBe(true);
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("returns false when flushing retains a failed draft", async () => {
      const store = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full")),
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", {
        title: "not saved",
        note: "",
        imageOffsetUtf16: 0,
      });
      const flushed = await engine.flushNodeDraft("root");

      expect(flushed).toBe(false);
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "not saved",
        status: "failed",
      });
    });

    it("returns true when a second flush retries and saves a retained draft", async () => {
      const saved = workspace([node({ id: "root", title: "saved on retry" })]);
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(saved),
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", {
        title: "saved on retry",
        note: "",
        imageOffsetUtf16: 0,
      });
      const firstFlush = await engine.flushNodeDraft("root");
      const retryFlush = await engine.flushNodeDraft("root");

      expect(firstFlush).toBe(false);
      expect(retryFlush).toBe(true);
      expect(store.updateNode).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(store.updateNode).mock.calls;
      expect(calls[1]?.[2]?.entryId).not.toBe(calls[0]?.[2]?.entryId);
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("returns false when the session changes before a flush completes", async () => {
      const write = deferred<NotesWorkspace>();
      const store = repository({
        updateNode: vi.fn().mockReturnValue(write.promise),
      });
      const harness = createHarness({ store });
      const { engine } = harness;

      engine.updateNodeDraft("root", {
        title: "old vault draft",
        note: "",
        imageOffsetUtf16: 0,
      });
      const flush = engine.flushNodeDraft("root");
      await flushMicrotasks();
      expect(store.updateNode).toHaveBeenCalledOnce();

      // The hook would have swapped in a new vault session here; point the
      // active session elsewhere so the engine reads as no-longer-current.
      const otherStore = repository();
      const other = createSession({
        store: otherStore,
        vaultRoot: "/new",
        confirmedWorkspace: workspace([node({ id: "new-root" })]),
      });
      harness.activate(engine, other.session);
      write.resolve(
        workspace([node({ id: "root", title: "old vault draft" })]),
      );

      await expect(flush).resolves.toBe(false);
    });
  });

  describe("shutdown", () => {
    it("flushes an active image editor before starting shutdown persistence", async () => {
      const order: string[] = [];
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) => {
          order.push(`write:${input.title}`);
          return Promise.resolve(
            workspace([
              node({
                id: "root",
                title: input.title,
                imageOffsetUtf16: input.imageOffsetUtf16,
              }),
            ]),
          );
        }),
      });
      const { engine } = createHarness({ store });
      engine.registerImageAtomFlushAdapter({
        nodeId: "root",
        flush: async () => {
          order.push("adapter");
          engine.updateNodeDraft("root", {
            title: "beforeafter",
            note: "support",
            imageOffsetUtf16: 6,
          });
          return "flushed";
        },
      });

      await engine.beginShutdown();

      expect(order).toEqual(["adapter", "write:beforeafter"]);
    });

    it("retries a retained failed draft before closing its session", async () => {
      const saved = workspace([
        node({ id: "root", title: "saved on unmount" }),
      ]);
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(saved),
      });
      const { engine, close } = createHarness({ store });

      engine.updateNodeDraft("root", {
        title: "saved on unmount",
        note: "",
        imageOffsetUtf16: 0,
      });
      expect(await engine.flushNodeDraft("root")).toBe(false);
      expect(engine.getWriteErrorSnapshot()).toMatchObject({
        message: "disk full",
      });

      await engine.beginShutdown();

      expect(store.updateNode).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(store.updateNode).mock.calls;
      expect(calls[1]).toEqual([
        "/vault",
        {
          id: "root",
          title: "saved on unmount",
          note: "",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        textHistoryContext,
      ]);
      expect(close).toHaveBeenCalled();
    });

    it("closes immediately when there are no drafts to flush", async () => {
      const { engine, close } = createHarness();
      await engine.beginShutdown();
      expect(close).toHaveBeenCalledOnce();
    });
  });

  describe("shutdown recovery handoff", () => {
    it("hands a failed shutdown draft to the next engine on the same vault", async () => {
      const sharedRepository = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("old vault disk full"))
          .mockRejectedValueOnce(new Error("old vault disk full"))
          .mockResolvedValueOnce(
            workspace([node({ id: "root", title: "Recovered draft" })]),
          ),
      });
      const entryIds = { next: 1 };

      // First engine: the draft write fails, and the shutdown retry fails too,
      // so shutdown finishes with the draft stranded in the recovery registry.
      const first = createHarness({
        store: sharedRepository,
        vaultRoot: "/shared",
        entryIds,
      });
      first.engine.updateNodeDraft("root", {
        title: "Recovered draft",
        note: "",
        imageOffsetUtf16: 0,
      });
      expect(await first.engine.flushNodeDraft("root")).toBe(false);
      first.deactivate();
      await first.engine.beginShutdown();

      // Second engine on the SAME repository + vault adopts the stranded draft
      // through the module-level recovery registry (StrictMode remount handoff).
      const second = createHarness({
        store: sharedRepository,
        vaultRoot: "/shared",
        entryIds,
      });
      // Recovery correctness must not depend on a remounted engine happening
      // to reuse the failed engine's local attempt counter.
      second.engine.record.nextDraftAttemptId = 99;
      await flushMicrotasks();

      expect(second.engine.getDraftsSnapshot().root).toMatchObject({
        title: "Recovered draft",
        status: "failed",
      });
      expect(second.engine.getWriteErrorSnapshot()).toMatchObject({
        operation: "write",
        retryable: true,
        message: "old vault disk full",
      });

      await second.engine.retryFailedDraft("root");
      expect(second.engine.getDraftsSnapshot()).toEqual({});
      expect(second.engine.getWriteErrorSnapshot()).toBeNull();
    });

    it("isolates recovery by repository object for the same vault path", async () => {
      const firstStore = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("first store failed")),
      });
      const first = createHarness({ store: firstStore, vaultRoot: "/shared" });
      first.engine.updateNodeDraft("root", {
        title: "First store draft",
        note: "",
        imageOffsetUtf16: 0,
      });
      expect(await first.engine.flushNodeDraft("root")).toBe(false);
      first.deactivate();
      await first.engine.beginShutdown();

      // A different repository object, same vault path: the WeakMap is keyed by
      // the repository, so the second engine must not resurrect the draft.
      const secondStore = repository();
      const second = createHarness({
        store: secondStore,
        vaultRoot: "/shared",
      });
      await flushMicrotasks();

      expect(second.engine.getDraftsSnapshot()).toEqual({});
      expect(second.engine.getWriteErrorSnapshot()).toBeNull();
    });

    it("does not resurrect the draft after data deletion clears recovery", async () => {
      const sharedRepository = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full")),
      });
      const first = createHarness({
        store: sharedRepository,
        vaultRoot: "/shared",
      });
      first.engine.updateNodeDraft("root", {
        title: "doomed",
        note: "",
        imageOffsetUtf16: 0,
      });
      expect(await first.engine.flushNodeDraft("root")).toBe(false);
      // Data deletion wipes drafts and the recovery entry.
      first.engine.resetAfterDataDeletion();
      first.deactivate();
      await first.engine.beginShutdown();

      const second = createHarness({
        store: sharedRepository,
        vaultRoot: "/shared",
      });
      await flushMicrotasks();
      expect(second.engine.getDraftsSnapshot()).toEqual({});
    });
  });

  describe("subscription granularity", () => {
    it("notifies drafts subscribers on a keystroke without touching write-error subscribers", () => {
      const { engine, counts } = createHarness();

      const draftsBefore = counts.drafts;
      const writeErrorBefore = counts.writeError;
      engine.updateNodeDraft("root", {
        title: "typed",
        note: "",
        imageOffsetUtf16: 0,
      });

      expect(counts.drafts).toBeGreaterThan(draftsBefore);
      expect(counts.writeError).toBe(writeErrorBefore);
    });

    it("notifies write-error subscribers only when the surfaced error changes", async () => {
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(
            workspace([node({ id: "root", title: "ok" })]),
          ),
      });
      const { engine, counts } = createHarness({ store });

      engine.updateNodeDraft("root", {
        title: "ok",
        note: "",
        imageOffsetUtf16: 0,
      });
      const writeErrorAfterKeystroke = counts.writeError;

      // A failing write flips writeError null -> error: one notification.
      expect(await engine.flushNodeDraft("root")).toBe(false);
      expect(counts.writeError).toBe(writeErrorAfterKeystroke + 1);

      // A successful retry flips writeError error -> null: one more.
      const writeErrorAfterFailure = counts.writeError;
      await engine.retryFailedDraft("root");
      expect(counts.writeError).toBe(writeErrorAfterFailure + 1);
    });
  });

  describe("session-currency guards", () => {
    it("ignores draft edits once the engine is no longer the active session", () => {
      const harness = createHarness();
      const { engine, counts } = harness;
      // The hook has swapped to a new session/record; this engine is superseded.
      harness.deactivate();

      const before = counts.drafts;
      engine.updateNodeDraft("root", {
        title: "ignored",
        note: "",
        imageOffsetUtf16: 0,
      });
      expect(counts.drafts).toBe(before);
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("ignores draft edits while the session is closing", () => {
      const { engine, counts } = createHarness();
      engine.record.closing = true;

      const before = counts.drafts;
      engine.updateNodeDraft("root", {
        title: "ignored",
        note: "",
        imageOffsetUtf16: 0,
      });
      expect(counts.drafts).toBe(before);
      expect(engine.getDraftsSnapshot()).toEqual({});
    });
  });
});
