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
    toggleComplete: empty,
    toggleCollapsed: empty,
    toggleStar: empty,
    duplicateNode: empty,
    removeEmptyNode: empty,
    softDeleteNode: empty,
    restoreNode: empty,
    archiveNode: empty,
    unarchiveNode: empty,
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
    deleteDatabase: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("notesWorkspaceCoordinator registry", () => {
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
});
