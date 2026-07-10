import { act, renderHook, waitFor } from "@testing-library/react";
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
          node({ id: "authoritative-root", sortKey: 4 })
        ]))
        .mockResolvedValueOnce(workspace([node({ id: "parent" }), node({ id: "authoritative-child", parentId: "parent" })]))
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
    expect(result.current.state.nodesById["authoritative-root"]).toBeDefined();

    await act(async () => result.current.actions.createChild("parent"));
    expect(store.createNode).toHaveBeenNthCalledWith(2, "/vault", {
      id: "new-child",
      parentId: "parent",
      afterId: "existing-child",
      title: "",
      note: ""
    });
    expect(result.current.state.childIdsByParent.parent).toEqual(["authoritative-child"]);
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

  it("ignores a stale load after the vault changes or the hook unmounts", async () => {
    let resolveFirst: (value: NotesWorkspace) => void = () => {};
    const firstLoad = new Promise<NotesWorkspace>((resolve) => {
      resolveFirst = resolve;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation((vaultRoot: string) =>
        vaultRoot === "/old" ? firstLoad : Promise.resolve(workspace([node({ id: "new" })]))
      )
    });
    const { result, rerender, unmount } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );

    rerender({ vaultRoot: "/new" });
    await waitFor(() => expect(result.current.state.nodesById.new).toBeDefined());
    await act(async () => resolveFirst(workspace([node({ id: "old" })])));
    expect(result.current.state.nodesById.old).toBeUndefined();

    unmount();
    await act(async () => resolveFirst(workspace([node({ id: "later" })])));
  });
});
