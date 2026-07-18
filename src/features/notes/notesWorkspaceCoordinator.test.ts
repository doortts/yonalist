import { describe, expect, it, vi } from "vitest";
import type {
  NoteNode,
  NotesHistoryState,
  NotesStore,
  NotesWorkspace,
  NotesWorkspaceScope
} from "../../domain/notes";
import {
  createNotesExpansionSnapshotPool,
  type NotesExpansionSnapshotPool,
  type NotesHistorySnapshot
} from "./notesHistory";
import {
  createNotesWorkspaceCoordinatorRegistry,
  type OpenNotesWorkspaceSessionOptions
} from "./notesWorkspaceCoordinator";
import { normalizeWorkspace } from "./notesWorkspaceReducer";

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

function historyState(historyEpoch = "epoch-a"): NotesHistoryState {
  return {
    canUndo: false,
    canRedo: false,
    historyEpoch,
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
  };
}

function projectedHistoryState(
  nextUndoEntryId: string | null,
  nextRedoEntryId: string | null = null,
  prunedEntryIds: string[] = [],
  historyEpoch = "epoch-a"
): NotesHistoryState {
  return {
    canUndo: nextUndoEntryId !== null,
    canRedo: nextRedoEntryId !== null,
    historyEpoch,
    nextUndoEntryId,
    nextRedoEntryId,
    prunedEntryIds
  };
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

function historySnapshot(
  pool: NotesExpansionSnapshotPool,
  selectedId: string | null,
  expanded: readonly string[] = selectedId ? [selectedId] : []
): NotesHistorySnapshot {
  return {
    scope: { kind: "active" },
    libraryView: "all",
    activeTagFilters: [],
    selectedId,
    zoomRootId: selectedId,
    expansion: pool.acquire(expanded),
    focus: selectedId ? { nodeId: selectedId, field: "title" } : null
  };
}

function writableOptions(
  pool: NotesExpansionSnapshotPool,
  options: Omit<
    OpenNotesWorkspaceSessionOptions,
    "presentation" | "captureHistoryLocation" | "applyHistoryLocation"
  >,
  applyHistoryLocation: OpenNotesWorkspaceSessionOptions["applyHistoryLocation"] =
    () => true
): OpenNotesWorkspaceSessionOptions {
  return {
    ...options,
    presentation: "writable",
    captureHistoryLocation: () => historySnapshot(pool, "root"),
    applyHistoryLocation
  };
}

function repository(overrides: Partial<NotesStore> = {}): NotesStore {
  const empty = vi.fn().mockResolvedValue(workspace([]));
  return {
    initialize: vi.fn().mockResolvedValue(historyState()),
    loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
    createNode: empty,
    updateNode: empty,
    splitNode: empty,
    applyImageAtomEdit: vi.fn<NotesStore["applyImageAtomEdit"]>(),
    applyImageAtomPaste: vi.fn<NotesStore["applyImageAtomPaste"]>(),
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
      kind: "entryMissing",
      ...historyState()
    }),
    redo: vi.fn().mockResolvedValue({
      kind: "entryMissing",
      ...historyState()
    }),
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
      ...historyState(),
      historyReset: true
    }),
    pruneHistoryEntries: vi.fn().mockResolvedValue(historyState()),
    prepareNavigation: vi.fn().mockResolvedValue(historyState()),
    closeHistorySession: vi.fn().mockResolvedValue(undefined),
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi.fn().mockResolvedValue({ attachmentCleanupFailed: false }),
    ...overrides
  };
}

