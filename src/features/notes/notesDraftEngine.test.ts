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
    markdownImageWidth: overrides.markdownImageWidth ?? null
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
            imageOffsetUtf16: draft.imageOffsetUtf16,
            markerKind: draft.markerKind ?? "bullet"
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

      engine.updateNodeDraft("root", { title: "first draft", note: "" , imageOffsetUtf16: 0});
      engine.updateNodeDraft("root", {
        title: "latest draft",
        note: "latest note"
      , imageOffsetUtf16: 0});

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
          imageOffsetUtf16: 0,
          markerKind: "bullet"
        },
        textHistoryContext
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
        markerKind: "todo"
      });

      await vi.advanceTimersByTimeAsync(300);

      expect(store.updateNode).toHaveBeenCalledOnce();
      expect(store.updateNode).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({
          id: "root",
          title: "Task",
          markerKind: "todo"
        }),
        textHistoryContext
      );
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
        engine.updateNodeDraft("root", { title: `edit ${index}`, note: "" , imageOffsetUtf16: 0});
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
        engine.updateNodeDraft("root", { title: `edit ${index}`, note: "" , imageOffsetUtf16: 0});
        await vi.advanceTimersByTimeAsync(250);
      }
      // 1500 ms of continuous 250 ms edits stays under the 2000 ms ceiling.
      expect(store.updateNode).not.toHaveBeenCalled();
    });

    it("pauses draft timers during authority recovery and resumes retained drafts", async () => {
      vi.useFakeTimers();
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(workspace([node({ id: "root", title: input.title })]))
        )
      });
      const { engine } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "retained",
        note: "",
        imageOffsetUtf16: 0
      });

      engine.pauseForAuthorityRecovery();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(store.updateNode).not.toHaveBeenCalled();
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "retained"
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
          Promise.resolve(workspace([node({ id: "root", title: input.title })]))
        )
      });
      const { engine } = createHarness({ store });
      engine.updateNodeDraft("root", {
        title: "uncertain",
        note: "",
        imageOffsetUtf16: 0
      });
      const attempt = engine.record.retryWriteByNodeId.get("root")!;
      const cutoff = engine.captureDraftCutoff({
        kind: "keyboard-draft",
        intentToken: 41
      });

      engine.pauseForAuthorityRecovery();
      engine.markDispatchedAttemptManualRetry(attempt.attemptId);
      engine.resumeAfterAuthorityRecovery();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(store.updateNode).not.toHaveBeenCalled();
      expect(engine.getDraftsSnapshot().root).toMatchObject({
        title: "uncertain",
        status: "failed"
      });
      await expect(engine.flushDraftBarrier(cutoff)).resolves.toBe(false);
      expect(store.updateNode).not.toHaveBeenCalled();

      await engine.retryFailedDraft("root");

      expect(store.updateNode).toHaveBeenCalledOnce();
      expect(engine.getDraftsSnapshot()).toEqual({});
    });
  });

  describe("write-failure ledger", () => {
    it("populates the ledger and surfaces writeError when a write fails", async () => {
      const store = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full"))
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "unsaved", note: "" , imageOffsetUtf16: 0});
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

      engine.updateNodeDraft("root", { title: "saved on retry", note: "" , imageOffsetUtf16: 6});
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
          markerKind: "bullet"
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

      engine.updateNodeDraft("root", { title: "ok", note: "" , imageOffsetUtf16: 0});
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
              workspace([node({ id: "root", title: input.title })])
            )
          )
        });
        const { engine, session } = createHarness({ store });
        const enqueue = vi.spyOn(session, "enqueue");
        engine.updateNodeDraft("root", {
          title: "same-turn",
          note: "",
          imageOffsetUtf16: 0
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
      }
    );

    it("publishes an Enter-owned draft with its explicit insertion token", async () => {
      const { engine, session } = createHarness();
      const enqueue = vi.spyOn(session, "enqueue");
      const publicationOwner = {
        kind: "keyboard-draft" as const,
        intentToken: 17
      };
      engine.updateNodeDraft("root", {
        title: "dirty before split",
        note: "",
        imageOffsetUtf16: 0
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
            imageOffsetUtf16: 0
          },
          historyContext: {
            sessionId: "session-0",
            historyEpoch: "epoch-a",
            entryId: "entry-1",
            commandKind: "text"
          }
        }
      });
    });

    it("does not delay a node flush for an adapter registered to another node", async () => {
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) =>
          Promise.resolve(workspace([node({ id: "root", title: input.title })]))
        )
      });
      const { engine, session } = createHarness({ store });
      const enqueue = vi.spyOn(session, "enqueue");
      const otherFlush = vi.fn().mockResolvedValue("flushed" as const);
      engine.registerImageAtomFlushAdapter({
        nodeId: "other",
        flush: otherFlush
      });
      engine.updateNodeDraft("root", {
        title: "same-turn",
        note: "",
        imageOffsetUtf16: 0
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
          return Promise.resolve(workspace([
            node({ id: "root", title: input.title, imageOffsetUtf16: input.imageOffsetUtf16 })
          ]));
        })
      });
      const { engine } = createHarness({ store });
      const adapter: NotesImageAtomFlushAdapter = {
        nodeId: "root",
        flush: async () => {
          order.push("adapter");
          engine.updateNodeDraft("root", {
            title: "beforeafter",
            note: "",
            imageOffsetUtf16: 6
          });
          return "flushed";
        }
      };
      engine.registerImageAtomFlushAdapter(adapter);

      await expect(engine.flushNodeDraft("root")).resolves.toBe(true);
      expect(order).toEqual(["adapter", "write:beforeafter"]);
      expect(store.updateNode).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({ imageOffsetUtf16: 6 }),
        textHistoryContext
      );
    });

    it("flushes only the image editor for the requested node", async () => {
      const { engine } = createHarness();
      const root = { nodeId: "root", flush: vi.fn().mockResolvedValue("flushed" as const) };
      const other = { nodeId: "other", flush: vi.fn().mockResolvedValue("flushed" as const) };
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
        flush: () => deferredFlush.promise
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
          Promise.resolve(workspace([
            node({ id: "root", title: input.title, imageOffsetUtf16: input.imageOffsetUtf16 })
          ]))
        )
      });
      const { engine } = createHarness({ store });
      engine.registerImageAtomFlushAdapter({
        nodeId: "root",
        flush: async () => {
          engine.updateNodeDraft("root", {
            title: "composedafter",
            note: "",
            imageOffsetUtf16: 8
          });
          return "deferred";
        }
      });
      const cutoff = engine.captureDraftCutoff();

      await expect(engine.flushDraftBarrier(cutoff)).resolves.toBe(true);
      expect(store.updateNode).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({
          title: "composedafter",
          imageOffsetUtf16: 8
        }),
        textHistoryContext
      );
    });

    it("fails closed and reports an interrupted composition", async () => {
      const { engine, host } = createHarness();
      const report = vi.fn();
      host.onCompositionInterrupted = report;
      engine.registerImageAtomFlushAdapter({
        nodeId: "root",
        flush: async () => "cancelled"
      });

      await expect(engine.flushNodeDraft("root")).resolves.toBe(false);
      expect(report).toHaveBeenCalledOnce();
    });

    it("returns true after flushing a draft that persists successfully", async () => {
      const store = repository({
        updateNode: vi
          .fn()
          .mockResolvedValue(workspace([node({ id: "root", title: "saved" })]))
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "saved", note: "" , imageOffsetUtf16: 0});
      const flushed = await engine.flushNodeDraft("root");

      expect(flushed).toBe(true);
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("returns false when flushing retains a failed draft", async () => {
      const store = repository({
        updateNode: vi.fn().mockRejectedValue(new Error("disk full"))
      });
      const { engine } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "not saved", note: "" , imageOffsetUtf16: 0});
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

      engine.updateNodeDraft("root", { title: "saved on retry", note: "" , imageOffsetUtf16: 0});
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

      engine.updateNodeDraft("root", { title: "old vault draft", note: "" , imageOffsetUtf16: 0});
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
    it("flushes an active image editor before starting shutdown persistence", async () => {
      const order: string[] = [];
      const store = repository({
        updateNode: vi.fn((_vaultRoot, input) => {
          order.push(`write:${input.title}`);
          return Promise.resolve(workspace([
            node({
              id: "root",
              title: input.title,
              imageOffsetUtf16: input.imageOffsetUtf16
            })
          ]));
        })
      });
      const { engine } = createHarness({ store });
      engine.registerImageAtomFlushAdapter({
        nodeId: "root",
        flush: async () => {
          order.push("adapter");
          engine.updateNodeDraft("root", {
            title: "beforeafter",
            note: "support",
            imageOffsetUtf16: 6
          });
          return "flushed";
        }
      });

      await engine.beginShutdown();

      expect(order).toEqual(["adapter", "write:beforeafter"]);
    });

    it("retries a retained failed draft before closing its session", async () => {
      const saved = workspace([node({ id: "root", title: "saved on unmount" })]);
      const store = repository({
        updateNode: vi
          .fn()
          .mockRejectedValueOnce(new Error("disk full"))
          .mockResolvedValueOnce(saved)
      });
      const { engine, close } = createHarness({ store });

      engine.updateNodeDraft("root", { title: "saved on unmount", note: "" , imageOffsetUtf16: 0});
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
          imageOffsetUtf16: 0,
          markerKind: "bullet"
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
      first.engine.updateNodeDraft("root", { title: "Recovered draft", note: "" , imageOffsetUtf16: 0});
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
      first.engine.updateNodeDraft("root", { title: "First store draft", note: "" , imageOffsetUtf16: 0});
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
      first.engine.updateNodeDraft("root", { title: "doomed", note: "" , imageOffsetUtf16: 0});
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
      engine.updateNodeDraft("root", { title: "typed", note: "" , imageOffsetUtf16: 0});

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

      engine.updateNodeDraft("root", { title: "ok", note: "" , imageOffsetUtf16: 0});
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
      engine.updateNodeDraft("root", { title: "ignored", note: "" , imageOffsetUtf16: 0});
      expect(counts.drafts).toBe(before);
      expect(engine.getDraftsSnapshot()).toEqual({});
    });

    it("ignores draft edits while the session is closing", () => {
      const { engine, counts } = createHarness();
      engine.record.closing = true;

      const before = counts.drafts;
      engine.updateNodeDraft("root", { title: "ignored", note: "" , imageOffsetUtf16: 0});
      expect(counts.drafts).toBe(before);
      expect(engine.getDraftsSnapshot()).toEqual({});
    });
  });
});
