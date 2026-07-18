import { afterEach, describe, expect, it, vi } from "vitest";
import { isNotesMutationResult } from "../../domain/notes";
import type {
  NoteNode,
  NotesStore,
  NotesWorkspace
} from "../../domain/notes";
import {
  createNotesWriteQueue,
  MAX_DEBOUNCE_LATENCY_MS
} from "../../services/notesWriteQueue";
import type {
  NotesWorkspaceCommandOutcome,
  NotesDraftEngineCoordinatorSession,
  NotesWorkspaceQueueContext,
  NotesWorkspaceQueueResult
} from "./notesWorkspaceCoordinator";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import {
  NotesDraftEngine,
  type NotesDraftEngineHost
} from "./notesDraftEngine";

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
    ...overrides
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
    prunedEntryIds: []
  };
  return {
    initialize: vi.fn().mockResolvedValue(initialHistoryState),
    loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
    createNode: empty,
    updateNode: empty,
    splitNode: empty,
    applyImageAtomEdit: vi.fn<NotesStore["applyImageAtomEdit"]>(),
    moveNode: empty,
    applyBatch: empty,
    importSubtree: empty,
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
        historyEpoch
      })
    ),
    ackImageAtomOperation: vi.fn<NotesStore["ackImageAtomOperation"]>(
      async () => undefined
    ),
    clearHistory: vi.fn().mockResolvedValue({
      ...initialHistoryState,
      historyReset: true
    }),
    pruneHistoryEntries: vi.fn().mockResolvedValue(initialHistoryState),
    prepareNavigation: vi.fn().mockResolvedValue(initialHistoryState),
    closeHistorySession: vi.fn().mockResolvedValue(undefined),
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi.fn().mockResolvedValue({ attachmentCleanupFailed: false }),
    importAttachmentPaths: vi.fn().mockResolvedValue(workspace([])),
    importAttachmentBytes: vi.fn().mockResolvedValue(workspace([])),
    ...overrides
  };
}