describe("notesWorkspaceCoordinator registry", () => {
  it("emits an explicit clear selection policy for ordinary queued work", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/ordinary-selection-policy",
      onEvent: events
    });
    await session.activation;
    events.mockClear();

    await session.enqueue(() => ({ kind: "skipped" as const }));

    expect(events).toHaveBeenCalledWith({
      type: "pending",
      selectionPolicy: "clear"
    });
    session.close();
  });

  it("defaults structural queued work to the clear selection policy", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/default-structural-selection-policy",
      onEvent: events
    });
    await session.activation;
    events.mockClear();

    await session.enqueueStructural(() => ({ kind: "skipped" as const }));

    expect(events).toHaveBeenCalledWith({
      type: "pending",
      selectionPolicy: "clear"
    });
    session.close();
  });

  it("forwards an explicit preserve policy for structural queued work", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/preserved-structural-selection-policy",
      onEvent: events
    });
    await session.activation;
    events.mockClear();

    await session.enqueueStructural(
      () => ({ kind: "skipped" as const }),
      { selectionPolicy: "preserve" }
    );

    expect(events).toHaveBeenCalledWith({
      type: "pending",
      selectionPolicy: "preserve"
    });
    session.close();
  });

  it("ignores a failed drain from a participant that departed during the pass", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const drain = deferred<boolean>();
    const departed = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/departure",
      onEvent: vi.fn(),
      beforeStructural: () => drain.promise
    });
    const requester = registry.openSession({
      presentation: "writable",
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
      presentation: "writable",
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
      presentation: "writable",
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
    await vi.waitFor(() =>
      expect(registry.hasCoordinator(store, "/departure-cleanup")).toBe(false)
    );
  });

  it("ignores a failed drain after a participant switches ownership", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const drain = deferred<boolean>();
    let current = true;
    const switched = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/switched",
      onEvent: vi.fn(),
      beforeStructural: () => drain.promise,
      isCurrent: () => current
    });
    const requester = registry.openSession({
      presentation: "writable",
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
      presentation: "writable",
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

  it("gives structural work the same scope captured after draft barriers", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const drain = deferred<boolean>();
    let scope: NotesWorkspaceScope = { kind: "active" };
    const ownerEvents = vi.fn();
    const siblingEvents = vi.fn();
    const sibling = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/structural-scope",
      onEvent: siblingEvents,
      getScope: () => scope
    });
    const owner = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/structural-scope",
      onEvent: ownerEvents,
      beforeStructural: () => drain.promise,
      getScope: () => scope
    });
    await Promise.all([owner.activation, sibling.activation]);
    ownerEvents.mockClear();
    siblingEvents.mockClear();

    const projected = workspace([node({ id: "starred-result", isStarred: true })]);
    let observedScope: NotesWorkspaceScope | null = null;
    const completion = owner.enqueueStructural((context) => {
      observedScope = context.sourceScope;
      return {
        kind: "authoritative" as const,
        workspace: projected
      };
    });
    await Promise.resolve();
    scope = { kind: "starred" };
    drain.resolve(true);
    await completion;

    expect(observedScope).toEqual({ kind: "starred" });
    expect(siblingEvents).toHaveBeenCalledWith({
      type: "synchronized",
      hasPendingWork: false,
      sourceScope: { kind: "starred" },
      result: expect.objectContaining({
        kind: "authoritative",
        workspace: projected
      })
    });
    owner.close();
    sibling.close();
  });

  it("owns canonical tag scopes and gives work a separate snapshot", async () => {
    const mutableTags: Extract<
      NotesWorkspaceScope,
      { kind: "tags" }
    >["tags"] = [
      { prefix: "@", normalizedTag: "alice" },
      { prefix: "#", normalizedTag: "work" },
      { prefix: "#", normalizedTag: "work" }
    ];
    const ownerScope: NotesWorkspaceScope = {
      kind: "tags",
      tags: mutableTags
    };
    const expectedScope: NotesWorkspaceScope = {
      kind: "tags",
      tags: [
        { prefix: "#", normalizedTag: "work" },
        { prefix: "@", normalizedTag: "alice" }
      ]
    };
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const siblingEvents = vi.fn();
    const started = deferred<NotesWorkspaceScope>();
    const finish = deferred<void>();
    const sibling = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/owned-scope",
      onEvent: siblingEvents,
      getScope: () => expectedScope
    });
    const owner = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/owned-scope",
      onEvent: vi.fn(),
      getScope: () => ownerScope
    });
    await Promise.all([owner.activation, sibling.activation]);
    siblingEvents.mockClear();

    const projected = workspace([node({ id: "canonical-projection" })]);
    const completion = owner.enqueue(async (context) => {
      started.resolve(context.sourceScope);
      await finish.promise;
      if (context.sourceScope.kind === "tags") {
        context.sourceScope.tags[0]!.normalizedTag = "changed-by-work";
        context.sourceScope.tags.reverse();
      }
      return { kind: "authoritative" as const, workspace: projected };
    });
    const workScope = await started.promise;

    expect(workScope).toEqual(expectedScope);
    expect(workScope).not.toBe(ownerScope);
    if (workScope?.kind === "tags") {
      expect(workScope.tags).not.toBe(mutableTags);
      expect(workScope.tags[0]).not.toBe(mutableTags[0]);
    }
    mutableTags[0]!.normalizedTag = "changed-by-caller";
    mutableTags.splice(1);
    owner.close();
    finish.resolve();
    await completion;

    expect(siblingEvents).toHaveBeenCalledWith({
      type: "synchronized",
      hasPendingWork: false,
      sourceScope: expectedScope,
      result: expect.objectContaining({
        kind: "authoritative",
        workspace: projected
      })
    });
    sibling.close();
  });

  it("prefers an explicit projection scope over a live scope reset", async () => {
    const filteredScope: NotesWorkspaceScope = {
      kind: "tags",
      tags: [{ prefix: "#", normalizedTag: "work" }]
    };
    let ownerScope: NotesWorkspaceScope = filteredScope;
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const drain = deferred<boolean>();
    const started = deferred<void>();
    const finish = deferred<void>();
    const siblingEvents = vi.fn();
    const sibling = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/explicit-projection-scope",
      onEvent: siblingEvents,
      getScope: () => filteredScope
    });
    const owner = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/explicit-projection-scope",
      onEvent: vi.fn(),
      beforeStructural: () => drain.promise,
      getScope: () => ownerScope
    });
    await Promise.all([owner.activation, sibling.activation]);
    siblingEvents.mockClear();

    const projected = workspace([node({ id: "filtered-projection" })]);
    const completion = owner.enqueueStructural(async (context) => {
      started.resolve();
      await finish.promise;
      return {
        kind: "authoritative" as const,
        workspace: projected,
        broadcastScope: context.sourceScope
      };
    });
    await Promise.resolve();
    drain.resolve(true);
    await started.promise;
    ownerScope = { kind: "active" };
    finish.resolve();
    await completion;

    expect(siblingEvents).toHaveBeenCalledWith({
      type: "synchronized",
      hasPendingWork: false,
      sourceScope: filteredScope,
      result: expect.objectContaining({
        kind: "authoritative",
        workspace: projected
      })
    });
    owner.close();
    sibling.close();
  });

  it("retains opted-in structural work after its owner closes", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const started = deferred<void>();
    const finish = deferred<void>();
    const siblingEvents = vi.fn();
    const owner = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/retained-structural",
      onEvent: vi.fn()
    });
    const sibling = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/retained-structural",
      onEvent: siblingEvents
    });
    await Promise.all([owner.activation, sibling.activation]);
    siblingEvents.mockClear();

    const projected = workspace([node({ id: "retained-result" })]);
    const completion = owner.enqueueStructural(
      async () => {
        started.resolve();
        await finish.promise;
        return { kind: "authoritative" as const, workspace: projected };
      },
      { retainAfterClose: true }
    );
    await started.promise;
    owner.close();
    finish.resolve();

    await expect(completion).resolves.toBe("committed");
    expect(siblingEvents).toHaveBeenCalledWith({
      type: "synchronized",
      hasPendingWork: false,
      sourceScope: { kind: "active" },
      result: expect.objectContaining({
        kind: "authoritative",
        workspace: projected
      })
    });
    sibling.close();
  });

  it("queries and broadcasts status for partial-authority failures", async () => {
    const confirmed = workspace([node({ id: "saved-draft" })]);
    const store = repository({
      historyStatus: vi.fn().mockResolvedValue({
        ...historyState(),
        canUndo: true
      })
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const ownerEvents = vi.fn();
    const siblingEvents = vi.fn();
    const sibling = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/partial",
      onEvent: siblingEvents
    });
    const owner = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/partial",
      onEvent: ownerEvents
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
        historyStatus: { ...historyState(), canUndo: true },
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
        historyStatus: { ...historyState(), canUndo: true },
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
    const sibling = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/failure-ui",
      onEvent: siblingEvents
    });
    const owner = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/failure-ui",
      onEvent: ownerEvents
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
    const sibling = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/projection-failure",
      onEvent: siblingEvents,
      getScope: () => ({ kind: "starred" })
    });
    const owner = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/projection-failure",
      onEvent: ownerEvents,
      getScope: () => ({ kind: "starred" })
    });
    await Promise.all([owner.activation, sibling.activation]);
    ownerEvents.mockClear();
    siblingEvents.mockClear();

    await owner.enqueue(() => ({
      kind: "failure" as const,
      error: "Projection reload failed",
      workspace: confirmed,
      historyStatus: { ...historyState(), canUndo: true },
      scopeAgnostic: true
    }));

    expect(siblingEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "synchronized",
        sourceScope: null,
        result: expect.objectContaining({
          workspace: confirmed,
          historyStatus: { ...historyState(), canUndo: true }
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
    const siblingEvents = vi.fn();
    const sibling = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/pending",
      onEvent: siblingEvents
    });
    const owner = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/pending",
      onEvent: vi.fn()
    });
    await Promise.all([owner.activation, sibling.activation]);
    siblingEvents.mockClear();

    const first = owner.enqueue(async () => ({
      kind: "authoritative" as const,
      workspace: await ownerWork.promise
    }));
    const second = sibling.enqueue(
      async () => ({
        kind: "authoritative" as const,
        workspace: await siblingWork.promise
      }),
      { observer: true }
    );
    siblingEvents.mockClear();
    ownerWork.resolve(workspace([node({ id: "owner-result" })]));
    await first;

    expect(siblingEvents).toHaveBeenCalledWith(expect.objectContaining({
      type: "synchronized",
      hasPendingWork: true,
      sourceScope: { kind: "active" },
      result: expect.objectContaining({
        kind: "authoritative",
        workspace: workspace([node({ id: "owner-result" })]),
        historyStatus: undefined
      })
    }));
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
      presentation: "writable",
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
      presentation: "writable",
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
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const ownerEvents = vi.fn();
    const siblingEvents = vi.fn();
    const sibling = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/vault",
      onEvent: siblingEvents
    });
    const owner = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/vault",
      onEvent: ownerEvents
    });
    await Promise.all([owner.activation, sibling.activation]);
    ownerEvents.mockClear();
    siblingEvents.mockClear();

    const completion = owner.enqueue(async () => ({
      kind: "authoritative" as const,
      workspace: await running.promise,
      tagSummaries: [],
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
        historyStatus: { ...historyState(), canUndo: true },
        historyVersion: 2,
        tagSummaries: []
      }
    });
    sibling.close();
  });

  it.each([
    ["active", { kind: "active" }],
    ["starred", { kind: "starred" }],
    [
      "tags",
      {
        kind: "tags",
        tags: [{ prefix: "#", normalizedTag: "work" }]
      }
    ],
    ["recent", { kind: "recent" }],
    ["archive", { kind: "archive" }],
    ["trash", { kind: "trash" }]
  ] as const)(
    "broadcasts an unmounted owner's captured %s projection to same-scope siblings",
    async (_label, capturedScope) => {
      const running = deferred<NotesWorkspace>();
      const store = repository();
      const registry = createNotesWorkspaceCoordinatorRegistry();
      const siblingEvents = vi.fn();
      const projected = workspace([node({ id: `${capturedScope.kind}-projected` })]);
      const getScope = (): NotesWorkspaceScope => {
        if (capturedScope.kind === "tags") {
          return {
            kind: "tags",
            tags: capturedScope.tags.map((tag) => ({ ...tag }))
          };
        }
        return { ...capturedScope };
      };
      const sibling = registry.openSession({
      presentation: "writable",
        repository: store,
        vaultRoot: `/ownerless-${capturedScope.kind}`,
        onEvent: siblingEvents,
        getScope
      });
      const owner = registry.openSession({
      presentation: "writable",
        repository: store,
        vaultRoot: `/ownerless-${capturedScope.kind}`,
        onEvent: vi.fn(),
        getScope
      });
      await Promise.all([owner.activation, sibling.activation]);
      siblingEvents.mockClear();

      const completion = owner.enqueue(async () => ({
        kind: "authoritative" as const,
        workspace: await running.promise
      }));
      owner.close();
      running.resolve(projected);
      await completion;

      expect(siblingEvents).toHaveBeenCalledWith({
        type: "synchronized",
        hasPendingWork: false,
        sourceScope: capturedScope,
        result: {
          kind: "authoritative",
          workspace: projected,
          historyStatus: undefined,
          historyVersion: undefined
        }
      });
      sibling.close();
    }
  );

  it("broadcasts a departed owner's projection failure as a scope invalidation", async () => {
    const rawActive = workspace([node({ id: "raw-active" })]);
    const running = deferred<NotesWorkspace>();
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const siblingEvents = vi.fn();
    const starredScope = { kind: "starred" } as const;
    const sibling = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/ownerless-projection-failure",
      onEvent: siblingEvents,
      getScope: () => starredScope
    });
    const owner = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/ownerless-projection-failure",
      onEvent: vi.fn(),
      getScope: () => starredScope
    });
    await Promise.all([owner.activation, sibling.activation]);
    siblingEvents.mockClear();

    const completion = owner.enqueue(async () => {
      await running.promise;
      return {
        kind: "failure" as const,
        error: "Projection reload failed",
        workspace: rawActive,
        historyStatus: { ...historyState(), canUndo: true },
        scopeAgnostic: true,
        committedHistoryEntryIds: ["committed-entry"]
      };
    });
    owner.close();
    running.resolve(rawActive);
    await completion;

    expect(siblingEvents).toHaveBeenCalledWith({
      type: "synchronized",
      hasPendingWork: false,
      sourceScope: null,
      result: {
        kind: "failure",
        error: "Projection reload failed",
        workspace: rawActive,
        historyStatus: { ...historyState(), canUndo: true },
        historyVersion: 2,
        scopeAgnostic: true,
        committedHistoryEntryIds: ["committed-entry"]
      }
    });
    sibling.close();
  });

  it("settles activation only after loading authoritative history status", async () => {
    const history = deferred<NotesHistoryState>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(history.promise)
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/vault",
      onEvent: events
    });
    let activated = false;
    void session.activation.then(() => {
      activated = true;
    });
    await vi.waitFor(() => expect(store.initialize).toHaveBeenCalledOnce());
    expect(activated).toBe(false);

    history.resolve({
      ...historyState(),
      canRedo: true,
      nextRedoEntryId: "redo-entry"
    });
    await session.activation;
    expect(events).toHaveBeenCalledWith({
      type: "settled",
      result: {
        kind: "authoritative",
        workspace: workspace([node({ id: "root" })]),
        historyStatus: {
          ...historyState(),
          canRedo: true,
          nextRedoEntryId: "redo-entry"
        },
        historyVersion: 1
      },
      hasPendingWork: false
    });
    session.close();
  });

  it("binds the shared history epoch from the exact initialization session", async () => {
    const initialization = deferred<NotesHistoryState>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise),
      historyStatus: undefined
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const session = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/bound-history",
      onEvent: vi.fn()
    });

    expect(store.initialize).toHaveBeenCalledWith("/bound-history", {
      sessionId: session.history.sessionId
    });
    expect(() => session.history.historyEpoch).toThrow("not initialized");

    initialization.resolve(historyState("epoch-bound"));
    await session.activation;

    expect(session.history.historyEpoch).toBe("epoch-bound");
    session.close();
  });

  it("rejects malformed initialization state before binding the session", async () => {
    const store = repository({
      initialize: vi.fn().mockResolvedValue({
        ...historyState(),
        nextUndoEntryId: 42
      })
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/malformed-history-state",
      onEvent: events
    });

    await session.activation;

    expect(events).toHaveBeenCalledWith({
      type: "settled",
      result: {
        kind: "failure",
        error: "Notes initialization returned an invalid history state."
      },
      hasPendingWork: false
    });
    expect(() => session.history.historyEpoch).toThrow("not initialized");
    expect(store.loadWorkspace).not.toHaveBeenCalled();
    session.close();
  });

  it("normalizes malformed activation failures before notifying the UI", async () => {
    const store = repository({
      initialize: vi.fn().mockRejectedValue({ detail: "opaque" })
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      presentation: "writable",
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
      presentation: "writable",
      repository: store,
      vaultRoot: "/vault-a",
      onEvent: vi.fn()
    });
    const second = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/vault-a",
      onEvent: vi.fn()
    });
    const otherVault = registry.openSession({
      presentation: "writable",
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
      presentation: "writable",
      repository: store,
      vaultRoot: "/vault",
      onEvent: vi.fn()
    });
    await first.activation;
    const firstSessionId = first.history.sessionId;
    first.close();

    const remounted = registry.openSession({
      presentation: "writable",
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
      presentation: "writable",
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
    const initialization = deferred<NotesHistoryState>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const session = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/vault",
      onEvent: vi.fn()
    });

    expect(registry.hasCoordinator(store, "/vault")).toBe(true);
    session.close();
    initialization.resolve(historyState());
    await session.activation;

    expect(store.loadWorkspace).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(registry.hasCoordinator(store, "/vault")).toBe(false)
    );
  });

  it("cancels queued closures but retains a running operation as the remount barrier", async () => {
    const running = deferred<NotesWorkspace>();
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const firstSession = registry.openSession({
      presentation: "writable",
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
      presentation: "writable",
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
    await vi.waitFor(() =>
      expect(registry.hasCoordinator(store, "/vault")).toBe(false)
    );
  });

  it("keeps silent work out of pending accounting while still settling it", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const events = vi.fn();
    const session = registry.openSession({
      presentation: "writable",
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
      presentation: "writable",
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

  it("does not strand the queue when a caller-owned failure callback throws", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const session = registry.openSession({
      presentation: "writable",
      repository: store,
      vaultRoot: "/settlement-failure-callback",
      onEvent: vi.fn()
    });
    await session.activation;
    const settleFailure = vi.fn(() => {
      throw new Error("feedback failed");
    });

    await expect(
      session.enqueueStructural(
        () => ({ kind: "failure" as const, error: "command failed" }),
        { settleFailure }
      )
    ).resolves.toBe("skipped");
    expect(settleFailure).toHaveBeenCalledWith("command failed");
    const next = vi.fn(() => ({ kind: "skipped" as const }));
    await expect(session.enqueueStructural(next)).resolves.toBe("skipped");
    expect(next).toHaveBeenCalledOnce();
    session.close();
  });

  it("reports work that returns kind:'skipped' as a skipped settlement", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const session = registry.openSession({
      presentation: "writable",
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
      presentation: "writable",
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

  it("waits for final close and coalesces an immediate reopen into one fresh generation", async () => {
    const closeBackend = deferred<void>();
    const initialize = vi
      .fn()
      .mockResolvedValueOnce(historyState("epoch-a"))
      .mockResolvedValueOnce(historyState("epoch-b"));
    const store = repository({
      initialize,
      closeHistorySession: vi.fn().mockReturnValue(closeBackend.promise)
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const open = () =>
      registry.openSession(
        writableOptions(pool, {
          repository: store,
          vaultRoot: "/close-reopen",
          onEvent: vi.fn()
        })
      );
    const first = open();
    await first.activation;
    const firstEpoch = first.history.historyEpoch;

    first.close();
    await vi.waitFor(() => expect(store.closeHistorySession).toHaveBeenCalledOnce());
    const second = open();
    const third = open();

    expect(second.history.sessionId).not.toBe(first.history.sessionId);
    expect(third.history.sessionId).toBe(second.history.sessionId);
    expect(Object.is(second.history, first.history)).toBe(false);
    expect(Object.is(third.history, second.history)).toBe(true);
    expect(initialize).toHaveBeenCalledOnce();

    closeBackend.resolve();
    await expect(Promise.all([second.activation, third.activation])).resolves.toEqual([
      undefined,
      undefined
    ]);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenLastCalledWith("/close-reopen", {
      sessionId: second.history.sessionId
    });
    expect(second.history.historyEpoch).toBe("epoch-b");
    expect(second.history.historyEpoch).not.toBe(firstEpoch);
    second.close();
    third.close();
  });

  it("completes close and reopens even when cleanup or backend close fails", async () => {
    const store = repository({
      initialize: vi
        .fn()
        .mockResolvedValueOnce(historyState("epoch-a"))
        .mockResolvedValueOnce(historyState("epoch-b")),
      pruneHistoryEntries: vi.fn().mockRejectedValue(new Error("cleanup busy")),
      closeHistorySession: vi.fn().mockRejectedValue(new Error("close busy"))
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const first = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/failed-close-reopen",
        onEvent: vi.fn()
      })
    );
    await first.activation;
    first.queueHistoryCleanup(["unreachable"]);
    first.close();
    const reopened = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/failed-close-reopen",
        onEvent: vi.fn()
      })
    );

    await expect(reopened.activation).resolves.toBeUndefined();
    expect(store.pruneHistoryEntries).toHaveBeenCalledOnce();
    expect(store.closeHistorySession).toHaveBeenCalledOnce();
    expect(store.initialize).toHaveBeenCalledTimes(2);
    expect(reopened.history.sessionId).not.toBe(first.history.sessionId);
    reopened.close();
  });

  it("never transfers presentation ownership to a background recovery session", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const background = registry.openSession({
      presentation: "background",
      repository: store,
      vaultRoot: "/background-owner",
      onEvent: vi.fn()
    });
    await background.activation;
    const backgroundWork = vi.fn(() => ({ kind: "skipped" as const }));

    await expect(background.enqueue(backgroundWork)).resolves.toBe("skipped");
    await expect(background.enqueueStructural(backgroundWork)).resolves.toBe(
      "skipped"
    );
    expect(backgroundWork).not.toHaveBeenCalled();

    const pool = createNotesExpansionSnapshotPool();
    const visible = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/background-owner",
        onEvent: vi.fn()
      })
    );
    await visible.activation;
    expect(visible.isCurrentOwner(visible.ownerToken())).toBe(true);
    background.close();
    visible.close();
  });

  it("lets admitted work settle after owner transfer and discards queued stale intents", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const firstApply = vi.fn(() => true);
    const secondApply = vi.fn(() => true);
    const first = registry.openSession(
      writableOptions(
        pool,
        { repository: store, vaultRoot: "/owner-transfer", onEvent: vi.fn() },
        firstApply
      )
    );
    await first.activation;
    const second = registry.openSession(
      writableOptions(
        pool,
        { repository: store, vaultRoot: "/owner-transfer", onEvent: vi.fn() },
        secondApply
      )
    );
    await second.activation;
    const running = deferred<NotesWorkspace>();
    const admitted = second.enqueue(async () => ({
      kind: "authoritative" as const,
      workspace: await running.promise
    }));
    const staleWork = vi.fn(() => ({ kind: "skipped" as const }));
    const stale = second.enqueue(staleWork);

    second.close();
    const transferredToken = first.ownerToken();
    expect(first.isCurrentOwner(transferredToken)).toBe(true);
    running.resolve(workspace([node({ id: "settled-after-transfer" })]));

    await expect(admitted).resolves.toBe("committed");
    await expect(stale).resolves.toBe("skipped");
    expect(staleWork).not.toHaveBeenCalled();
    expect(firstApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodesById: expect.any(Object) }),
      expect.objectContaining({ selectedId: "root" })
    );
    first.close();
  });

  it("keeps trimmed entries hidden and blocks new work while cleanup retry fails", async () => {
    const pruneHistoryEntries = vi
      .fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(historyState());
    const store = repository({ pruneHistoryEntries });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const session = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/cleanup-retry",
        onEvent: vi.fn()
      })
    );
    await session.activation;
    session.history.appendNavigation(
      historySnapshot(pool, "a"),
      historySnapshot(pool, "b")
    );
    session.queueHistoryCleanup(["trimmed-entry", "trimmed-entry"]);
    const blockedWork = vi.fn(() => ({ kind: "skipped" as const }));

    await expect(session.enqueueStructural(blockedWork)).resolves.toBe("failed");
    expect(blockedWork).not.toHaveBeenCalled();
    expect(session.history.canUndo()).toBe(true);

    await expect(session.drainHistoryCleanup()).resolves.toBeUndefined();
    expect(pruneHistoryEntries).toHaveBeenLastCalledWith("/cleanup-retry", {
      sessionId: session.history.sessionId,
      historyEpoch: session.history.historyEpoch,
      entryIds: ["trimmed-entry"]
    });
    session.close();
  });

  it("clears pending cleanup atomically when history is reset", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const session = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/cleanup-reset",
        onEvent: vi.fn()
      })
    );
    await session.activation;
    session.queueHistoryCleanup(["stale-entry"]);
    session.resetHistory("epoch-b", {
      workspace: normalizeWorkspace(workspace([node({ id: "reloaded" })])),
      snapshot: historySnapshot(pool, "reloaded")
    });

    await session.drainHistoryCleanup();
    expect(store.pruneHistoryEntries).not.toHaveBeenCalled();
    expect(session.history.historyEpoch).toBe("epoch-b");
    let resetContextWorkspace: NotesWorkspace | null = null;
    await session.enqueue((context) => {
      resetContextWorkspace = context.confirmedWorkspace;
      return { kind: "skipped" as const };
    });
    expect(resetContextWorkspace).toEqual(
      expect.objectContaining({
        nodes: [expect.objectContaining({ id: "reloaded" })]
      })
    );
    session.close();
  });

  it("transfers lease references atomically to timeline and canonical owners", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const apply = vi.fn(() => true);
    const session = registry.openSession(
      writableOptions(
        pool,
        { repository: store, vaultRoot: "/lease-refs", onEvent: vi.fn() },
        apply
      )
    );
    await session.activation;
    const before = historySnapshot(pool, "before", ["before-expansion"]);
    const after = historySnapshot(pool, "after", ["after-expansion"]);
    const lease = session.reserveAdmittedNavigation(before);
    lease.setDestination(
      normalizeWorkspace(workspace([node({ id: "after" })])),
      after
    );
    pool.release(before.expansion);
    pool.release(after.expansion);

    expect(lease.commit()).toEqual([]);
    expect(session.history.next("undo")?.kind).toBe("navigation");
    const afterWhileCanonicalAndTimeline = pool.acquire(["after-expansion"]);
    expect(afterWhileCanonicalAndTimeline).toBe(after.expansion);
    pool.release(afterWhileCanonicalAndTimeline);

    session.settleAuthoritativePresentation(
      normalizeWorkspace(workspace([node({ id: "replacement" })])),
      historySnapshot(pool, "replacement", ["replacement-expansion"])
    );
    const afterWhileTimeline = pool.acquire(["after-expansion"]);
    expect(afterWhileTimeline).toBe(after.expansion);
    pool.release(afterWhileTimeline);

    session.resetHistory("epoch-b", {
      workspace: normalizeWorkspace(workspace([node({ id: "replacement" })])),
      snapshot: historySnapshot(pool, "replacement", ["replacement-expansion"])
    });
    const afterReleased = pool.acquire(["after-expansion"]);
    expect(afterReleased).not.toBe(after.expansion);
    pool.release(afterReleased);
    session.close();
  });

  it("reserves the current canonical origin when navigation omits an explicit before", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const session = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/canonical-lease-origin",
        onEvent: vi.fn()
      })
    );
    await session.activation;
    const canonical = historySnapshot(pool, "canonical", ["canonical-origin"]);
    session.settleAuthoritativePresentation(
      normalizeWorkspace(workspace([node({ id: "canonical" })])),
      canonical
    );
    pool.release(canonical.expansion);

    const lease = session.reserveAdmittedNavigation();
    const borrowed = lease.beforeSnapshot();
    expect(borrowed).toMatchObject({
      selectedId: "canonical",
      zoomRootId: "canonical"
    });

    const replacement = historySnapshot(pool, "replacement", ["replacement"]);
    session.settleAuthoritativePresentation(
      normalizeWorkspace(workspace([node({ id: "replacement" })])),
      replacement
    );
    pool.release(replacement.expansion);
    const retainedByLease = pool.acquire(["canonical-origin"]);
    expect(retainedByLease).toBe(borrowed!.expansion);
    pool.release(retainedByLease);

    lease.cancel();
    expect(lease.beforeSnapshot()).toBeNull();
    const releasedWithLease = pool.acquire(["canonical-origin"]);
    expect(releasedWithLease).not.toBe(borrowed!.expansion);
    pool.release(releasedWithLease);
    session.close();
  });

  it("balances repeated before replacement across canonical replacement and cancel", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const session = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/replace-before-refs",
        onEvent: vi.fn()
      })
    );
    await session.activation;
    const canonical = historySnapshot(pool, "canonical", ["canonical-origin"]);
    session.settleAuthoritativePresentation(
      normalizeWorkspace(workspace([node({ id: "canonical" })])),
      canonical
    );
    pool.release(canonical.expansion);

    const lease = session.reserveAdmittedNavigation();
    const replacement = historySnapshot(pool, "replacement", ["replacement-origin"]);
    lease.replaceBefore(replacement);
    lease.replaceBefore(replacement);
    pool.release(replacement.expansion);
    const nextCanonical = historySnapshot(pool, "next", ["next-canonical"]);
    session.settleAuthoritativePresentation(
      normalizeWorkspace(workspace([node({ id: "next" })])),
      nextCanonical
    );
    pool.release(nextCanonical.expansion);

    const canonicalReleased = pool.acquire(["canonical-origin"]);
    expect(canonicalReleased).not.toBe(canonical.expansion);
    pool.release(canonicalReleased);
    const replacementRetained = pool.acquire(["replacement-origin"]);
    expect(replacementRetained).toBe(replacement.expansion);
    pool.release(replacementRetained);

    lease.cancel();
    const replacementReleased = pool.acquire(["replacement-origin"]);
    expect(replacementReleased).not.toBe(replacement.expansion);
    pool.release(replacementReleased);
    const ignored = historySnapshot(pool, "ignored", ["ignored-origin"]);
    lease.replaceBefore(ignored);
    pool.release(ignored.expansion);
    const inactiveReplacementReleased = pool.acquire(["ignored-origin"]);
    expect(inactiveReplacementReleased).not.toBe(ignored.expansion);
    pool.release(inactiveReplacementReleased);
    session.close();
  });

  it("settles a newly activated owner with its canonical presentation", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const first = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/activation-canonical",
        onEvent: vi.fn()
      })
    );
    await first.activation;
    const lease = first.reserveAdmittedNavigation(historySnapshot(pool, "root"));
    lease.setDestination(
      normalizeWorkspace(workspace([node({ id: "canonical" })])),
      historySnapshot(pool, "canonical")
    );
    lease.commit();

    const secondEvents = vi.fn();
    const secondApply = vi.fn(() => true);
    const second = registry.openSession(
      writableOptions(
        pool,
        {
          repository: store,
          vaultRoot: "/activation-canonical",
          onEvent: secondEvents
        },
        secondApply
      )
    );
    await second.activation;

    expect(secondApply).toHaveBeenCalledWith(
      expect.objectContaining({
        nodesById: expect.objectContaining({ canonical: expect.anything() })
      }),
      expect.objectContaining({ selectedId: "canonical" })
    );
    expect(secondEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "settled",
        result: expect.objectContaining({
          workspace: expect.objectContaining({
            nodes: [expect.objectContaining({ id: "canonical" })]
          })
        })
      })
    );
    let nextContextWorkspace: NotesWorkspace | null = null;
    await second.enqueue((context) => {
      nextContextWorkspace = context.confirmedWorkspace;
      return { kind: "skipped" as const };
    });
    expect(nextContextWorkspace).toEqual(
      expect.objectContaining({
        nodes: [expect.objectContaining({ id: "canonical" })]
      })
    );
    second.close();
    let closeTransferWorkspace: NotesWorkspace | null = null;
    await first.enqueue((context) => {
      closeTransferWorkspace = context.confirmedWorkspace;
      return { kind: "skipped" as const };
    });
    expect(closeTransferWorkspace).toEqual(
      expect.objectContaining({
        nodes: [expect.objectContaining({ id: "canonical" })]
      })
    );
    first.close();
  });

  it("updates the current owner after another session settles canonical presentation", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const first = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/settlement-canonical",
        onEvent: vi.fn()
      })
    );
    await first.activation;
    const second = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/settlement-canonical",
        onEvent: vi.fn()
      })
    );
    await second.activation;

    first.settleAuthoritativePresentation(
      normalizeWorkspace(workspace([node({ id: "settled-canonical" })])),
      historySnapshot(pool, "settled-canonical")
    );

    let nextContextWorkspace: NotesWorkspace | null = null;
    await second.enqueue((context) => {
      nextContextWorkspace = context.confirmedWorkspace;
      return { kind: "skipped" as const };
    });
    expect(nextContextWorkspace).toEqual(
      expect.objectContaining({
        nodes: [expect.objectContaining({ id: "settled-canonical" })]
      })
    );
    first.close();
    second.close();
  });

  it("releases cancelled lease refs and keeps canonical refs until final close", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const session = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/canonical-close-refs",
        onEvent: vi.fn()
      })
    );
    await session.activation;

    const before = historySnapshot(pool, "before", ["before-expansion"]);
    const after = historySnapshot(pool, "after", ["after-expansion"]);
    const cancelled = session.reserveAdmittedNavigation(before);
    cancelled.setDestination(
      normalizeWorkspace(workspace([node({ id: "after" })])),
      after
    );
    cancelled.cancel();
    pool.release(before.expansion);
    pool.release(after.expansion);
    const releasedAfterCancel = pool.acquire(["after-expansion"]);
    expect(releasedAfterCancel).not.toBe(after.expansion);
    pool.release(releasedAfterCancel);

    const canonicalBefore = historySnapshot(pool, "root", ["before-canonical"]);
    const canonical = historySnapshot(pool, "canonical", ["canonical-expansion"]);
    const committed = session.reserveAdmittedNavigation(canonicalBefore);
    committed.setDestination(
      normalizeWorkspace(workspace([node({ id: "canonical" })])),
      canonical
    );
    pool.release(canonicalBefore.expansion);
    pool.release(canonical.expansion);
    committed.commit();
    session.history.reset("epoch-b");
    const retainedAfterReset = pool.acquire(["canonical-expansion"]);
    expect(retainedAfterReset).toBe(canonical.expansion);
    pool.release(retainedAfterReset);

    session.close();
    await vi.waitFor(() =>
      expect(registry.hasCoordinator(store, "/canonical-close-refs")).toBe(false)
    );
    const releasedAfterClose = pool.acquire(["canonical-expansion"]);
    expect(releasedAfterClose).not.toBe(canonical.expansion);
    pool.release(releasedAfterClose);
  });

  it("blocks work after a committed destination cannot be presented and unblocks on owner apply", async () => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    let canApply = true;
    const firstEvents = vi.fn();
    const firstApply = vi.fn(() => canApply);
    const first = registry.openSession(
      writableOptions(
        pool,
        { repository: store, vaultRoot: "/presentation-block", onEvent: firstEvents },
        firstApply
      )
    );
    await first.activation;
    const lease = first.reserveAdmittedNavigation(historySnapshot(pool, "root"));
    lease.setDestination(
      normalizeWorkspace(workspace([node({ id: "destination" })])),
      historySnapshot(pool, "destination")
    );
    canApply = false;
    lease.commit();

    const blockedWork = vi.fn(() => ({ kind: "skipped" as const }));
    await expect(first.enqueue(blockedWork)).resolves.toBe("failed");
    expect(blockedWork).not.toHaveBeenCalled();
    expect(JSON.stringify(firstEvents.mock.calls)).toContain("close and reopen");

    const secondApply = vi.fn(() => true);
    const second = registry.openSession(
      writableOptions(
        pool,
        { repository: store, vaultRoot: "/presentation-block", onEvent: vi.fn() },
        secondApply
      )
    );
    await second.activation;
    expect(secondApply).toHaveBeenCalledWith(
      expect.objectContaining({ nodesById: expect.objectContaining({ destination: expect.anything() }) }),
      expect.objectContaining({ selectedId: "destination" })
    );
    const allowedWork = vi.fn(() => ({ kind: "skipped" as const }));
    await second.enqueue(allowedWork);
    expect(allowedWork).toHaveBeenCalledOnce();
    first.close();
    second.close();
  });

  it("recovers a mismatch once, rotates epoch, resets presentation, and unblocks work", async () => {
    const historyStatus = vi
      .fn()
      .mockResolvedValue(projectedHistoryState(null, null, [], "epoch-a"));
    const clearHistory = vi.fn().mockResolvedValue({
      ...projectedHistoryState(null, null, [], "epoch-b"),
      historyReset: true as const
    });
    const store = repository({ historyStatus, clearHistory });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const session = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/history-recovery",
        onEvent: vi.fn()
      })
    );
    await session.activation;
    const reload = vi.fn().mockResolvedValue({
      workspace: normalizeWorkspace(workspace([node({ id: "reloaded" })])),
      snapshot: historySnapshot(pool, "reloaded")
    });

    const first = session.recoverHistoryMismatch(
      projectedHistoryState("unexpected", null, [], "epoch-a"),
      reload
    );
    const second = session.recoverHistoryMismatch(
      projectedHistoryState("unexpected", null, [], "epoch-a"),
      reload
    );
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ snapshot: expect.objectContaining({ selectedId: "reloaded" }) }),
      expect.objectContaining({ snapshot: expect.objectContaining({ selectedId: "reloaded" }) })
    ]);
    expect(historyStatus).toHaveBeenCalledOnce();
    expect(clearHistory).toHaveBeenCalledWith("/history-recovery", {
      sessionId: session.history.sessionId,
      historyEpoch: "epoch-a"
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(session.history.historyEpoch).toBe("epoch-b");

    const work = vi.fn(() => ({ kind: "skipped" as const }));
    await session.enqueue(work);
    expect(work).toHaveBeenCalledOnce();
    session.close();
  });

  it("waits for mismatch recovery before final close releases the recovered presentation", async () => {
    const clear = deferred<NotesHistoryState & { historyReset: true }>();
    const closeHistorySession = vi.fn().mockResolvedValue(undefined);
    const store = repository({
      historyStatus: vi.fn().mockResolvedValue(historyState("epoch-a")),
      clearHistory: vi.fn().mockReturnValue(clear.promise),
      closeHistorySession
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const session = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/recovery-close",
        onEvent: vi.fn()
      })
    );
    await session.activation;
    const recovery = session.recoverHistoryMismatch(
      projectedHistoryState("unexpected", null, [], "epoch-a"),
      async () => ({
        workspace: normalizeWorkspace(workspace([node({ id: "reloaded" })])),
        snapshot: historySnapshot(pool, "reloaded")
      })
    );
    await vi.waitFor(() => expect(store.clearHistory).toHaveBeenCalledOnce());

    session.close();
    await Promise.resolve();
    expect(closeHistorySession).not.toHaveBeenCalled();

    clear.resolve({
      ...historyState("epoch-b"),
      historyReset: true
    });
    await expect(recovery).resolves.toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({ selectedId: "reloaded" })
      })
    );
    await vi.waitFor(() => expect(closeHistorySession).toHaveBeenCalledOnce());
    expect(pool.size()).toBe(0);
  });

  it("closes cleanly after recovery finds no history status endpoint", async () => {
    const closeHistorySession = vi.fn().mockResolvedValue(undefined);
    const store = repository({ closeHistorySession });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const session = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/recovery-no-status-close",
        onEvent: vi.fn()
      })
    );
    await session.activation;

    await expect(
      session.recoverHistoryMismatch(projectedHistoryState("mismatch"), async () => {
        throw new Error("reload must not run");
      })
    ).resolves.toBeNull();

    session.close();
    await vi.waitFor(() => expect(closeHistorySession).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(registry.hasCoordinator(store, "/recovery-no-status-close")).toBe(false)
    );
    expect(pool.size()).toBe(0);
  });

  it("closes cleanly after recovery history status throws synchronously", async () => {
    const closeHistorySession = vi.fn().mockResolvedValue(undefined);
    const historyStatus = vi.fn(() => {
      throw new Error("status unavailable");
    });
    const store = repository({ historyStatus, closeHistorySession });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const session = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/recovery-throw-close",
        onEvent: vi.fn()
      })
    );
    await session.activation;

    await expect(
      session.recoverHistoryMismatch(projectedHistoryState("mismatch"), async () => {
        throw new Error("reload must not run");
      })
    ).resolves.toBeNull();
    expect(historyStatus).toHaveBeenCalledOnce();

    session.close();
    await vi.waitFor(() => expect(closeHistorySession).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(registry.hasCoordinator(store, "/recovery-throw-close")).toBe(false)
    );
    expect(pool.size()).toBe(0);
  });

  it("keeps a failed mismatch recovery blocked before later repository work", async () => {
    const store = repository({
      historyStatus: vi.fn().mockResolvedValue(historyState()),
      clearHistory: vi.fn().mockRejectedValue(new Error("clear failed"))
    });
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const events = vi.fn();
    const session = registry.openSession(
      writableOptions(pool, {
        repository: store,
        vaultRoot: "/failed-recovery",
        onEvent: events
      })
    );
    await session.activation;
    await expect(
      session.recoverHistoryMismatch(projectedHistoryState("mismatch"), async () => ({
        workspace: normalizeWorkspace(workspace([])),
        snapshot: historySnapshot(pool, null)
      }))
    ).resolves.toBeNull();

    const work = vi.fn(() => ({ kind: "skipped" as const }));
    await expect(session.enqueueStructural(work)).resolves.toBe("failed");
    expect(work).not.toHaveBeenCalled();
    expect(JSON.stringify(events.mock.calls)).toContain("close and reopen");
    session.close();
  });
});
