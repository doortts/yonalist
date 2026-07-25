import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteNode, NotesStore, NotesWorkspace } from "../../domain/notes";

const onCloseRequested = vi.hoisted(() => vi.fn());
const destroy = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested, destroy })
}));

import { useFlushDraftsOnWindowClose } from "./useFlushDraftsOnWindowClose";
import {
  acquireNotesVaultDrain,
  registerNotesVaultDrain,
  resetNotesVaultDrainRegistryForTests,
  type NotesVaultDrainLease,
} from "./notesVaultDrain";
import { createNotesExpansionSnapshotPool } from "./notesHistory";
import { createNotesWorkspaceCoordinatorRegistry } from "./notesWorkspaceCoordinator";

function Harness({
  vaultRoot = "/vault",
  acquire,
  syncFlush,
}: {
  vaultRoot?: string | null;
  acquire: (vaultRoot: string) => Promise<NotesVaultDrainLease | null>;
  syncFlush?: (vaultRoot: string) => Promise<void>;
}) {
  useFlushDraftsOnWindowClose(vaultRoot, acquire, syncFlush);
  return null;
}

function lease(
  vaultRoot = "/vault",
  generation = 1,
) {
  return {
    vaultRoot,
    generation,
    commit: vi.fn(() => {}),
    release: vi.fn(() => {}),
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function workspaceNode(): NoteNode {
  return {
    id: "root",
    nodeKind: "text",
    parentId: null,
    sortKey: 1024,
    title: "Root",
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-25T00:00:00Z",
    updatedAt: "2026-07-25T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    markerKind: "bullet",
    markdownImageWidth: null,
  };
}

function coordinatorStore(): NotesStore {
  const loaded: NotesWorkspace = { nodes: [workspaceNode()] };
  return {
    initialize: vi.fn().mockResolvedValue({
      canUndo: false,
      canRedo: false,
      historyEpoch: "epoch-a",
      nextUndoEntryId: null,
      nextRedoEntryId: null,
      prunedEntryIds: [],
    }),
    loadWorkspace: vi.fn().mockResolvedValue(loaded),
  } as unknown as NotesStore;
}

function setTauriRuntime(present: boolean): void {
  if (present) {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
  } else {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  }
}

describe("useFlushDraftsOnWindowClose", () => {
  beforeEach(() => {
    onCloseRequested.mockReset();
    destroy.mockReset();
    unlisten.mockReset();
    onCloseRequested.mockImplementation(() => Promise.resolve(unlisten));
    destroy.mockResolvedValue(undefined);
    setTauriRuntime(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    setTauriRuntime(false);
    resetNotesVaultDrainRegistryForTests();
  });

  it("prevents the default close, flushes drafts, then destroys the window", async () => {
    const acquired = lease();
    const acquire = vi.fn().mockResolvedValue(acquired);
    await act(async () => {
      render(<Harness acquire={acquire} />);
      await flushMicrotasks();
    });

    expect(onCloseRequested).toHaveBeenCalledTimes(1);
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;
    const event = { preventDefault: vi.fn() };

    await act(async () => {
      await handler(event);
    });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith("/vault");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(acquired.commit).toHaveBeenCalledOnce();
    expect(acquired.release).not.toHaveBeenCalled();
  });

  it("flushes the sync exporter after draining drafts, before destroying", async () => {
    // Capture the close handler and record ordering without any mock-order
    // introspection, to respect the notes test-order budget.
    const order: string[] = [];
    let handler:
      | ((event: { preventDefault: () => void }) => Promise<void>)
      | undefined;
    onCloseRequested.mockImplementation((cb: typeof handler) => {
      handler = cb;
      return Promise.resolve(unlisten);
    });
    destroy.mockImplementation(async () => {
      order.push("destroy");
    });
    const acquired = lease();
    const acquire = vi.fn(async () => {
      order.push("flush");
      return acquired;
    });
    const syncFlush = vi.fn(async () => {
      order.push("sync");
    });
    await act(async () => {
      render(<Harness acquire={acquire} syncFlush={syncFlush} />);
      await flushMicrotasks();
    });

    await act(async () => {
      await handler!({ preventDefault: vi.fn() });
    });

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(syncFlush).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["flush", "sync", "destroy"]);
  });

  it("keeps the window open when the sync export flush fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let handler:
      | ((event: { preventDefault: () => void }) => Promise<void>)
      | undefined;
    onCloseRequested.mockImplementation((cb: typeof handler) => {
      handler = cb;
      return Promise.resolve(unlisten);
    });
    const acquired = lease();
    const acquire = vi.fn().mockResolvedValue(acquired);
    const syncFlush = vi
      .fn()
      .mockRejectedValue(new Error("exporter unavailable"));
    await act(async () => {
      render(<Harness acquire={acquire} syncFlush={syncFlush} />);
      await flushMicrotasks();
    });

    await act(async () => {
      await handler!({ preventDefault: vi.fn() });
    });

    expect(syncFlush).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(acquired.release).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Notes sync export flush before close failed",
      expect.any(Error)
    );
    error.mockRestore();
  });

  it("releases a successful drain after sync failure and drains again on retry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const firstLease = lease("/vault", 1);
    const secondLease = lease("/vault", 2);
    const acquire = vi.fn()
      .mockResolvedValueOnce(firstLease)
      .mockResolvedValueOnce(secondLease);
    const syncFlush = vi
      .fn()
      .mockRejectedValueOnce(new Error("exporter unavailable"))
      .mockResolvedValueOnce(undefined);
    await act(async () => {
      render(<Harness acquire={acquire} syncFlush={syncFlush} />);
      await flushMicrotasks();
    });
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;

    await act(async () => {
      await handler({ preventDefault: vi.fn() });
    });
    expect(firstLease.release).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();

    await act(async () => {
      await handler({ preventDefault: vi.fn() });
    });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(syncFlush).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
    expect(secondLease.commit).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("releases a successful drain when destroying the window fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const acquired = lease();
    destroy.mockRejectedValueOnce(new Error("window stayed open"));
    await act(async () => {
      render(<Harness acquire={vi.fn().mockResolvedValue(acquired)} />);
      await flushMicrotasks();
    });
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;

    await act(async () => {
      await handler({ preventDefault: vi.fn() });
    });

    expect(acquired.release).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("keeps the window open after ten seconds while a drain is pending", async () => {
    vi.useFakeTimers();
    const acquire = vi
      .fn()
      .mockReturnValue(new Promise<NotesVaultDrainLease | null>(() => {}));
    await act(async () => {
      render(<Harness acquire={acquire} />);
      await flushMicrotasks();
    });

    const handler = onCloseRequested.mock.calls[0][0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;
    const event = { preventDefault: vi.fn() };
    const settled = handler(event);

    await flushMicrotasks();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(destroy).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    void settled;
  });

  it("keeps the window open when the drain reports incomplete", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const acquire = vi.fn().mockResolvedValue(null);
    await act(async () => {
      render(<Harness acquire={acquire} />);
      await flushMicrotasks();
    });

    const handler = onCloseRequested.mock.calls[0][0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;

    await act(async () => {
      await handler({ preventDefault: vi.fn() });
    });

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not persist")
    );
    warn.mockRestore();
  });

  it("keeps the window open when the drain rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("write queue exploded");
    const acquire = vi.fn().mockRejectedValue(failure);
    await act(async () => {
      render(<Harness acquire={acquire} />);
      await flushMicrotasks();
    });

    const handler = onCloseRequested.mock.calls[0][0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;

    await act(async () => {
      await handler({ preventDefault: vi.fn() });
    });

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Notes draft flush before close failed",
      failure
    );
    error.mockRestore();
  });

  it("snapshots the Vault root and callbacks before the first close await", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = deferred<NotesVaultDrainLease | null>();
    const oldLease = lease("/vault-a", 1);
    const acquireOld = vi.fn(() => pending.promise);
    const acquireNew = vi.fn().mockResolvedValue(lease("/vault-b", 1));
    const syncOld = vi.fn().mockResolvedValue(undefined);
    const syncNew = vi.fn().mockResolvedValue(undefined);
    destroy.mockRejectedValueOnce(new Error("window stayed open"));
    let rerender!: ReturnType<typeof render>["rerender"];
    await act(async () => {
      ({ rerender } = render(
        <Harness
          vaultRoot="/vault-a"
          acquire={acquireOld}
          syncFlush={syncOld}
        />,
      ));
      await flushMicrotasks();
    });
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;

    const closing = handler({ preventDefault: vi.fn() });
    rerender(
      <Harness
        vaultRoot="/vault-b"
        acquire={acquireNew}
        syncFlush={syncNew}
      />,
    );
    pending.resolve(oldLease);
    await act(async () => {
      await closing;
    });

    expect(acquireOld).toHaveBeenCalledWith("/vault-a");
    expect(syncOld).toHaveBeenCalledWith("/vault-a");
    expect(acquireNew).not.toHaveBeenCalled();
    expect(syncNew).not.toHaveBeenCalled();
    expect(oldLease.release).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("keeps the coordinator locked through sync and destroy when a concurrent B→A cancellation releases only its leases", async () => {
    const vaultRoot = "/composed-close";
    const draftBarrier = deferred<boolean>();
    const sync = deferred<void>();
    const destroying = deferred<void>();
    destroy.mockReturnValue(destroying.promise);
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const session = registry.openSession({
      repository: coordinatorStore(),
      vaultRoot,
      onEvent: vi.fn(),
      presentation: "writable",
      captureDraftCutoff: () => 1,
      beforeStructural: () => draftBarrier.promise,
      captureHistoryLocation: () => ({
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        selectedId: "root",
        zoomRootId: "root",
        expansion: pool.acquire(["root"]),
        focus: { nodeId: "root", field: "title" },
      }),
      applyHistoryLocation: () => true,
    });
    await session.activation;
    const physicalDrain = vi.fn(() => session.drain());
    const unregister = registerNotesVaultDrain(vaultRoot, {
      drain: physicalDrain,
      releaseDrain: () => session.releaseDrain(),
    });
    const syncFlush = vi.fn(() => sync.promise);
    await act(async () => {
      render(
        <Harness
          vaultRoot={vaultRoot}
          acquire={acquireNotesVaultDrain}
          syncFlush={syncFlush}
        />,
      );
      await flushMicrotasks();
    });
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;

    const switchToB = acquireNotesVaultDrain(vaultRoot);
    const closing = handler({ preventDefault: vi.fn() });
    const returnToA = acquireNotesVaultDrain(vaultRoot);
    expect(physicalDrain).toHaveBeenCalledOnce();
    draftBarrier.resolve(true);
    const [switchLease, cancellationLease] = await Promise.all([
      switchToB,
      returnToA,
    ]);
    await vi.waitFor(() => expect(syncFlush).toHaveBeenCalledWith(vaultRoot));

    switchLease!.release();
    cancellationLease!.release();
    expect(session.isLifecycleDraining()).toBe(true);
    const duringSync = vi.fn(() => ({ kind: "skipped" as const }));
    await expect(session.enqueue(duringSync)).resolves.toBe("skipped");
    expect(duringSync).not.toHaveBeenCalled();

    sync.resolve();
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    expect(session.isLifecycleDraining()).toBe(true);
    destroying.resolve();
    await act(async () => {
      await closing;
    });
    expect(session.isLifecycleDraining()).toBe(true);

    unregister();
    session.close();
    expect(session.isLifecycleDraining()).toBe(false);
  });

  it("prevents every simultaneous request and shares one drain", async () => {
    const pending = deferred<NotesVaultDrainLease | null>();
    const acquire = vi.fn(() => pending.promise);
    await act(async () => {
      render(<Harness acquire={acquire} />);
      await flushMicrotasks();
    });
    const handler = onCloseRequested.mock.calls[0][0] as (event: {
      preventDefault: () => void;
    }) => Promise<void>;
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    const first = handler(firstEvent);
    const second = handler(secondEvent);
    await flushMicrotasks();

    expect(first).toBe(second);
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    pending.resolve(lease());
    await act(async () => {
      await first;
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("does nothing outside a Tauri runtime", async () => {
    setTauriRuntime(false);
    const acquire = vi.fn().mockResolvedValue(lease());

    await act(async () => {
      render(<Harness acquire={acquire} />);
      await flushMicrotasks();
    });

    expect(onCloseRequested).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("unlistens the close handler on unmount", async () => {
    const acquire = vi.fn().mockResolvedValue(lease());
    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = render(<Harness acquire={acquire} />));
      await flushMicrotasks();
    });
    expect(onCloseRequested).toHaveBeenCalledTimes(1);

    await act(async () => {
      unmount();
      await flushMicrotasks();
    });

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