const textHistoryContext = expect.objectContaining({
  entryId: expect.stringMatching(/^entry-\d+$/),
  commandKind: "text"
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
  activate(engine: NotesDraftEngine, session: NotesDraftEngineCoordinatorSession): void;
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
    sourceScope: { kind: "active" }
  };
  const runSerialized = (
    work: (context: NotesWorkspaceQueueContext) => unknown
  ): Promise<NotesWorkspaceCommandOutcome> => {
    const run = tail.then(() => work(context));
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run.then(
      () => "committed" as const,
      () => "failed" as const
    );
  };
  const history = {
    closeTextBurst: vi.fn(),
    clearSnapshots: vi.fn()
  } as unknown as NotesDraftEngineCoordinatorSession["history"];
  const session: NotesDraftEngineCoordinatorSession = {
    activation: Promise.resolve(),
    history,
    enqueue: (work) => runSerialized(work),
    enqueueStructural: (work) => runSerialized(work),
    close
  };
  return { session, close };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const store = options.store ?? repository();
  const vaultRoot = options.vaultRoot ?? "/vault";
  const confirmedWorkspace =
    options.confirmedWorkspace ?? workspace([node({ id: "root" })]);
  const entryIds = options.entryIds ?? { next: 1 };
  const { session, close } = createSession({ store, vaultRoot, confirmedWorkspace });

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
    commandKind: "text" as const
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
      attempt
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
            imageOffsetUtf16: 0
          },
          historyContext
        );
        return {
          kind: "authoritative",
          workspace: isNotesMutationResult(response)
            ? response.workspace
            : response
        };
      } catch (cause) {
        return {
          kind: "failure",
          error: cause instanceof Error ? cause.message : String(cause)
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
    }
  };

  const engine = new NotesDraftEngine({
    repository: store,
    vaultRoot,
    session,
    writeQueue: createNotesWriteQueue(),
    host
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
    }
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
  describe("debounced persistence", () => {
    it("coalesces rapid drafts and writes the latest patch after 300 ms", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(
            workspace([node({ id: "root", title: input.title, note: input.note })])
          )
        )
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "first draft", note: "" });
      engine.updateNodeDraft("root", {
        title: "latest draft",
        note: "latest note"
      });

      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "latest draft",
        note: "latest note"
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
          imageOffsetUtf16: 0
        },
        textHistoryContext
      );
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("forces a write at the max-latency ceiling under continuous typing", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(workspace([node({ id: "root", title: input.title })]))
        )
      });
      const { engine } = createHarness({ store });

      // Type every 250 ms so the 300 ms debounce timer is re-armed and never
      // fires on its own; only the 2000 ms hard ceiling can force the write.
      const step = 250;
      const steps = Math.ceil(MAX_DEBOUNCE_LATENCY_MS / step);
      for (let index = 0; index < steps; index += 1) {
        engine.updateNodeDraft("root", { title: `edit ${index}`, note: "" });
        await vi.advanceTimersByTimeAsync(step);
      }

      // The ceiling fired mid-typing even though we never paused for a full
      // debounce interval.
      expect(store.updateNode).toHaveBeenCalled();
      const elapsedAtFirstWrite = step * steps;
      expect(elapsedAtFirstWrite).toBeGreaterThanOrEqual(MAX_DEBOUNCE_LATENCY_MS);
    });

    it("does not force a write before the ceiling while typing continuously", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(workspace([node({ id: "root", title: input.title })]))
        )
      });
      const { engine } = createHarness({ store });

      for (let index = 0; index < 6; index += 1) {
        engine.updateNodeDraft("root", { title: `edit ${index}`, note: "" });
        await vi.advanceTimersByTimeAsync(250);
      }
      // 1500 ms of continuous 250 ms edits stays under the 2000 ms ceiling.
      expect(store.updateNode).not.toHaveBeenCalled();
    });
  });

  describe("write-failure ledger", () => {
    it("populates the ledger and surfaces writeError when a write fails", async () => {
      const store = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full"))
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "unsaved", note: "" });
      const flushed = await engine.flushNodeDraft("root");

      expect(flushed).toBe(false);
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "unsaved",
        status: "failed"
      });
      expect(engine.getWriteErrorSnapshot()).toMatchObject({
        operation: "write",
        retryable: true,
        message: "disk full"
      });
    });

    it("clears the ledger and draft when a retry succeeds with a fresh history entry", async () => {
      const saved = workspace([node({ id: "root", title: "saved on retry" })]);
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(saved)
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "saved on retry", note: "" });
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
          imageOffsetUtf16: 0
        },
        textHistoryContext
      ]);
      expect(engine.getDraftsSnapshot()).toEqual({});
      expect(engine.getWriteErrorSnapshot()).toBeNull();
    });

    it("retries the last failed write across the ledger", async () => {
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(workspace([node({ id: "root", title: "ok" })]))
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "ok", note: "" });
      expect(await engine.flushNodeDraft("root")).toBe(false);

      await engine.retryLastFailedWrite();

      expect(store.updateNode).toHaveBeenCalledTimes(2);
      expect(engine.getDraftsSnapshot()).toEqual({});
      expect(engine.getWriteErrorSnapshot()).toBeNull();
    });
  });

  describe("flush outcomes", () => {
    it("returns true after flushing a draft that persists successfully", async () => {
      const store = repository({
        updateNode: vi
          .fn()
          .mockResolvedValue(workspace([node({ id: "root", title: "saved" })]))
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "saved", note: "" });
      const flushed = await engine.flushNodeDraft("root");

      expect(flushed).toBe(true);
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("returns false when flushing retains a failed draft", async () => {
      const store = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full"))
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "not saved", note: "" });
      const flushed = await engine.flushNodeDraft("root");

      expect(flushed).toBe(false);
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "not saved",
        status: "failed"
      });
    });

    it("returns true when a second flush retries and saves a retained draft", async () => {
      const saved = workspace([node({ id: "root", title: "saved on retry" })]);
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(saved)
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "saved on retry", note: "" });
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
        updateNode: vi.fn().mockReturnValue(write.promise)
      });
      const harness = createHarness({ store });
      const { engine } = harness;

      engine.updateNodeDraft("root", { title: "old vault draft", note: "" });
      const flush = engine.flushNodeDraft("root");
      await flushMicrotasks();
      expect(store.updateNode).toHaveBeenCalledOnce();

      // The hook would have swapped in a new vault session here; point the
      // active session elsewhere so the engine reads as no-longer-current.
      const otherStore = repository();
      const other = createSession({
        store: otherStore,
        vaultRoot: "/new",
        confirmedWorkspace: workspace([node({ id: "new-root" })])
      });
      harness.activate(engine, other.session);
      write.resolve(workspace([node({ id: "root", title: "old vault draft" })]));

      await expect(flush).resolves.toBe(false);
    });
  });

  describe("shutdown", () => {
    it("retries a retained failed draft before closing its session", async () => {
      const saved = workspace([node({ id: "root", title: "saved on unmount" })]);
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(saved)
      });
      const { engine, close } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "saved on unmount", note: "" });
      expect(await engine.flushNodeDraft("root")).toBe(false);
      expect(engine.getWriteErrorSnapshot()).toMatchObject({
        message: "disk full"
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
          imageOffsetUtf16: 0
        },
        textHistoryContext
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
            workspace([node({ id: "root", title: "Recovered draft" })])
          )
      });
      const entryIds = { next: 1 };

      // First engine: the draft write fails, and the shutdown retry fails too,
      // so shutdown finishes with the draft stranded in the recovery registry.
      const first = createHarness({
        store: sharedRepository,
        vaultRoot: "/shared",
        entryIds
      });
      first.engine.updateNodeDraft("root", { title: "Recovered draft", note: "" });
      expect(await first.engine.flushNodeDraft("root")).toBe(false);
      first.deactivate();
      await first.engine.beginShutdown();

      // Second engine on the SAME repository + vault adopts the stranded draft
      // through the module-level recovery registry (StrictMode remount handoff).
      const second = createHarness({
        store: sharedRepository,
        vaultRoot: "/shared",
        entryIds
      });
      await flushMicrotasks();

      expect(second.engine.getDraftsSnapshot().root).toMatchObject({
        title: "Recovered draft",
        status: "failed"
      });
      expect(second.engine.getWriteErrorSnapshot()).toMatchObject({
        operation: "write",
        retryable: true,
        message: "old vault disk full"
      });

      await second.engine.retryFailedDraft("root");
      expect(second.engine.getDraftsSnapshot()).toEqual({});
      expect(second.engine.getWriteErrorSnapshot()).toBeNull();
    });

    it("isolates recovery by repository object for the same vault path", async () => {
      const firstStore = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("first store failed"))
      });
      const first = createHarness({ store: firstStore, vaultRoot: "/shared" });
      first.engine.updateNodeDraft("root", { title: "First store draft", note: "" });
      expect(await first.engine.flushNodeDraft("root")).toBe(false);
      first.deactivate();
      await first.engine.beginShutdown();

      // A different repository object, same vault path: the WeakMap is keyed by
      // the repository, so the second engine must not resurrect the draft.
      const secondStore = repository();
      const second = createHarness({ store: secondStore, vaultRoot: "/shared" });
      await flushMicrotasks();

      expect(second.engine.getDraftsSnapshot()).toEqual({});
      expect(second.engine.getWriteErrorSnapshot()).toBeNull();
    });

    it("does not resurrect the draft after data deletion clears recovery", async () => {
      const sharedRepository = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full"))
      });
      const first = createHarness({
        store: sharedRepository,
        vaultRoot: "/shared"
      });
      first.engine.updateNodeDraft("root", { title: "doomed", note: "" });
      expect(await first.engine.flushNodeDraft("root")).toBe(false);
      // Data deletion wipes drafts and the recovery entry.
      first.engine.resetAfterDataDeletion();
      first.deactivate();
      await first.engine.beginShutdown();

      const second = createHarness({
        store: sharedRepository,
        vaultRoot: "/shared"
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
      engine.updateNodeDraft("root", { title: "typed", note: "" });

      expect(counts.drafts).toBeGreaterThan(draftsBefore);
      expect(counts.writeError).toBe(writeErrorBefore);
    });

    it("notifies write-error subscribers only when the surfaced error changes", async () => {
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(workspace([node({ id: "root", title: "ok" })]))
      });
      const { engine, counts } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "ok", note: "" });
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
      engine.updateNodeDraft("root", { title: "ignored", note: "" });
      expect(counts.drafts).toBe(before);
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("ignores draft edits while the session is closing", () => {
      const { engine, counts } = createHarness();
      engine.record.closing = true;

      const before = counts.drafts;
      engine.updateNodeDraft("root", { title: "ignored", note: "" });
      expect(counts.drafts).toBe(before);
      expect(engine.getDraftsSnapshot()).toEqual({});
    });
  });
});
