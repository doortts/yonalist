import { describe, expect, it, vi } from "vitest";
import type { NoteNode, NotesStore, NotesWorkspace } from "../../domain/notes";
import { createNotesWorkspaceCoordinatorRegistry } from "./notesWorkspaceCoordinator";

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
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
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
    createNode: empty,
    updateNode: empty,
    splitNode: empty,
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
    importAttachmentPaths: empty,
    importAttachmentBytes: empty,
    undo: vi.fn().mockResolvedValue({
      workspace: workspace([]),
      replayedEntryId: null,
      canUndo: false,
      canRedo: false
    }),
    redo: vi.fn().mockResolvedValue({
      workspace: workspace([]),
      replayedEntryId: null,
      canUndo: false,
      canRedo: false
    }),
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi.fn().mockResolvedValue({ attachmentCleanupFailed: false }),
    ...overrides
  };
}

describe("notesWorkspaceCoordinator registry", () => {
  it("ignores a failed drain from a participant that departed during the pass", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const drain = deferred<boolean>();
    const departed = registry.openSession({
      repository: store,
      vaultRoot: "/departure",
      onEvent: vi.fn(),
      beforeStructural: () => drain.promise
    });
    const requester = registry.openSession({
      repository: store,
      vaultRoot: "/departure",
      onEvent: vi.fn()
    });
    await Promise.all([departed.activation, requester.activation]);
    const structuralWork = vi.fn(() => ({ kind: "skipped" as const }));

    const completion = requester.enqueueStructural(structuralWork);
    await Promise.resolve();
    departed.close();
    drain.resolve(false);
    await completion;

    expect(structuralWork).toHaveBeenCalledOnce();
    requester.close();
  });

  it("finalizes a departed participant's captured cutoff exactly once", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const drain = deferred<boolean>();
    const activeIntentTokens = new Set<object>();
    const token = {};
    const finalize = vi.fn(() => activeIntentTokens.delete(token));
    const departed = registry.openSession({
      repository: store,
      vaultRoot: "/departure-cleanup",
      onEvent: vi.fn(),
      captureDraftCutoff: () => {
        activeIntentTokens.add(token);
        return 7;
      },
      beforeStructural: () => drain.promise,
      afterStructural: finalize
    });
    const requester = registry.openSession({
      repository: store,
      vaultRoot: "/departure-cleanup",
      onEvent: vi.fn()
    });
    await Promise.all([departed.activation, requester.activation]);
    const structuralWork = vi.fn(() => ({ kind: "skipped" as const }));

    const completion = requester.enqueueStructural(structuralWork);
    await Promise.resolve();
    departed.close();
    drain.resolve(false);
    await completion;

    expect(structuralWork).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(7);
    expect(activeIntentTokens.size).toBe(0);
    requester.close();
    await Promise.resolve();
    expect(registry.hasCoordinator(store, "/departure-cleanup")).toBe(false);
  });

  it("ignores a failed drain after a participant switches ownership", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const drain = deferred<boolean>();
    let current = true;
    const switched = registry.openSession({
      repository: store,
      vaultRoot: "/switched",
      onEvent: vi.fn(),
      beforeStructural: () => drain.promise,
      isCurrent: () => current
    });
    const requester = registry.openSession({
      repository: store,
      vaultRoot: "/switched",
      onEvent: vi.fn()
    });
    await Promise.all([switched.activation, requester.activation]);
    const structuralWork = vi.fn(() => ({ kind: "skipped" as const }));

    const completion = requester.enqueueStructural(structuralWork);
    await Promise.resolve();
    current = false;
    drain.resolve(false);
    await completion;

    expect(structuralWork).toHaveBeenCalledOnce();
    switched.close();
    requester.close();
  });

  it("captures one structural cutoff and ignores later draft generations", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    let generation = 4;
    const cutoffs: number[] = [];
    const participant = registry.openSession({
      repository: store,
      vaultRoot: "/cutoff",
      onEvent: vi.fn(),
      captureDraftCutoff: () => generation,
      beforeStructural: async (cutoff: number) => {
        cutoffs.push(cutoff);
        generation += 1;
        return true;
      }
    });
    await participant.activation;
    const structuralWork = vi.fn(() => ({ kind: "skipped" as const }));

    const completion = participant.enqueueStructural(structuralWork);
    expect(generation).toBe(5);
    await completion;

    expect(cutoffs).toEqual([4]);
    expect(structuralWork).toHaveBeenCalledOnce();
    participant.close();
  });

  it("queries and broadcasts status for partial-authority failures", async () => {
    const confirmed = workspace([node({ id: "saved-draft" })]);
    const store = repository({
      historyStatus: vi.fn().mockResolvedValue({
        canUndo: true,
        canRedo: false
      })
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const ownerEvents = vi.fn();
    const siblingEvents = vi.fn();
    const owner = registry.openSession({
      repository: store,
      vaultRoot: "/partial",
      onEvent: ownerEvents
    });
    const sibling = registry.openSession({
      repository: store,
      vaultRoot: "/partial",
      onEvent: siblingEvents
    });
    await Promise.all([owner.activation, sibling.activation]);
    ownerEvents.mockClear();
    siblingEvents.mockClear();

    await owner.enqueue(() => ({
      kind: "failure" as const,
      error: "move failed",
      workspace: confirmed
    }));

    expect(ownerEvents).toHaveBeenCalledWith({
      type: "settled",
      result: {
        kind: "failure",
        error: "move failed",
        workspace: confirmed,
        historyStatus: { canUndo: true, canRedo: false },
        historyVersion: 2
      },
      hasPendingWork: false
    });
    expect(siblingEvents).toHaveBeenCalledWith({
      type: "synchronized",
      hasPendingWork: false,
      sourceScope: { kind: "active" },
      result: {
        kind: "failure",
        error: "move failed",
        workspace: confirmed,
        historyStatus: { canUndo: true, canRedo: false },
        historyVersion: 2
      }
    });
    owner.close();
    sibling.close();
  });

  it("settles failure UI only to its owner and strips it from sibling sync", async () => {
    const confirmed = workspace([
      node({ id: "owner-selection" }),
      node({ id: "sibling-selection", sortKey: 2048 })
    ]);
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const ownerEvents = vi.fn();
    const siblingEvents = vi.fn();
    const owner = registry.openSession({
      repository: store,
      vaultRoot: "/failure-ui",
      onEvent: ownerEvents
    });
    const sibling = registry.openSession({
      repository: store,
      vaultRoot: "/failure-ui",
      onEvent: siblingEvents
    });
    await Promise.all([owner.activation, sibling.activation]);
    ownerEvents.mockClear();
    siblingEvents.mockClear();

    await owner.enqueue(() => ({
      kind: "failure" as const,
      error: "Projection reload failed",
      workspace: confirmed,
      uiUpdate: {
        selectedId: "owner-selection",
        pendingFocusId: "owner-selection"
      }
    }));

    expect(ownerEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "settled",
        result: expect.objectContaining({
          kind: "failure",
          uiUpdate: {
            selectedId: "owner-selection",
            pendingFocusId: "owner-selection"
          }
        })
      })
    );
    expect(siblingEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "synchronized",
        result: expect.not.objectContaining({ uiUpdate: expect.anything() })
      })
    );
    owner.close();
    sibling.close();
  });

  it("broadcasts an atomic projection failure as a scope invalidation", async () => {
    const confirmed = workspace([node({ id: "committed" })]);
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const ownerEvents = vi.fn();
    const siblingEvents = vi.fn();
    const owner = registry.openSession({
      repository: store,
      vaultRoot: "/projection-failure",
      onEvent: ownerEvents,
      getScope: () => ({ kind: "starred" })
    });
    const sibling = registry.openSession({
      repository: store,
      vaultRoot: "/projection-failure",
      onEvent: siblingEvents,
      getScope: () => ({ kind: "starred" })
    });
    await Promise.all([owner.activation, sibling.activation]);
    ownerEvents.mockClear();
    siblingEvents.mockClear();

    await owner.enqueue(() => ({
      kind: "failure" as const,
      error: "Projection reload failed",
      workspace: confirmed,
      historyStatus: { canUndo: true, canRedo: false },
      scopeAgnostic: true
    }));

    expect(siblingEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "synchronized",
        sourceScope: null,
        result: expect.objectContaining({
          workspace: confirmed,
          historyStatus: { canUndo: true, canRedo: false }
        })
      })
    );
    owner.close();
    sibling.close();
  });

  it("does not clear sibling pending state when another owner settles", async () => {
    const ownerWork = deferred<NotesWorkspace>();
    const siblingWork = deferred<NotesWorkspace>();
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const owner = registry.openSession({
      repository: store,
      vaultRoot: "/pending",
      onEvent: vi.fn()
    });
    const siblingEvents = vi.fn();
    const sibling = registry.openSession({
      repository: store,
      vaultRoot: "/pending",
      onEvent: siblingEvents
    });
    await Promise.all([owner.activation, sibling.activation]);
    siblingEvents.mockClear();

    const first = owner.enqueue(async () => ({
      kind: "authoritative" as const,
      workspace: await ownerWork.promise
    }));
    const second = sibling.enqueue(async () => ({
      kind: "authoritative" as const,
      workspace: await siblingWork.promise
    }));
    siblingEvents.mockClear();
    ownerWork.resolve(workspace([node({ id: "owner-result" })]));
    await first;

    expect(siblingEvents).toHaveBeenCalledWith({
      type: "synchronized",
      hasPendingWork: true,
      sourceScope: { kind: "active" },
      result: {
        kind: "authoritative",
        workspace: workspace([node({ id: "owner-result" })]),
        historyStatus: undefined
      }
    });
    siblingWork.resolve(workspace([node({ id: "sibling-result" })]));
    await second;
    owner.close();
    sibling.close();
  });

  it("drains every live session before enqueuing structural work", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const order: string[] = [];
    const firstDrain = deferred<void>();
    const first = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: vi.fn(),
      beforeStructural: async () => {
        order.push("first:start");
        await firstDrain.promise;
        order.push("first:end");
        return true;
      }
    });
    const second = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: vi.fn(),
      beforeStructural: async () => {
        order.push("second");
        return true;
      }
    });
    await Promise.all([first.activation, second.activation]);

    const structural = second.enqueueStructural(() => {
      order.push("structural");
      return { kind: "skipped" as const };
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    firstDrain.resolve();
    await structural;
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second",
      "structural"
    ]);
    first.close();
    second.close();
  });

  it("broadcasts an unmounted owner's authority without its UI update", async () => {
    const running = deferred<NotesWorkspace>();
    const store = repository({
      historyStatus: vi.fn().mockResolvedValue({
        canUndo: true,
        canRedo: false
      })
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const ownerEvents = vi.fn();
    const siblingEvents = vi.fn();
    const owner = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: ownerEvents
    });
    const sibling = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: siblingEvents
    });
    await Promise.all([owner.activation, sibling.activation]);
    ownerEvents.mockClear();
    siblingEvents.mockClear();

    const completion = owner.enqueue(async () => ({
      kind: "authoritative" as const,
      workspace: await running.promise,
      uiUpdate: {
        selectedId: "owner-selection",
        zoomRootId: "owner-zoom"
      }
    }));
    ownerEvents.mockClear();
    owner.close();
    const confirmed = workspace([node({ id: "confirmed" })]);
    running.resolve(confirmed);
    await completion;

    expect(ownerEvents).not.toHaveBeenCalled();
    expect(siblingEvents).toHaveBeenCalledWith({
      type: "synchronized",
      hasPendingWork: false,
      sourceScope: { kind: "active" },
      result: {
        kind: "authoritative",
        workspace: confirmed,
        historyStatus: { canUndo: true, canRedo: false },
        historyVersion: 2
      }
    });
    sibling.close();
  });

  it("settles activation only after loading authoritative history status", async () => {
    const history = deferred<{ canUndo: boolean; canRedo: boolean }>();
    const store = repository({
      historyStatus: vi.fn().mockReturnValue(history.promise)
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: events
    });
    let activated = false;
    void session.activation.then(() => {
      activated = true;
    });
    await vi.waitFor(() => expect(store.historyStatus).toHaveBeenCalledOnce());
    expect(activated).toBe(false);

    history.resolve({ canUndo: false, canRedo: true });
    await session.activation;
    expect(events).toHaveBeenCalledWith({
      type: "settled",
      result: {
        kind: "authoritative",
        workspace: workspace([node({ id: "root" })]),
        historyStatus: { canUndo: false, canRedo: true },
        historyVersion: 1
      },
      hasPendingWork: false
    });
    session.close();
  });

  it("normalizes malformed activation failures before notifying the UI", async () => {
    const store = repository({
      initialize: vi.fn().mockRejectedValue({ detail: "opaque" })
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      repository: store,
      vaultRoot: "/malformed-activation",
      onEvent: events
    });

    await session.activation;

    expect(events).toHaveBeenCalledWith({
      type: "settled",
      result: { kind: "failure", error: "Notes request failed." },
      hasPendingWork: false
    });
    expect(JSON.stringify(events.mock.calls)).not.toContain("[object Object]");
    session.close();
  });

  it("shares one history session per repository and vault coordinator entry", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const first = registry.openSession({
      repository: store,
      vaultRoot: "/vault-a",
      onEvent: vi.fn()
    });
    const second = registry.openSession({
      repository: store,
      vaultRoot: "/vault-a",
      onEvent: vi.fn()
    });
    const otherVault = registry.openSession({
      repository: store,
      vaultRoot: "/vault-b",
      onEvent: vi.fn()
    });

    await Promise.all([first.activation, second.activation, otherVault.activation]);

    expect(first.history).toBe(second.history);
    expect(first.history.sessionId).toBe(second.history.sessionId);
    expect(otherVault.history.sessionId).not.toBe(first.history.sessionId);
    first.close();
    second.close();
    otherVault.close();
  });

  it("creates a fresh history session when an idle coordinator is remounted", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const first = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: vi.fn()
    });
    await first.activation;
    const firstSessionId = first.history.sessionId;
    first.close();

    const remounted = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: vi.fn()
    });
    await remounted.activation;

    expect(remounted.history.sessionId).not.toBe(firstSessionId);
    expect(store.initialize).toHaveBeenCalledTimes(2);
    remounted.close();
  });

  it("advances confirmed workspace when failed work carries partial authority", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: events
    });
    await session.activation;
    const saved = workspace([node({ id: "root", title: "saved draft" })]);

    await session.enqueue(() => ({
      kind: "failure" as const,
      error: "move failed",
      workspace: saved
    }));
    let nextConfirmedWorkspace: NotesWorkspace | null = null;
    const nextWork = vi.fn(({ confirmedWorkspace }) => {
      nextConfirmedWorkspace = confirmedWorkspace;
      return { kind: "skipped" as const };
    });
    await session.enqueue(nextWork);

    expect(nextWork).toHaveBeenCalledOnce();
    expect(nextConfirmedWorkspace).toEqual(saved);
    expect(events).toHaveBeenCalledWith({
      type: "settled",
      result: {
        kind: "failure",
        error: "move failed",
        workspace: saved
      },
      hasPendingWork: false
    });
    session.close();
  });

  it("removes an idle entry after deferred initialization settles without a session", async () => {
    const initialization = deferred<void>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const session = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: vi.fn()
    });

    expect(registry.hasCoordinator(store, "/vault")).toBe(true);
    session.close();
    initialization.resolve();
    await session.activation;

    expect(store.loadWorkspace).not.toHaveBeenCalled();
    expect(registry.hasCoordinator(store, "/vault")).toBe(false);
  });

  it("cancels queued closures but retains a running operation as the remount barrier", async () => {
    const running = deferred<NotesWorkspace>();
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const firstSession = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: vi.fn()
    });
    await firstSession.activation;

    const runningWork = vi.fn(() =>
      running.promise.then((confirmed) => ({
        kind: "authoritative" as const,
        workspace: confirmed
      }))
    );
    const queuedWork = vi.fn(() => ({ kind: "skipped" as const }));
    const runningCompletion = firstSession.enqueue(runningWork);
    const queuedCompletion = firstSession.enqueue(queuedWork);
    expect(runningWork).toHaveBeenCalledOnce();

    firstSession.close();
    await queuedCompletion;
    expect(queuedWork).not.toHaveBeenCalled();
    expect(registry.hasCoordinator(store, "/vault")).toBe(true);

    const secondSession = registry.openSession({
      repository: store,
      vaultRoot: "/vault",
      onEvent: vi.fn()
    });
    expect(store.initialize).toHaveBeenCalledOnce();
    expect(store.loadWorkspace).toHaveBeenCalledOnce();

    running.resolve(workspace([node({ id: "after-running" })]));
    await runningCompletion;
    await secondSession.activation;

    expect(store.initialize).toHaveBeenCalledOnce();
    expect(store.loadWorkspace).toHaveBeenCalledTimes(2);
    secondSession.close();
    expect(registry.hasCoordinator(store, "/vault")).toBe(false);
  });

  it("keeps silent work out of pending accounting while still settling it", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      repository: store,
      vaultRoot: "/silent",
      onEvent: events
    });
    await session.activation;
    events.mockClear();

    const settled = workspace([node({ id: "silent-result" })]);
    await session.enqueue(
      () => ({ kind: "authoritative" as const, workspace: settled }),
      { silent: true }
    );

    // No "pending" event is raised for silent work, so loading never toggles...
    expect(events).not.toHaveBeenCalledWith({ type: "pending" });
    // ...but the authoritative workspace still settles to the owner, and the
    // silent write must not leave stale pending accounting behind.
    expect(events).toHaveBeenCalledWith({
      type: "settled",
      result: {
        kind: "authoritative",
        workspace: settled,
        historyStatus: undefined
      },
      hasPendingWork: false
    });
    session.close();
  });

  it("reports enqueueStructural settlement as committed, skipped, or failed", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const drain = deferred<boolean>();
    let allowDrain = true;
    const session = registry.openSession({
      repository: store,
      vaultRoot: "/settlement",
      onEvent: vi.fn(),
      beforeStructural: () => (allowDrain ? Promise.resolve(true) : drain.promise),
      isCurrent: () => true
    });
    await session.activation;

    // Normal path: the work runs and returns authoritative -> "committed".
    const committed = await session.enqueueStructural(() => ({
      kind: "authoritative" as const,
      workspace: workspace([node({ id: "committed" })])
    }));
    expect(committed).toBe("committed");

    // The work throws -> "failed".
    const failed = await session.enqueueStructural(() => {
      throw new Error("boom");
    });
    expect(failed).toBe("failed");

    // The draft-flush barrier fails for a still-current session -> the command
    // is dropped before it runs -> "skipped".
    allowDrain = false;
    const droppedWork = vi.fn(() => ({ kind: "authoritative" as const, workspace: workspace([]) }));
    const skipped = session.enqueueStructural(droppedWork);
    await Promise.resolve();
    drain.resolve(false);
    expect(await skipped).toBe("skipped");
    expect(droppedWork).not.toHaveBeenCalled();

    session.close();
  });

  it("reports work that returns kind:'skipped' as a skipped settlement", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const session = registry.openSession({
      repository: store,
      vaultRoot: "/settlement-skip",
      onEvent: vi.fn()
    });
    await session.activation;

    const outcome = await session.enqueue(() => ({ kind: "skipped" as const }));
    expect(outcome).toBe("skipped");

    session.close();
  });

  it("reports enqueue on a closed session as skipped without running the work", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const session = registry.openSession({
      repository: store,
      vaultRoot: "/settlement-closed",
      onEvent: vi.fn()
    });
    await session.activation;
    session.close();

    const work = vi.fn(() => ({
      kind: "authoritative" as const,
      workspace: workspace([])
    }));
    expect(await session.enqueue(work)).toBe("skipped");
    expect(work).not.toHaveBeenCalled();
  });
});
