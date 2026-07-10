import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteNode, NotesStore, NotesWorkspace } from "../../domain/notes";
import { useNotesWorkspace } from "./useNotesWorkspace";

const createNoteIdMock = vi.hoisted(() => vi.fn());

vi.mock("../../domain/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../domain/notes")>()),
  createNoteId: createNoteIdMock
}));

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

function strictMode({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
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
    duplicateNode: empty,
    removeEmptyNode: empty,
    softDeleteNode: empty,
    restoreNode: empty,
    emptyTrash: empty,
    ...overrides
  };
}

describe("useNotesWorkspace", () => {
  beforeEach(() => {
    createNoteIdMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes and loads once for each vault and repository identity", async () => {
    const store = repository();
    const { rerender } = renderHook(
      ({ vaultRoot, repository: current }) => useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/vault-a", repository: store } }
    );

    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledOnce());
    expect(store.initialize).toHaveBeenCalledWith("/vault-a");
    expect(store.loadWorkspace).toHaveBeenCalledWith("/vault-a", { kind: "active" });

    rerender({ vaultRoot: "/vault-a", repository: store });
    expect(store.loadWorkspace).toHaveBeenCalledOnce();

    rerender({ vaultRoot: "/vault-b", repository: store });
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledTimes(2));
    expect(store.initialize).toHaveBeenLastCalledWith("/vault-b");
  });

  it("deduplicates initialization and loading during StrictMode effect replay", async () => {
    const initialization = deferred<void>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });

    const { result } = renderHook(
      () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
      { wrapper: strictMode }
    );

    expect(store.initialize).toHaveBeenCalledOnce();
    await act(async () => initialization.resolve());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
  });

  it("does not load after initialization finishes for a canceled effect", async () => {
    const initialization = deferred<void>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });
    const { unmount } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    unmount();
    await act(async () => initialization.resolve());

    expect(store.loadWorkspace).not.toHaveBeenCalled();
  });

  it("replaces state with each authoritative command response and derives creation placement", async () => {
    createNoteIdMock.mockReturnValueOnce("new-root").mockReturnValueOnce("new-child");
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([
        node({ id: "first", sortKey: 1 }),
        node({ id: "last", sortKey: 2 }),
        node({ id: "parent", sortKey: 3 }),
        node({ id: "existing-child", parentId: "parent" })
      ])),
      createNode: vi
        .fn()
        .mockResolvedValueOnce(workspace([
          node({ id: "first", sortKey: 1 }),
          node({ id: "last", sortKey: 2 }),
          node({ id: "parent", sortKey: 3 }),
          node({ id: "existing-child", parentId: "parent" }),
          node({ id: "new-root", sortKey: 4 })
        ]))
        .mockResolvedValueOnce(workspace([
          node({ id: "parent" }),
          node({ id: "new-child", parentId: "parent" })
        ]))
    });
    const { result } = renderHook(() => useNotesWorkspace({ vaultRoot: "/vault", repository: store }));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.createRoot());
    expect(store.createNode).toHaveBeenNthCalledWith(1, "/vault", {
      id: "new-root",
      parentId: null,
      afterId: "parent",
      title: "",
      note: ""
    });
    expect(result.current.state.nodesById["new-root"]).toBeDefined();
    expect(result.current.state).toMatchObject({
      selectedId: "new-root",
      editingNoteId: "new-root",
      pendingFocusId: "new-root"
    });

    await act(async () => result.current.actions.createChild("parent"));
    expect(store.createNode).toHaveBeenNthCalledWith(2, "/vault", {
      id: "new-child",
      parentId: "parent",
      afterId: "existing-child",
      title: "",
      note: ""
    });
    expect(result.current.state.childIdsByParent.parent).toEqual(["new-child"]);
    expect(result.current.state).toMatchObject({
      selectedId: "new-child",
      editingNoteId: "new-child",
      pendingFocusId: "new-child"
    });
  });

  it("does not let an older initial load overwrite a newer command", async () => {
    const initialLoad = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi.fn().mockReturnValue(initialLoad.promise),
      updateNode: vi.fn().mockResolvedValue(workspace([node({ id: "command" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledOnce());
    await act(async () =>
      result.current.actions.updateNode("root", { title: "new", note: "" })
    );
    expect(result.current.state.nodesById.command).toBeDefined();

    await act(async () => initialLoad.resolve(workspace([node({ id: "load" })])));

    expect(result.current.state.nodesById.command).toBeDefined();
    expect(result.current.state.nodesById.load).toBeUndefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("does not let an older command success overwrite a newer command", async () => {
    const older = deferred<NotesWorkspace>();
    const newer = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let olderCommand!: Promise<void>;
    let newerCommand!: Promise<void>;
    act(() => {
      olderCommand = result.current.actions.updateNode("root", {
        title: "older",
        note: ""
      });
      newerCommand = result.current.actions.updateNode("root", {
        title: "newer",
        note: ""
      });
    });

    await act(async () => {
      newer.resolve(workspace([node({ id: "newer" })]));
      await newerCommand;
    });
    await act(async () => {
      older.resolve(workspace([node({ id: "older" })]));
      await olderCommand;
    });

    expect(result.current.state.nodesById.newer).toBeDefined();
    expect(result.current.state.nodesById.older).toBeUndefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("does not let an older command error overwrite a newer command", async () => {
    const older = deferred<NotesWorkspace>();
    const newer = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let olderCommand!: Promise<void>;
    let newerCommand!: Promise<void>;
    act(() => {
      olderCommand = result.current.actions.updateNode("root", {
        title: "older",
        note: ""
      });
      newerCommand = result.current.actions.updateNode("root", {
        title: "newer",
        note: ""
      });
    });

    await act(async () => {
      newer.resolve(workspace([node({ id: "newer" })]));
      await newerCommand;
    });
    await act(async () => {
      older.reject(new Error("older failed"));
      await olderCommand;
    });

    expect(result.current.state.nodesById.newer).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("clears old placement state across an identity transition and failed load", async () => {
    createNoteIdMock.mockReturnValue("new-vault-root");
    const oldStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "old-root" })]))
    });
    const newStore = repository({
      loadWorkspace: vi.fn().mockRejectedValue(new Error("new vault failed")),
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "new-vault-root" })]))
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, repository: current }) =>
        useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/old", repository: oldStore } }
    );
    await waitFor(() => expect(result.current.state.nodesById["old-root"]).toBeDefined());

    rerender({ vaultRoot: "/new", repository: newStore });

    expect(result.current.status).toBe("loading");
    expect(result.current.state.rootIds).toEqual([]);
    expect(result.current.state.nodesById["old-root"]).toBeUndefined();
    await waitFor(() => expect(result.current.error).toBe("new vault failed"));
    expect(result.current.state.rootIds).toEqual([]);

    await act(async () => result.current.actions.createRoot());
    expect(newStore.createNode).toHaveBeenCalledWith("/new", {
      id: "new-vault-root",
      parentId: null,
      afterId: null,
      title: "",
      note: ""
    });
  });

  it("delegates every remaining action to NotesStore and preserves confirmed nodes on errors", async () => {
    const after = workspace([node({ id: "root" }), node({ id: "child", parentId: "root" })]);
    const updateNodeMock = vi.fn().mockResolvedValue(after);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(after),
      updateNode: updateNodeMock,
      splitNode: vi.fn().mockResolvedValue(after),
      moveNode: vi.fn().mockResolvedValue(after),
      toggleComplete: vi.fn().mockResolvedValue(after),
      toggleCollapsed: vi.fn().mockResolvedValue(after),
      duplicateNode: vi.fn().mockResolvedValue(after),
      removeEmptyNode: vi.fn().mockResolvedValue(after),
      softDeleteNode: vi.fn().mockResolvedValue(after),
      restoreNode: vi.fn().mockResolvedValue(after)
    });
    const { result } = renderHook(() => useNotesWorkspace({ vaultRoot: "/vault", repository: store }));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.updateNode("root", { title: "Title", note: "Note" }));
    await act(async () => result.current.actions.splitNode("root", "split", "pre", "post"));
    await act(async () => result.current.actions.moveNode({ id: "child", parentId: null, afterId: "root" }));
    await act(async () => result.current.actions.toggleComplete("root"));
    await act(async () => result.current.actions.toggleCollapsed("root"));
    await act(async () => result.current.actions.duplicateNode("root"));
    await act(async () => result.current.actions.removeEmptyNode("child"));
    await act(async () => result.current.actions.deleteNode("root"));
    await act(async () => result.current.actions.restoreNode("root"));

    expect(store.updateNode).toHaveBeenCalledWith("/vault", { id: "root", title: "Title", note: "Note" });
    expect(store.splitNode).toHaveBeenCalledWith("/vault", { id: "root", newNodeId: "split", prefix: "pre", suffix: "post" });
    expect(store.moveNode).toHaveBeenCalledWith("/vault", { id: "child", parentId: null, afterId: "root" });
    expect(store.toggleComplete).toHaveBeenCalledWith("/vault", "root");
    expect(store.toggleCollapsed).toHaveBeenCalledWith("/vault", "root");
    expect(store.duplicateNode).toHaveBeenCalledWith("/vault", "root");
    expect(store.removeEmptyNode).toHaveBeenCalledWith("/vault", "child");
    expect(store.softDeleteNode).toHaveBeenCalledWith("/vault", "root");
    expect(store.restoreNode).toHaveBeenCalledWith("/vault", "root");

    updateNodeMock.mockRejectedValueOnce(new Error("write failed"));
    await act(async () => result.current.actions.updateNode("root", { title: "Again", note: "" }));
    expect(result.current.error).toBe("write failed");
    expect(result.current.state.nodesById.root).toBeDefined();
  });

  it("ignores a stale load after the vault changes", async () => {
    let resolveFirst: (value: NotesWorkspace) => void = () => {};
    const firstLoad = new Promise<NotesWorkspace>((resolve) => {
      resolveFirst = resolve;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation((vaultRoot: string) =>
        vaultRoot === "/old" ? firstLoad : Promise.resolve(workspace([node({ id: "new" })]))
      )
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );

    rerender({ vaultRoot: "/new" });
    await waitFor(() => expect(result.current.state.nodesById.new).toBeDefined());
    await act(async () => resolveFirst(workspace([node({ id: "old" })])));
    expect(result.current.state.nodesById.old).toBeUndefined();
  });

  it("does not publish deferred load or command completions after unmount", async () => {
    const load = deferred<NotesWorkspace>();
    const loadingStore = repository({ loadWorkspace: vi.fn().mockReturnValue(load.promise) });
    const loadingHook = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/loading", repository: loadingStore })
    );
    await waitFor(() => expect(loadingStore.loadWorkspace).toHaveBeenCalledOnce());
    loadingHook.unmount();

    await act(async () => load.resolve(workspace([node({ id: "late-load" })])));
    expect(loadingHook.result.current.state.nodesById["late-load"]).toBeUndefined();

    const command = deferred<NotesWorkspace>();
    const commandStore = repository({ updateNode: vi.fn().mockReturnValue(command.promise) });
    const commandHook = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/command", repository: commandStore })
    );
    await waitFor(() => expect(commandHook.result.current.status).toBe("ready"));
    let completion!: Promise<void>;
    act(() => {
      completion = commandHook.result.current.actions.updateNode("root", {
        title: "late",
        note: ""
      });
    });
    commandHook.unmount();

    await act(async () => {
      command.resolve(workspace([node({ id: "late-command" })]));
      await completion;
    });
    expect(commandHook.result.current.state.nodesById["late-command"]).toBeUndefined();
  });
});
