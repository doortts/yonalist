import { act, render, renderHook, waitFor } from "@testing-library/react";
import {
  StrictMode,
  Suspense,
  useEffect,
  useLayoutEffect,
  type PropsWithChildren
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteNode, NotesStore, NotesWorkspace } from "../../domain/notes";
import {
  useNotesWorkspace,
  type NotesWorkspaceActions,
  type UseNotesWorkspaceResult
} from "./useNotesWorkspace";

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

function strictMode({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

function suspenseMode({ children }: PropsWithChildren) {
  return <Suspense fallback={null}>{children}</Suspense>;
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

function historyContext(commandKind: string) {
  return expect.objectContaining({
    sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    entryId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    commandKind
  });
}

interface StartupCommandProps {
  actions: NotesWorkspaceActions;
  identity: string;
  onCompletion(completion: Promise<void>): void;
}

function LayoutStartupCommand({
  actions,
  identity,
  onCompletion
}: StartupCommandProps) {
  useLayoutEffect(() => {
    onCompletion(actions.createRoot());
  }, [actions, identity, onCompletion]);
  return null;
}

function PassiveStartupCommand({
  actions,
  identity,
  onCompletion
}: StartupCommandProps) {
  useEffect(() => {
    onCompletion(actions.createRoot());
  }, [actions, identity, onCompletion]);
  return null;
}

interface StartupHarnessProps {
  effect: "layout" | "passive";
  repository: NotesStore;
  vaultRoot: string;
  onCompletion(completion: Promise<void>): void;
  onWorkspace(workspace: UseNotesWorkspaceResult): void;
}

function StartupHarness({
  effect,
  repository: store,
  vaultRoot,
  onCompletion,
  onWorkspace
}: StartupHarnessProps) {
  const current = useNotesWorkspace({ vaultRoot, repository: store });
  onWorkspace(current);
  const Command = effect === "layout" ? LayoutStartupCommand : PassiveStartupCommand;
  return (
    <Command
      actions={current.actions}
      identity={vaultRoot}
      onCompletion={onCompletion}
    />
  );
}

describe("useNotesWorkspace", () => {
  beforeEach(() => {
    createNoteIdMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("exposes loading on the first render before the workspace effect runs", async () => {
    const initialization = deferred<void>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });
    const renderedStatuses: string[] = [];
    const { result } = renderHook(() => {
      const workspace = useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store
      });
      renderedStatuses.push(workspace.status);
      return workspace;
    });

    expect(renderedStatuses[0]).toBe("loading");

    await act(async () => initialization.resolve());
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it.each(["layout", "passive"] as const)(
    "flushes a child %s-effect command through the session after loading",
    async (effect) => {
      const initialization = deferred<void>();
      createNoteIdMock.mockReturnValue("pre-session-root");
      const store = repository({
        initialize: vi.fn().mockReturnValue(initialization.promise),
        loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
        createNode: vi
          .fn()
          .mockResolvedValue(workspace([node({ id: "pre-session-root" })]))
      });
      const completions: Promise<void>[] = [];
      let latestWorkspace: UseNotesWorkspaceResult | undefined;
      render(
        <StartupHarness
          effect={effect}
          repository={store}
          vaultRoot="/vault"
          onCompletion={(completion) => completions.push(completion)}
          onWorkspace={(current) => {
            latestWorkspace = current;
          }}
        />
      );

      expect(store.createNode).not.toHaveBeenCalled();

      await act(async () => initialization.resolve());
      await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
      await act(async () => Promise.all(completions));

      expect(store.createNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "pre-session-root",
          parentId: null,
          afterId: null,
          title: "",
          note: ""
        },
        historyContext("create")
      );
      expect(
        latestWorkspace?.state.nodesById["pre-session-root"]
      ).toBeDefined();
      expect(latestWorkspace?.status).toBe("ready");
    }
  );

  it("does not duplicate a buffered child command during StrictMode replay", async () => {
    const initialization = deferred<void>();
    createNoteIdMock.mockReturnValue("strict-root");
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise),
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "strict-root" })]))
    });
    const completions: Promise<void>[] = [];

    render(
      <StrictMode>
        <StartupHarness
          effect="layout"
          repository={store}
          vaultRoot="/vault"
          onCompletion={(completion) => completions.push(completion)}
          onWorkspace={() => undefined}
        />
      </StrictMode>
    );

    expect(store.initialize).toHaveBeenCalledOnce();
    await act(async () => initialization.resolve());
    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    await act(async () => Promise.all(completions));

    expect(completions).toHaveLength(2);
    expect(store.createNode).toHaveBeenCalledOnce();
  });

  it("routes a child layout-effect command after a vault change only to the new vault", async () => {
    const oldInitialization = deferred<void>();
    createNoteIdMock.mockReturnValue("new-vault-root");
    const store = repository({
      initialize: vi.fn((vaultRoot) =>
        vaultRoot === "/old" ? oldInitialization.promise : Promise.resolve()
      ),
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "new-vault-root" })]))
    });
    const completions: Promise<void>[] = [];
    const view = render(
      <StartupHarness
        effect="layout"
        repository={store}
        vaultRoot="/old"
        onCompletion={(completion) => completions.push(completion)}
        onWorkspace={() => undefined}
      />
    );

    view.rerender(
      <StartupHarness
        effect="layout"
        repository={store}
        vaultRoot="/new"
        onCompletion={(completion) => completions.push(completion)}
        onWorkspace={() => undefined}
      />
    );

    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    expect(store.createNode).toHaveBeenCalledWith(
      "/new",
      expect.objectContaining({ id: "new-vault-root" }),
      historyContext("create")
    );

    await act(async () => oldInitialization.resolve());
    await act(async () => Promise.all(completions));
    expect(store.createNode).toHaveBeenCalledOnce();
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

  it("handles a synchronous initialization throw without loading or an unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const store = repository({
      initialize: vi.fn(() => {
        throw new Error("initialize exploded");
      })
    });

    try {
      const { result } = renderHook(
        () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
        { wrapper: strictMode }
      );

      await waitFor(() => expect(result.current.error).toBe("initialize exploded"));
      await act(async () => Promise.resolve());

      expect(store.initialize).toHaveBeenCalledOnce();
      expect(store.loadWorkspace).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("runs a command only after initialization and loading, then retains the loaded tree on failure", async () => {
    const initialization = deferred<void>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise),
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "loaded" })])),
      updateNode: vi.fn().mockRejectedValue(new Error("write failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    expect(store.initialize).toHaveBeenCalledOnce();
    expect(store.loadWorkspace).not.toHaveBeenCalled();

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.updateNode("loaded", {
        title: "new",
        note: ""
      });
    });

    expect(result.current).toMatchObject({ status: "loading", error: null });
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(store.loadWorkspace).not.toHaveBeenCalled();

    await act(async () => initialization.resolve());
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledOnce());
    await act(async () => {
      await completion;
    });

    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(result.current.state.nodesById.loaded).toBeDefined();
    expect(result.current).toMatchObject({
      status: "error",
      error: "write failed"
    });
  });

  it("invokes initialization, loading, and commands in FIFO order", async () => {
    const initialization = deferred<void>();
    const initialLoad = deferred<NotesWorkspace>();
    const firstCommand = deferred<NotesWorkspace>();
    const secondCommand = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    const store = repository({
      initialize: vi.fn(() => {
        invocations.push("initialize");
        return initialization.promise;
      }),
      loadWorkspace: vi.fn(() => {
        invocations.push("load");
        return initialLoad.promise;
      }),
      updateNode: vi
        .fn((_vaultRoot, input) => {
          invocations.push(`update:${input.title}`);
          return input.title === "first"
            ? firstCommand.promise
            : secondCommand.promise;
        })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("initial", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("initial", {
        title: "second",
        note: ""
      });
    });

    expect(invocations).toEqual(["initialize"]);

    await act(async () => initialization.resolve());
    expect(invocations).toEqual(["initialize", "load"]);

    await act(async () =>
      initialLoad.resolve(workspace([node({ id: "initial" })]))
    );
    expect(invocations).toEqual(["initialize", "load", "update:first"]);
    expect(result.current.state.nodesById.initial).toBeDefined();
    expect(result.current.status).toBe("loading");

    await act(async () =>
      firstCommand.resolve(workspace([
        node({ id: "initial" }),
        node({ id: "first" })
      ]))
    );
    expect(invocations).toEqual([
      "initialize",
      "load",
      "update:first",
      "update:second"
    ]);
    expect(result.current.state.nodesById.first).toBeDefined();
    expect(result.current.state.nodesById.initial).toBeDefined();
    expect(result.current.status).toBe("loading");

    await act(async () => {
      secondCommand.resolve(workspace([node({ id: "second" })]));
      await Promise.all([firstCompletion, secondCompletion]);
    });
    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current.state.nodesById.first).toBeUndefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("keeps the first confirmed command workspace when the next command fails", async () => {
    const firstCommand = deferred<NotesWorkspace>();
    const secondCommand = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "initial" })])),
      updateNode: vi
        .fn()
        .mockReturnValueOnce(firstCommand.promise)
        .mockReturnValueOnce(secondCommand.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("initial", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("initial", {
        title: "second",
        note: ""
      });
    });

    await act(async () =>
      firstCommand.resolve(workspace([
        node({ id: "initial" }),
        node({ id: "first-confirmed" })
      ]))
    );
    await act(async () => {
      secondCommand.reject(new Error("second failed"));
      await Promise.all([firstCompletion, secondCompletion]);
    });

    expect(result.current.state.nodesById["first-confirmed"]).toBeDefined();
    expect(result.current.state.nodesById.initial).toBeDefined();
    expect(result.current).toMatchObject({
      status: "error",
      error: "second failed"
    });
  });

  it("blocks a compound split when its draft save fails", async () => {
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("save failed")),
      splitNode: vi.fn().mockResolvedValue(workspace([]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix",
        { draft: { title: "prefixsuffix", note: "saved note" } }
      );
    });
    await act(async () => {
      await expect(completion).resolves.toBeUndefined();
    });

    expect(store.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "root",
        title: "prefixsuffix",
        note: "saved note"
      },
      historyContext("text")
    );
    expect(store.splitNode).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.root.title).toBe("root");
    expect(result.current).toMatchObject({
      status: "error",
      error: "save failed"
    });
  });

  it("retains an authoritative draft when the later compound split fails", async () => {
    const saved = workspace([
      node({ id: "root", title: "prefixsuffix", note: "saved note" })
    ]);
    const store = repository({
      updateNode: vi.fn().mockResolvedValue(saved),
      splitNode: vi.fn().mockRejectedValue(new Error("split failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix",
        { draft: { title: "prefixsuffix", note: "saved note" } }
      )
    );

    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(store.splitNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "root",
        newNodeId: "split-child",
        prefix: "prefix",
        suffix: "suffix"
      },
      historyContext("split")
    );
    expect(result.current.state.nodesById.root).toMatchObject({
      title: "prefixsuffix",
      note: "saved note"
    });
    expect(result.current.state.pendingFocusId).toBeNull();
    expect(result.current).toMatchObject({
      status: "error",
      error: "split failed"
    });
  });

  it("expands a move target before moving and publishing focus", async () => {
    const expanded = deferred<NotesWorkspace>();
    const moved = deferred<NotesWorkspace>();
    const initial = workspace([
      node({ id: "first", sortKey: 1, isCollapsed: true }),
      node({ id: "hidden", parentId: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleCollapsed: vi.fn().mockReturnValue(expanded.promise),
      moveNode: vi.fn().mockReturnValue(moved.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.moveNode(
        { id: "second", parentId: "first", afterId: "hidden" },
        "second",
        { expandNodeId: "first" }
      );
    });
    await waitFor(() => expect(store.toggleCollapsed).toHaveBeenCalledOnce());
    expect(store.moveNode).not.toHaveBeenCalled();
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () =>
      expanded.resolve(
        workspace([
          node({ id: "first", sortKey: 1, isCollapsed: false }),
          node({ id: "hidden", parentId: "first", sortKey: 1 }),
          node({ id: "second", sortKey: 2 })
        ])
      )
    );
    await waitFor(() => expect(store.moveNode).toHaveBeenCalledOnce());
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () => {
      moved.resolve(
        workspace([
          node({ id: "first", sortKey: 1, isCollapsed: false }),
          node({ id: "hidden", parentId: "first", sortKey: 1 }),
          node({ id: "second", parentId: "first", sortKey: 2 })
        ])
      );
      await completion;
    });
    expect(result.current.state).toMatchObject({
      selectedId: "second",
      editingNoteId: "second",
      pendingFocusId: "second"
    });
  });

  it("skips a queued move when its before sibling is missing", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: vi.fn().mockResolvedValue(initial)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.moveNode({
        id: "child",
        parentId: null,
        afterId: null,
        beforeId: "missing"
      })
    );

    expect(store.moveNode).not.toHaveBeenCalled();
  });

  it("does not launch loading or queued commands after unmount during initialization", async () => {
    const initialization = deferred<void>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });
    const { result, unmount } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.updateNode("root", {
        title: "late",
        note: ""
      });
    });
    unmount();
    await act(async () => {
      initialization.resolve();
      await completion;
    });

    expect(store.loadWorkspace).not.toHaveBeenCalled();
    expect(store.updateNode).not.toHaveBeenCalled();
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
    expect(store.createNode).toHaveBeenNthCalledWith(
      1,
      "/vault",
      {
        id: "new-root",
        parentId: null,
        afterId: "parent",
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(result.current.state.nodesById["new-root"]).toBeDefined();
    expect(result.current.state).toMatchObject({
      selectedId: "new-root",
      editingNoteId: "new-root",
      pendingFocusId: "new-root"
    });

    await act(async () => result.current.actions.createChild("parent"));
    expect(store.createNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "new-child",
        parentId: "parent",
        afterId: "existing-child",
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(result.current.state.childIdsByParent.parent).toEqual(["new-child"]);
    expect(result.current.state).toMatchObject({
      selectedId: "new-child",
      editingNoteId: "new-child",
      pendingFocusId: "new-child"
    });
  });

  it("acknowledges matching pending focus through a command-neutral public promise", async () => {
    createNoteIdMock.mockReturnValue("created");
    const store = repository({
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "created", title: "" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.createRoot());
    expect(result.current.state.pendingFocusId).toBe("created");

    expect(result.current.actions.acknowledgeFocus).toEqual(
      expect.any(Function)
    );
    let acknowledgement!: Promise<void>;
    act(() => {
      acknowledgement = result.current.actions.acknowledgeFocus("created");
    });
    expect(acknowledgement).toBeInstanceOf(Promise);
    await act(async () => acknowledgement);

    expect(result.current.state.pendingFocusId).toBeNull();
    expect(store.createNode).toHaveBeenCalledOnce();
    expect(store.updateNode).not.toHaveBeenCalled();
  });

  it("focuses an existing node without enqueueing a repository command", async () => {
    const store = repository();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.focusNode("root"));

    expect(result.current.state).toMatchObject({
      selectedId: "root",
      editingNoteId: "root",
      pendingFocusId: "root"
    });
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(store.moveNode).not.toHaveBeenCalled();
  });

  it("publishes a move focus target only after authoritative success", async () => {
    const moved = deferred<NotesWorkspace>();
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: vi.fn().mockReturnValue(moved.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.moveNode(
        { id: "child", parentId: null, afterId: "root" },
        "child"
      );
    });
    await waitFor(() => expect(store.moveNode).toHaveBeenCalledOnce());
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () => {
      moved.resolve(initial);
      await completion;
    });
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      editingNoteId: "child",
      pendingFocusId: "child"
    });
  });

  it("does not publish a move focus target when the command fails", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: vi.fn().mockRejectedValue(new Error("move failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.moveNode(
        { id: "child", parentId: null, afterId: "root" },
        "child"
      )
    );

    expect(result.current.state.pendingFocusId).toBeNull();
    expect(result.current).toMatchObject({
      status: "error",
      error: "move failed"
    });
  });

  it("publishes a remove focus target only after authoritative success", async () => {
    const removed = deferred<NotesWorkspace>();
    const initial = workspace([
      node({ id: "first" }),
      node({ id: "empty", sortKey: 2, title: "" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      removeEmptyNode: vi.fn().mockReturnValue(removed.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.removeEmptyNode("empty", "first");
    });
    await waitFor(() => expect(store.removeEmptyNode).toHaveBeenCalledOnce());
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () => {
      removed.resolve(workspace([node({ id: "first" })]));
      await completion;
    });
    expect(result.current.state).toMatchObject({
      selectedId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
  });

  it("does not publish a remove focus target when the command fails", async () => {
    const initial = workspace([
      node({ id: "first" }),
      node({ id: "empty", sortKey: 2, title: "" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      removeEmptyNode: vi.fn().mockRejectedValue(new Error("remove failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.removeEmptyNode("empty", "first")
    );

    expect(result.current.state.pendingFocusId).toBeNull();
    expect(result.current).toMatchObject({
      status: "error",
      error: "remove failed"
    });
  });

  it("publishes two successful commands in invocation order", async () => {
    const first = deferred<NotesWorkspace>();
    const second = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
    });

    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    await act(async () => {
      first.resolve(workspace([node({ id: "root" }), node({ id: "first" })]));
      await firstCompletion;
    });
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(result.current.state.nodesById.first).toBeDefined();
    expect(result.current.status).toBe("loading");

    await act(async () => {
      second.resolve(workspace([node({ id: "second" })]));
      await secondCompletion;
    });

    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current.state.nodesById.first).toBeUndefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("continues from a failed command to a later successful command", async () => {
    const first = deferred<NotesWorkspace>();
    const second = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
    });

    await act(async () => {
      first.reject(new Error("first failed"));
      await firstCompletion;
    });
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(result.current.state.nodesById.root).toBeDefined();
    expect(result.current).toMatchObject({
      status: "loading",
      error: "first failed"
    });

    await act(async () => {
      second.resolve(workspace([node({ id: "second" })]));
      await secondCompletion;
    });

    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("derives rapid creation placement when each queued command starts", async () => {
    createNoteIdMock
      .mockReturnValueOnce("new-root-1")
      .mockReturnValueOnce("new-root-2");
    const first = deferred<NotesWorkspace>();
    const second = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "initial", sortKey: 1 })])),
      createNode: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.createRoot();
      secondCompletion = result.current.actions.createRoot();
    });

    expect(createNoteIdMock).toHaveBeenCalledOnce();
    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    expect(store.createNode).toHaveBeenNthCalledWith(
      1,
      "/vault",
      {
        id: "new-root-1",
        parentId: null,
        afterId: "initial",
        title: "",
        note: ""
      },
      historyContext("create")
    );

    await act(async () =>
      first.resolve(workspace([
        node({ id: "initial", sortKey: 1 }),
        node({ id: "new-root-1", sortKey: 2 })
      ]))
    );
    expect(createNoteIdMock).toHaveBeenCalledTimes(2);
    expect(store.createNode).toHaveBeenCalledTimes(2);
    expect(store.createNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "new-root-2",
        parentId: null,
        afterId: "new-root-1",
        title: "",
        note: ""
      },
      historyContext("create")
    );

    await act(async () => {
      second.resolve(workspace([
        node({ id: "initial", sortKey: 1 }),
        node({ id: "new-root-1", sortKey: 2 }),
        node({ id: "new-root-2", sortKey: 3 })
      ]));
      await Promise.all([firstCompletion, secondCompletion]);
    });
  });

  it("derives a queued child creation from a parent created by prior work", async () => {
    createNoteIdMock
      .mockReturnValueOnce("new-parent")
      .mockReturnValueOnce("new-child");
    const parentCreation = deferred<NotesWorkspace>();
    const childCreation = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi
        .fn()
        .mockReturnValueOnce(parentCreation.promise)
        .mockReturnValueOnce(childCreation.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let parentCompletion!: Promise<void>;
    let childCompletion!: Promise<void>;
    act(() => {
      parentCompletion = result.current.actions.createRoot();
      childCompletion = result.current.actions.createChild("new-parent");
    });

    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    await act(async () =>
      parentCreation.resolve(workspace([node({ id: "new-parent" })]))
    );
    expect(store.createNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "new-child",
        parentId: "new-parent",
        afterId: null,
        title: "",
        note: ""
      },
      historyContext("create")
    );

    await act(async () => {
      childCreation.resolve(workspace([
        node({ id: "new-parent" }),
        node({ id: "new-child", parentId: "new-parent" })
      ]));
      await Promise.all([parentCompletion, childCompletion]);
    });
  });

  it("detects a duplicate against the confirmed workspace at queue start", async () => {
    createNoteIdMock.mockReturnValue("new-root");
    const create = deferred<NotesWorkspace>();
    const duplicate = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "source", sortKey: 1 })])),
      createNode: vi.fn().mockReturnValue(create.promise),
      duplicateNode: vi.fn().mockReturnValue(duplicate.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let createCompletion!: Promise<void>;
    let duplicateCompletion!: Promise<void>;
    act(() => {
      createCompletion = result.current.actions.createRoot();
      duplicateCompletion = result.current.actions.duplicateNode("source");
    });

    expect(store.duplicateNode).not.toHaveBeenCalled();
    await act(async () =>
      create.resolve(workspace([
        node({ id: "source", sortKey: 1 }),
        node({ id: "new-root", sortKey: 2 })
      ]))
    );
    expect(store.duplicateNode).toHaveBeenCalledWith(
      "/vault",
      "source",
      historyContext("duplicate")
    );

    await act(async () => {
      duplicate.resolve(workspace([
        node({ id: "source", sortKey: 1 }),
        node({ id: "new-root", sortKey: 2 }),
        node({ id: "duplicate", sortKey: 3 })
      ]));
      await Promise.all([createCompletion, duplicateCompletion]);
    });

    expect(result.current.state).toMatchObject({
      selectedId: "duplicate",
      editingNoteId: "duplicate",
      pendingFocusId: "duplicate"
    });
  });

  it("continues after a synchronous command throw and resolves public promises", async () => {
    const store = repository({
      updateNode: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("synchronous failure");
        })
        .mockResolvedValueOnce(workspace([node({ id: "second" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    let zoomCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
      zoomCompletion = result.current.actions.zoomTo("root");
    });

    expect(firstCompletion).toBeInstanceOf(Promise);
    expect(secondCompletion).toBeInstanceOf(Promise);
    expect(zoomCompletion).toBeInstanceOf(Promise);
    await act(async () => {
      expect(await firstCompletion).toBeUndefined();
      expect(await secondCompletion).toBeUndefined();
      expect(await zoomCompletion).toBeUndefined();
    });
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(result.current.state.nodesById.second).toBeDefined();
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
    expect(newStore.createNode).toHaveBeenCalledWith(
      "/new",
      {
        id: "new-vault-root",
        parentId: null,
        afterId: null,
        title: "",
        note: ""
      },
      historyContext("create")
    );
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

    expect(store.updateNode).toHaveBeenCalledWith("/vault", { id: "root", title: "Title", note: "Note" }, historyContext("update"));
    expect(store.splitNode).toHaveBeenCalledWith("/vault", { id: "root", newNodeId: "split", prefix: "pre", suffix: "post" }, historyContext("split"));
    expect(store.moveNode).toHaveBeenCalledWith("/vault", { id: "child", parentId: null, afterId: "root" }, historyContext("move"));
    expect(store.toggleComplete).toHaveBeenCalledWith("/vault", "root", historyContext("complete"));
    expect(store.toggleCollapsed).toHaveBeenCalledWith("/vault", "root", historyContext("collapse"));
    expect(store.duplicateNode).toHaveBeenCalledWith("/vault", "root", historyContext("duplicate"));
    expect(store.removeEmptyNode).toHaveBeenCalledWith("/vault", "child", historyContext("remove"));
    expect(store.softDeleteNode).toHaveBeenCalledWith("/vault", "root", historyContext("trash"));
    expect(store.restoreNode).toHaveBeenCalledWith("/vault", "root", historyContext("restore"));

    updateNodeMock.mockRejectedValueOnce(new Error("write failed"));
    await act(async () => result.current.actions.updateNode("root", { title: "Again", note: "" }));
    expect(result.current.error).toBe("write failed");
    expect(result.current.state.nodesById.root).toBeDefined();
  });

  it("retains the last scoped projection when reload fails after a mutation", async () => {
    const starred = node({ id: "starred", title: "Starred", isStarred: true });
    const outside = node({ id: "outside", title: "Outside" });
    const split = node({
      id: "split",
      parentId: null,
      sortKey: 1536,
      title: "Split"
    });
    let rejectScopedReload = false;
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) => {
        if (scope.kind === "starred") {
          if (rejectScopedReload) {
            throw new Error("Scoped reload failed");
          }
          return workspace([starred]);
        }
        return workspace([starred, outside]);
      }),
      splitNode: vi.fn().mockResolvedValue(workspace([starred, outside, split]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    expect(result.current.state.rootIds).toEqual(["starred"]);

    rejectScopedReload = true;
    await act(async () =>
      result.current.actions.splitNode(
        "starred",
        "split",
        "Star",
        "red"
      )
    );

    expect(result.current.error).toBe("Scoped reload failed");
    expect(result.current.libraryView).toBe("starred");
    expect(result.current.state.rootIds).toEqual(["starred"]);
    expect(result.current.state.nodesById.outside).toBeUndefined();
    expect(result.current.state.nodesById.split).toBeUndefined();
  });

  it("gates hook actions while Notes data deletion is in progress", async () => {
    const deletion = deferred<void>();
    const store = repository({
      deleteDatabase: vi.fn().mockReturnValue(deletion.promise),
      createNode: vi.fn().mockResolvedValue(workspace([node({ id: "created" })])),
      updateNode: vi.fn().mockResolvedValue(workspace([node({ id: "updated" })]))
    });
    createNoteIdMock.mockReturnValue("created");
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let deletionCompletion!: Promise<void>;
    act(() => {
      deletionCompletion = result.current.actions.deleteAllNotesData();
    });
    await waitFor(() => expect(store.deleteDatabase).toHaveBeenCalledOnce());
    expect(result.current.deletingNotesData).toBe(true);

    await act(async () => {
      result.current.actions.updateNodeDraft("root", {
        title: "Blocked draft",
        note: ""
      });
      await Promise.all([
        result.current.actions.createRoot(),
        result.current.actions.updateNode("root", {
          title: "Blocked update",
          note: ""
        }),
        result.current.actions.selectLibraryView("recent"),
        result.current.actions.searchNotes("blocked")
      ]);
    });

    expect(store.createNode).not.toHaveBeenCalled();
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(store.search).not.toHaveBeenCalled();
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
    expect(result.current.draftsByNodeId.root).toBeUndefined();

    await act(async () => {
      deletion.resolve();
      await deletionCompletion;
    });

    expect(result.current.deletingNotesData).toBe(false);
    expect(result.current.state.rootIds).toEqual([]);
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
  });

  it("releases the deletion gate and retains a draft when flushing fails", async () => {
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("Draft save failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "Recoverable draft",
        note: "Keep me"
      });
    });

    await act(async () => {
      await expect(
        result.current.actions.deleteAllNotesData()
      ).rejects.toThrow("Draft save failed");
    });

    expect(store.deleteDatabase).not.toHaveBeenCalled();
    expect(result.current.deletingNotesData).toBe(false);
    expect(result.current.draftsByNodeId.root).toMatchObject({
      title: "Recoverable draft",
      note: "Keep me",
      status: "failed"
    });
    expect(result.current.state.nodesById.root).toBeDefined();
  });

  it("coalesces rapid node drafts and writes the latest patch after 300 ms", async () => {
    const store = repository({
      updateNode: vi.fn((_vaultRoot, input) =>
        Promise.resolve(
          workspace([
            node({ id: "root", title: input.title, note: input.note })
          ])
        )
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    vi.useFakeTimers();

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "first draft",
        note: ""
      });
      result.current.actions.updateNodeDraft("root", {
        title: "latest draft",
        note: "latest note"
      });
    });

    expect(result.current.draftsByNodeId.root).toMatchObject({
      title: "latest draft",
      note: "latest note"
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(store.updateNode).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(store.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "root",
        title: "latest draft",
        note: "latest note"
      },
      historyContext("text")
    );
  });

  it("keeps a pending draft and split in one coordinator command", async () => {
    const draftWrite = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    const before = workspace([
      node({ id: "source", title: "source" }),
      node({ id: "other", sortKey: 2048, title: "other" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      updateNode: vi.fn((_vaultRoot, input) => {
        invocations.push(`update:${input.id}`);
        return input.id === "source"
          ? draftWrite.promise
          : Promise.resolve(before);
      }),
      splitNode: vi.fn().mockImplementation(async () => {
        invocations.push("split");
        return before;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft("source", {
        title: "source edited",
        note: ""
      });
    });
    let splitCompletion!: Promise<void>;
    let otherCompletion!: Promise<void>;
    act(() => {
      splitCompletion = result.current.actions.splitNode(
        "source",
        "new-node",
        "source",
        " edited"
      );
      otherCompletion = result.current.actions.updateNode("other", {
        title: "other edited",
        note: ""
      });
    });
    expect(invocations).toEqual(["update:source"]);

    await act(async () =>
      draftWrite.resolve(
        workspace([
          node({ id: "source", title: "source edited" }),
          node({ id: "other", sortKey: 2048, title: "other" })
        ])
      )
    );
    await act(async () => Promise.all([splitCompletion, otherCompletion]));

    expect(invocations).toEqual(["update:source", "split", "update:other"]);
  });

  it("orders a pending text burst before split with stable distinct history IDs", async () => {
    const initial = workspace([node({ id: "source", title: "source" })]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode: vi.fn().mockResolvedValue(
        workspace([node({ id: "source", title: "source edited" })])
      ),
      splitNode: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "source", title: "source" }),
          node({ id: "split", sortKey: 2048, title: "edited" })
        ])
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft(
        "source",
        { title: "source e", note: "" },
        "title"
      );
      result.current.actions.updateNodeDraft(
        "source",
        { title: "source edited", note: "" },
        "title"
      );
    });
    await act(async () =>
      result.current.actions.splitNode("source", "split", "source", " edited")
    );

    const textContext = vi.mocked(store.updateNode).mock.calls[0]?.[2];
    const splitContext = vi.mocked(store.splitNode).mock.calls[0]?.[2];
    expect(textContext).toMatchObject({ commandKind: "text" });
    expect(splitContext).toMatchObject({ commandKind: "split" });
    expect(textContext?.sessionId).toBe(splitContext?.sessionId);
    expect(textContext?.entryId).not.toBe(splitContext?.entryId);
    expect(textContext?.entryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(textContext?.entryId).not.toBe("source");
  });

  it("flushes a visible note draft before undo and restores field-aware UI", async () => {
    const initial = workspace([
      node({ id: "root", title: "before" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const updateNode = vi.fn().mockResolvedValue(
      workspace([
        node({ id: "root", title: "before", note: "supporting" }),
        node({ id: "other", sortKey: 2048 })
      ])
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: updateNode.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.actions.focusNode("root");
      await result.current.actions.zoomTo("root");
    });
    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "before", note: "supporting" },
        "note"
      );
    });
    let replay!: Promise<void>;
    act(() => {
      replay = result.current.actions.undo!();
    });
    await act(async () => replay);

    expect(updateNode.mock.invocationCallOrder[0]).toBeLessThan(
      undo.mock.invocationCallOrder[0]!
    );
    expect(undo).toHaveBeenCalledWith(
      "/vault",
      updateNode.mock.calls[0]?.[2]?.sessionId,
      { kind: "active" }
    );
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      zoomRootId: "root",
      pendingFocusId: "root",
      pendingFocusField: "note"
    });
  });

  it("applies replayed backend data and normalizes live UI without a snapshot", async () => {
    const initial = workspace([node({ id: "root" })]);
    const undo = vi.fn().mockResolvedValue({
      workspace: workspace([node({ id: "other" })]),
      replayedEntryId: "90000000-0000-4000-8000-000000000009",
      canUndo: false,
      canRedo: true
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.actions.focusNode("root");
      await result.current.actions.zoomTo("root");
      await result.current.actions.undo!();
    });

    expect(result.current.state.nodesById.other).toBeDefined();
    expect(result.current.state).toMatchObject({
      selectedId: null,
      zoomRootId: null,
      editingNoteId: null,
      pendingFocusId: null,
      pendingFocusField: null
    });
  });

  it("lets the backend invalidate redo after a new structural mutation", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const completed = workspace([
      node({ id: "root", isStarred: false, completedAt: "2026-07-11T00:00:00Z" })
    ]);
    const toggleStar = vi.fn().mockResolvedValue(starred);
    const toggleComplete = vi.fn().mockResolvedValue(completed);
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: toggleStar.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const redo = vi.fn().mockResolvedValue({
      workspace: completed,
      replayedEntryId: null,
      canUndo: true,
      canRedo: false
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      toggleComplete,
      undo,
      redo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.toggleStar("root"));
    await act(async () => result.current.actions.undo!());
    await act(async () => result.current.actions.toggleComplete("root"));
    await act(async () => result.current.actions.redo!());

    expect(toggleComplete.mock.calls[0]?.[2]?.entryId).not.toBe(
      toggleStar.mock.calls[0]?.[2]?.entryId
    );
    expect(redo).toHaveBeenCalledWith(
      "/vault",
      toggleStar.mock.calls[0]?.[2]?.sessionId,
      { kind: "active" }
    );
    expect(result.current.state.nodesById.root.completedAt).not.toBeNull();
  });

  it("flushes pending drafts before creating a new root", async () => {
    createNoteIdMock.mockReturnValue("new-root");
    const invocations: string[] = [];
    const afterDraft = workspace([node({ id: "root", title: "edited" })]);
    const store = repository({
      updateNode: vi.fn().mockImplementation(async () => {
        invocations.push("update");
        return afterDraft;
      }),
      createNode: vi.fn().mockImplementation(async () => {
        invocations.push("create");
        return workspace([
          node({ id: "root", title: "edited" }),
          node({ id: "new-root", sortKey: 2048 })
        ]);
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "edited",
        note: ""
      });
    });
    await act(async () => result.current.actions.createRoot());

    expect(invocations).toEqual(["update", "create"]);
  });

  it("flushes an old-vault draft without publishing its response into the new vault", async () => {
    const oldWrite = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) =>
        Promise.resolve(
          workspace([
            node({ id: vaultRoot === "/old" ? "old-root" : "new-root" })
          ])
        )
      ),
      updateNode: vi.fn().mockReturnValue(oldWrite.promise)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["old-root"]).toBeDefined()
    );

    act(() => {
      result.current.actions.updateNodeDraft("old-root", {
        title: "old draft",
        note: ""
      });
    });
    rerender({ vaultRoot: "/new" });

    expect(store.updateNode).toHaveBeenCalledWith(
      "/old",
      {
        id: "old-root",
        title: "old draft",
        note: ""
      },
      historyContext("text")
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["new-root"]).toBeDefined()
    );

    await act(async () =>
      oldWrite.resolve(workspace([node({ id: "old-saved" })]))
    );
    expect(result.current.state.nodesById["new-root"]).toBeDefined();
    expect(result.current.state.nodesById["old-saved"]).toBeUndefined();
    expect(result.current.draftsByNodeId).toEqual({});
  });

  it("does not let a late old-vault draft poison the next history UI snapshot", async () => {
    const oldWrite = deferred<NotesWorkspace>();
    const newWorkspace = workspace([node({ id: "new-root" })]);
    const toggleStar = vi.fn().mockResolvedValue(
      workspace([node({ id: "new-root", isStarred: true })])
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: newWorkspace,
      replayedEntryId: toggleStar.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) =>
        Promise.resolve(
          vaultRoot === "/old"
            ? workspace([node({ id: "old-root" })])
            : newWorkspace
        )
      ),
      updateNode: vi.fn().mockReturnValue(oldWrite.promise),
      toggleStar,
      undo
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["old-root"]).toBeDefined()
    );

    act(() => {
      result.current.actions.updateNodeDraft("old-root", {
        title: "late old draft",
        note: ""
      });
    });
    rerender({ vaultRoot: "/new" });
    await waitFor(() =>
      expect(result.current.state.nodesById["new-root"]).toBeDefined()
    );
    await act(async () => {
      await result.current.actions.focusNode("new-root");
      await result.current.actions.zoomTo("new-root");
    });
    await act(async () => {
      oldWrite.resolve(workspace([node({ id: "old-root", title: "late" })]));
    });

    await act(async () => result.current.actions.toggleStar("new-root"));
    await act(async () => result.current.actions.undo!());

    expect(result.current.state).toMatchObject({
      selectedId: "new-root",
      zoomRootId: "new-root",
      pendingFocusId: "new-root",
      pendingFocusField: "title"
    });
  });

  it("recovers a failed shutdown draft only when its vault becomes active again", async () => {
    const oldBefore = workspace([node({ id: "old-root", title: "Old title" })]);
    const oldSaved = workspace([
      node({ id: "old-root", title: "Recovered old draft" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) =>
        Promise.resolve(
          vaultRoot === "/old"
            ? oldBefore
            : workspace([node({ id: "new-root", title: "New title" })])
        )
      ),
      updateNode: vi
        .fn()
        .mockRejectedValueOnce(new Error("old vault disk full"))
        .mockResolvedValueOnce(oldSaved)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["old-root"]).toBeDefined()
    );

    act(() => {
      result.current.actions.updateNodeDraft("old-root", {
        title: "Recovered old draft",
        note: ""
      });
    });
    rerender({ vaultRoot: "/new" });

    await waitFor(() =>
      expect(result.current.state.nodesById["new-root"]).toBeDefined()
    );
    expect(result.current.draftsByNodeId).toEqual({});
    expect(result.current.writeError).toBeNull();

    rerender({ vaultRoot: "/old" });
    await waitFor(() =>
      expect(result.current.draftsByNodeId["old-root"]).toMatchObject({
        title: "Recovered old draft",
        status: "failed"
      })
    );
    expect(result.current.writeError).toMatchObject({
      operation: "write",
      retryable: true,
      message: "old vault disk full"
    });

    await act(async () => result.current.retryFailedDraft("old-root"));

    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/old",
      {
        id: "old-root",
        title: "Recovered old draft",
        note: ""
      },
      historyContext("text")
    );
    await waitFor(() =>
      expect(result.current.draftsByNodeId["old-root"]).toBeUndefined()
    );
    expect(result.current.writeError).toBeNull();
  });

  it("isolates shutdown recovery by repository object for the same vault path", async () => {
    const firstStore = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("first store failed"))
    });
    const secondStore = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "second-root" })]))
    });
    const firstMount = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared", repository: firstStore })
    );
    await waitFor(() => expect(firstMount.result.current.status).toBe("ready"));

    act(() => {
      firstMount.result.current.actions.updateNodeDraft("root", {
        title: "First store draft",
        note: ""
      });
    });
    firstMount.unmount();
    await waitFor(() => expect(firstStore.updateNode).toHaveBeenCalledOnce());

    const secondMount = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared", repository: secondStore })
    );
    await waitFor(() =>
      expect(secondMount.result.current.state.nodesById["second-root"]).toBeDefined()
    );

    expect(secondMount.result.current.draftsByNodeId).toEqual({});
    expect(secondMount.result.current.writeError).toBeNull();
  });

  it("flushes a dirty unmount before a same-vault remount activation", async () => {
    const unmountWrite = deferred<NotesWorkspace>();
    let loadCount = 0;
    const store = repository({
      loadWorkspace: vi.fn(() => {
        loadCount += 1;
        return Promise.resolve(
          workspace([
            node({
              id: "root",
              title: loadCount === 1 ? "before" : "saved"
            })
          ])
        );
      }),
      updateNode: vi.fn().mockReturnValue(unmountWrite.promise)
    });
    const firstMount = renderHook(
      () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
      { wrapper: strictMode }
    );
    await waitFor(() => expect(firstMount.result.current.status).toBe("ready"));

    act(() => {
      firstMount.result.current.actions.updateNodeDraft("root", {
        title: "saved",
        note: ""
      });
    });
    firstMount.unmount();
    expect(store.updateNode).toHaveBeenCalledOnce();

    const secondMount = renderHook(
      () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
      { wrapper: strictMode }
    );
    expect(store.loadWorkspace).toHaveBeenCalledOnce();

    await act(async () =>
      unmountWrite.resolve(
        workspace([node({ id: "root", title: "saved" })])
      )
    );
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(secondMount.result.current.state.nodesById.root.title).toBe(
        "saved"
      )
    );
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(secondMount.result.current.draftsByNodeId).toEqual({});
    expect(secondMount.result.current.writeError).toBeNull();
  });

  it("returns true after flushing a draft that persists successfully", async () => {
    const saved = workspace([node({ id: "root", title: "saved" })]);
    const store = repository({
      updateNode: vi.fn().mockResolvedValue(saved)
    });
    const mounted = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));

    act(() => {
      mounted.result.current.actions.updateNodeDraft("root", {
        title: "saved",
        note: ""
      });
    });

    let flushed: unknown;
    await act(async () => {
      flushed = await mounted.result.current.actions.flushNodeDraft("root");
    });

    expect(flushed).toBe(true);
    expect(mounted.result.current.draftsByNodeId).toEqual({});
  });

  it("returns false when flushing retains a failed draft", async () => {
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("disk full"))
    });
    const mounted = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));

    act(() => {
      mounted.result.current.actions.updateNodeDraft("root", {
        title: "not saved",
        note: ""
      });
    });

    let flushed: unknown;
    await act(async () => {
      flushed = await mounted.result.current.actions.flushNodeDraft("root");
    });

    expect(flushed).toBe(false);
    expect(mounted.result.current.draftsByNodeId.root).toMatchObject({
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
    const mounted = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));

    act(() => {
      mounted.result.current.actions.updateNodeDraft("root", {
        title: "saved on retry",
        note: ""
      });
    });

    let firstFlush: unknown;
    let retryFlush: unknown;
    await act(async () => {
      firstFlush = await mounted.result.current.actions.flushNodeDraft("root");
      retryFlush = await mounted.result.current.actions.flushNodeDraft("root");
    });

    expect(firstFlush).toBe(false);
    expect(retryFlush).toBe(true);
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(mounted.result.current.draftsByNodeId).toEqual({});
  });

  it("returns false when the vault session changes before a flush completes", async () => {
    const oldWrite = deferred<NotesWorkspace>();
    const oldStore = repository({
      updateNode: vi.fn().mockReturnValue(oldWrite.promise)
    });
    const newStore = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "new-root" })]))
    });
    const mounted = renderHook(
      ({ vaultRoot, repository: current }) =>
        useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/old", repository: oldStore } }
    );
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));

    act(() => {
      mounted.result.current.actions.updateNodeDraft("root", {
        title: "old vault draft",
        note: ""
      });
    });
    const flush = mounted.result.current.actions.flushNodeDraft("root");
    await waitFor(() => expect(oldStore.updateNode).toHaveBeenCalledOnce());

    mounted.rerender({ vaultRoot: "/new", repository: newStore });
    await act(async () => {
      oldWrite.resolve(workspace([node({ id: "root", title: "old vault draft" })]));
    });

    await expect(flush).resolves.toBe(false);
  });

  it("retries a retained failed draft before closing its unmounted session", async () => {
    const saved = workspace([node({ id: "root", title: "saved on unmount" })]);
    const store = repository({
      updateNode: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce(saved)
    });
    const mounted = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));

    act(() => {
      mounted.result.current.actions.updateNodeDraft("root", {
        title: "saved on unmount",
        note: ""
      });
    });
    await act(async () =>
      mounted.result.current.actions.flushNodeDraft("root")
    );
    expect(mounted.result.current.writeError).toMatchObject({
      operation: "write",
      retryable: true,
      message: "disk full"
    });

    mounted.unmount();

    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "root",
        title: "saved on unmount",
        note: ""
      },
      historyContext("text")
    );
  });

  it("does not launch or publish old-identity queued work after a vault change", async () => {
    const oldLoad = deferred<NotesWorkspace>();
    const newLoad = deferred<NotesWorkspace>();
    const oldStore = repository({
      loadWorkspace: vi.fn().mockReturnValue(oldLoad.promise),
      updateNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "old-command" })]))
    });
    const newStore = repository({
      loadWorkspace: vi.fn().mockReturnValue(newLoad.promise)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, repository: current }) =>
        useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/old", repository: oldStore } }
    );
    await waitFor(() => expect(oldStore.loadWorkspace).toHaveBeenCalledOnce());

    let oldCompletion!: Promise<void>;
    act(() => {
      oldCompletion = result.current.actions.updateNode("old", {
        title: "stale",
        note: ""
      });
    });

    rerender({ vaultRoot: "/new", repository: newStore });
    expect(result.current.status).toBe("loading");
    expect(result.current.state.rootIds).toEqual([]);
    await waitFor(() => expect(newStore.loadWorkspace).toHaveBeenCalledOnce());

    await act(async () => {
      oldLoad.resolve(workspace([node({ id: "old" })]));
      await oldCompletion;
    });

    expect(oldStore.updateNode).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.old).toBeUndefined();
    expect(result.current.status).toBe("loading");

    await act(async () =>
      newLoad.resolve(workspace([node({ id: "new" })]))
    );
    expect(result.current.state.nodesById.new).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("does not publish in-flight work or launch later queued work after unmount", async () => {
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
    const commandStore = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(command.promise)
        .mockResolvedValueOnce(workspace([node({ id: "never-launched" })]))
    });
    const commandHook = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/command", repository: commandStore })
    );
    await waitFor(() => expect(commandHook.result.current.status).toBe("ready"));
    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = commandHook.result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = commandHook.result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
    });
    await waitFor(() =>
      expect(commandStore.updateNode).toHaveBeenCalledOnce()
    );
    commandHook.unmount();

    await act(async () => {
      command.resolve(workspace([node({ id: "late-command" })]));
      await Promise.all([firstCompletion, secondCompletion]);
    });
    expect(commandStore.updateNode).toHaveBeenCalledOnce();
    expect(commandHook.result.current.state.nodesById["late-command"]).toBeUndefined();
  });

  it("keeps a running mutation as the barrier across unmount and remount", async () => {
    const running = deferred<NotesWorkspace>();
    const refresh = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    let loadCount = 0;
    const store = repository({
      initialize: vi.fn(async () => {
        invocations.push("initialize");
      }),
      loadWorkspace: vi.fn(() => {
        loadCount += 1;
        invocations.push(`load:${loadCount}`);
        return loadCount === 1
          ? Promise.resolve(workspace([node({ id: "before-a1" })]))
          : refresh.promise;
      }),
      updateNode: vi.fn((_vaultRoot, input) => {
        invocations.push(`update:${input.title}`);
        return input.title === "A1"
          ? running.promise
          : Promise.resolve(workspace([node({ id: "after-a3" })]));
      })
    });
    const firstMount = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault-a", repository: store })
    );
    await waitFor(() => expect(firstMount.result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let oldQueuedCompletion!: Promise<void>;
    let oldQueuedSettled = false;
    act(() => {
      firstCompletion = firstMount.result.current.actions.updateNode("before-a1", {
        title: "A1",
        note: ""
      });
      oldQueuedCompletion = firstMount.result.current.actions.updateNode("before-a1", {
        title: "old-A2",
        note: ""
      });
      void oldQueuedCompletion.then(() => {
        oldQueuedSettled = true;
      });
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());

    firstMount.unmount();
    await act(async () => Promise.resolve());
    expect(oldQueuedSettled).toBe(true);

    const secondMount = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault-a", repository: store })
    );
    let newCompletion!: Promise<void>;
    act(() => {
      newCompletion = secondMount.result.current.actions.updateNode("after-a1", {
        title: "A3",
        note: ""
      });
    });

    expect(store.loadWorkspace).toHaveBeenCalledOnce();
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(secondMount.result.current.state.rootIds).toEqual([]);

    await act(async () => {
      running.resolve(workspace([node({ id: "a1-response" })]));
      await firstCompletion;
    });
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledTimes(2));
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(secondMount.result.current.state.rootIds).toEqual([]);

    await act(async () =>
      refresh.resolve(workspace([node({ id: "after-a1" })]))
    );
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledTimes(2));
    await act(async () => {
      await newCompletion;
      await oldQueuedCompletion;
    });

    expect(store.updateNode).toHaveBeenNthCalledWith(
      1,
      "/vault-a",
      { id: "before-a1", title: "A1", note: "" },
      historyContext("update")
    );
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault-a",
      { id: "after-a1", title: "A3", note: "" },
      historyContext("update")
    );
    expect(invocations).toEqual([
      "initialize",
      "load:1",
      "update:A1",
      "load:2",
      "update:A3"
    ]);
    expect(secondMount.result.current.state.nodesById["after-a3"]).toBeDefined();
  });

  it("serializes A -> B -> A per vault without blocking B", async () => {
    const runningA1 = deferred<NotesWorkspace>();
    const refreshedA = deferred<NotesWorkspace>();
    let aLoadCount = 0;
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) => {
        if (vaultRoot === "/vault-b") {
          return Promise.resolve(workspace([node({ id: "b-root" })]));
        }
        aLoadCount += 1;
        return aLoadCount === 1
          ? Promise.resolve(workspace([node({ id: "a-before" })]))
          : refreshedA.promise;
      }),
      updateNode: vi.fn((vaultRoot, input) => {
        if (input.title === "A1") {
          return runningA1.promise;
        }
        return Promise.resolve(
          workspace([
            node({
              id: vaultRoot === "/vault-b" ? "b-updated" : "a3-updated"
            })
          ])
        );
      })
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(result.current.state.nodesById["a-before"]).toBeDefined());

    let a1Completion!: Promise<void>;
    let oldA2Completion!: Promise<void>;
    act(() => {
      a1Completion = result.current.actions.updateNode("a-before", {
        title: "A1",
        note: ""
      });
      oldA2Completion = result.current.actions.updateNode("a-before", {
        title: "old-A2",
        note: ""
      });
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());

    rerender({ vaultRoot: "/vault-b" });
    await waitFor(() => expect(result.current.state.nodesById["b-root"]).toBeDefined());
    await act(async () =>
      result.current.actions.updateNode("b-root", { title: "B1", note: "" })
    );
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault-b",
      { id: "b-root", title: "B1", note: "" },
      historyContext("update")
    );

    rerender({ vaultRoot: "/vault-a" });
    let a3Completion!: Promise<void>;
    act(() => {
      a3Completion = result.current.actions.updateNode("after-a1", {
        title: "A3",
        note: ""
      });
    });
    await act(async () => Promise.resolve());
    expect(aLoadCount).toBe(1);
    expect(result.current).toMatchObject({ status: "loading", error: null });
    expect(result.current.state.rootIds).toEqual([]);

    await act(async () => {
      runningA1.resolve(workspace([node({ id: "a1-response" })]));
      await a1Completion;
      await oldA2Completion;
    });
    await waitFor(() => expect(aLoadCount).toBe(2));
    expect(result.current.state.rootIds).toEqual([]);
    expect(store.updateNode).toHaveBeenCalledTimes(2);

    await act(async () =>
      refreshedA.resolve(workspace([node({ id: "after-a1" })]))
    );
    await act(async () => a3Completion);

    expect(store.updateNode).toHaveBeenNthCalledWith(
      3,
      "/vault-a",
      { id: "after-a1", title: "A3", note: "" },
      historyContext("update")
    );
    expect(result.current.state.nodesById["a3-updated"]).toBeDefined();
    expect(result.current.state.nodesById["a-before"]).toBeUndefined();
  });

  it("keeps the committed identity active when a different render is abandoned", async () => {
    const firstCommand = deferred<NotesWorkspace>();
    const suspended = deferred<void>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(firstCommand.promise)
        .mockResolvedValueOnce(workspace([node({ id: "second-a-result" })]))
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, shouldSuspend }) => {
        const current = useNotesWorkspace({ vaultRoot, repository: store });
        if (shouldSuspend) {
          throw suspended.promise;
        }
        return current;
      },
      {
        initialProps: { vaultRoot: "/vault-a", shouldSuspend: false },
        wrapper: suspenseMode
      }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "committed-A1",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "committed-A2",
        note: ""
      });
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());

    rerender({ vaultRoot: "/vault-b", shouldSuspend: true });
    expect(store.initialize).toHaveBeenCalledOnce();

    await act(async () => {
      firstCommand.resolve(workspace([
        node({ id: "root" }),
        node({ id: "first-a-result" })
      ]));
      await Promise.all([firstCompletion, secondCompletion]);
    });

    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault-a",
      { id: "root", title: "committed-A2", note: "" },
      historyContext("update")
    );
  });

  it("retains a root creation failure when its queued child dependency is missing", async () => {
    createNoteIdMock
      .mockReturnValueOnce("new-parent")
      .mockReturnValueOnce("new-child");
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi.fn().mockRejectedValue(new Error("root failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let rootCompletion!: Promise<void>;
    let childCompletion!: Promise<void>;
    act(() => {
      rootCompletion = result.current.actions.createRoot();
      childCompletion = result.current.actions.createChild("new-parent");
    });
    await act(async () => {
      await Promise.all([rootCompletion, childCompletion]);
    });

    expect(store.createNode).toHaveBeenCalledOnce();
    expect(result.current.state.rootIds).toEqual([]);
    expect(result.current).toMatchObject({ status: "error", error: "root failed" });
  });

  it("retains a split failure when its queued duplicate dependency is missing", async () => {
    const store = repository({
      splitNode: vi.fn().mockRejectedValue(new Error("split failed")),
      duplicateNode: vi.fn().mockResolvedValue(workspace([]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let splitCompletion!: Promise<void>;
    let duplicateCompletion!: Promise<void>;
    act(() => {
      splitCompletion = result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix"
      );
      duplicateCompletion = result.current.actions.duplicateNode("split-child");
    });
    await act(async () => {
      await Promise.all([splitCompletion, duplicateCompletion]);
    });

    expect(store.splitNode).toHaveBeenCalledOnce();
    expect(store.duplicateNode).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.root).toBeDefined();
    expect(result.current).toMatchObject({ status: "error", error: "split failed" });
  });

  it("handles a synchronous createNoteId throw and clears it on later authoritative success", async () => {
    createNoteIdMock
      .mockImplementationOnce(() => {
        throw new Error("id creation failed");
      })
      .mockReturnValueOnce("created-after-failure");
    const store = repository({
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "created-after-failure" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let failedCompletion!: Promise<void>;
    act(() => {
      failedCompletion = result.current.actions.createRoot();
    });
    await act(async () => {
      await expect(failedCompletion).resolves.toBeUndefined();
    });
    expect(store.createNode).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      status: "error",
      error: "id creation failed"
    });

    await act(async () => result.current.actions.createRoot());
    expect(store.createNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "created-after-failure",
        parentId: null,
        afterId: "root",
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(result.current.state.nodesById["created-after-failure"]).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("isolates the same vault across different repository objects", async () => {
    const firstRepositoryCommand = deferred<NotesWorkspace>();
    const firstStore = repository({
      updateNode: vi.fn().mockReturnValue(firstRepositoryCommand.promise)
    });
    const secondStore = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "second-root" })])),
      updateNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "second-updated" })]))
    });
    const { result, rerender } = renderHook(
      ({ repository: current }) =>
        useNotesWorkspace({ vaultRoot: "/shared-vault", repository: current }),
      { initialProps: { repository: firstStore } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first repository",
        note: ""
      });
    });
    await waitFor(() => expect(firstStore.updateNode).toHaveBeenCalledOnce());

    rerender({ repository: secondStore });
    await waitFor(() => expect(result.current.state.nodesById["second-root"]).toBeDefined());
    await act(async () =>
      result.current.actions.updateNode("second-root", {
        title: "second repository",
        note: ""
      })
    );

    expect(secondStore.updateNode).toHaveBeenCalledOnce();
    expect(result.current.state.nodesById["second-updated"]).toBeDefined();

    await act(async () => {
      firstRepositoryCommand.resolve(workspace([node({ id: "first-late" })]));
      await firstCompletion;
    });
    expect(result.current.state.nodesById["first-late"]).toBeUndefined();
  });

  it("allows restore to target a node absent from the active workspace", async () => {
    const store = repository({
      restoreNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "restored" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.restoreNode("restored"));

    expect(store.restoreNode).toHaveBeenCalledWith(
      "/vault",
      "restored",
      historyContext("restore")
    );
    expect(result.current.state.nodesById.restored).toBeDefined();
  });

  it("flushes every draft before archiving a root and selects the next visible root", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "second-child", parentId: "second", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      updateNode: vi.fn().mockResolvedValue(before),
      archiveNode: vi.fn().mockResolvedValue(after),
      listTags: vi.fn().mockResolvedValue(["#remaining"])
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.rootIds).toEqual([
      "first",
      "second",
      "third"
    ]));

    act(() => {
      void result.current.actions.zoomTo("second");
      result.current.actions.updateNodeDraft("second-child", {
        title: "Saved before archive",
        note: ""
      });
    });
    await act(async () => result.current.actions.archiveNode("second"));

    expect(store.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "second-child",
        title: "Saved before archive",
        note: ""
      },
      historyContext("text")
    );
    expect(store.archiveNode).toHaveBeenCalledWith(
      "/vault",
      "second",
      historyContext("archive")
    );
    expect(
      vi.mocked(store.updateNode).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(store.archiveNode).mock.invocationCallOrder[0]);
    expect(store.listTags).toHaveBeenCalledWith("/vault");
    expect(result.current.tags).toEqual(["#remaining"]);
    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "third",
      zoomRootId: "third",
      editingNoteId: "third",
      pendingFocusId: "third"
    });
  });

  it("falls back to the active projection when a post-archive scoped reload fails", async () => {
    const target = node({ id: "target", isStarred: true, sortKey: 1 });
    const outside = node({ id: "outside", sortKey: 2 });
    const before = workspace([target, outside]);
    const after = workspace([outside]);
    let archived = false;
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) => {
        if (scope.kind === "starred") {
          if (archived) {
            throw new Error("Starred projection failed");
          }
          return workspace([target]);
        }
        return archived ? after : before;
      }),
      archiveNode: vi.fn(async () => {
        archived = true;
        return after;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    await act(async () => result.current.actions.zoomTo("target"));

    await act(async () => result.current.actions.archiveNode("target"));

    expect(store.archiveNode).toHaveBeenCalledWith(
      "/vault",
      "target",
      historyContext("archive")
    );
    expect(result.current.error).toBeNull();
    expect(result.current.libraryView).toBe("all");
    expect(result.current.state).toMatchObject({
      rootIds: ["outside"],
      selectedId: null,
      zoomRootId: null,
      editingNoteId: null,
      pendingFocusId: null
    });
  });

  it("preserves navigation made while a root lifecycle mutation is pending", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const archive = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      archiveNode: vi.fn().mockReturnValue(archive.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.zoomTo("second"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.archiveNode("second");
    });
    await waitFor(() => expect(store.archiveNode).toHaveBeenCalledOnce());

    act(() => {
      void result.current.actions.zoomTo("first");
      void result.current.actions.focusNode("first");
    });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        selectedId: "first",
        zoomRootId: "first",
        editingNoteId: "first",
        pendingFocusId: "first"
      })
    );

    await act(async () => {
      archive.resolve(after);
      await completion;
    });

    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "first",
      zoomRootId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
  });

  it("preserves navigation when the lifecycle mutation resolves before React renders it", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const archive = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      archiveNode: vi.fn().mockReturnValue(archive.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.zoomTo("second"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.archiveNode("second");
    });
    await waitFor(() => expect(store.archiveNode).toHaveBeenCalledOnce());

    await act(async () => {
      void result.current.actions.zoomTo("first");
      void result.current.actions.focusNode("first");
      expect(result.current.state.zoomRootId).toBe("second");
      archive.resolve(after);
      await completion;
    });

    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "first",
      zoomRootId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
  });

  it("falls back to the previous root and then the empty state", async () => {
    let current = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => current),
      archiveNode: vi.fn().mockImplementation(async (_vault, nodeId) => {
        current = workspace(current.nodes.filter((currentNode) => currentNode.id !== nodeId));
        return current;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.rootIds).toEqual(["first", "second"]));

    await act(async () => result.current.actions.zoomTo("second"));
    await act(async () => result.current.actions.archiveNode("second"));
    expect(result.current.state.zoomRootId).toBe("first");

    await act(async () => result.current.actions.archiveNode("first"));
    expect(result.current.state).toMatchObject({
      rootIds: [],
      selectedId: null,
      zoomRootId: null
    });
  });

  it("uses the same deterministic fallback when an open root moves to Trash", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      softDeleteNode: vi.fn().mockResolvedValue(after)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.rootIds).toEqual([
      "first",
      "second",
      "third"
    ]));

    await act(async () => result.current.actions.zoomTo("second"));
    await act(async () => result.current.actions.deleteNode("second"));

    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "third",
      zoomRootId: "third",
      editingNoteId: "third",
      pendingFocusId: "third"
    });
  });

  it("rejects non-root archive and unarchive targets before invoking storage", async () => {
    const child = node({ id: "child", parentId: "root" });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([
        node({ id: "root" }),
        child
      ]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.nodesById.child).toBeDefined());

    await act(async () => {
      await result.current.actions.archiveNode("child");
      await result.current.actions.unarchiveNode("child");
    });

    expect(store.archiveNode).not.toHaveBeenCalled();
    expect(store.unarchiveNode).not.toHaveBeenCalled();
  });

  it("unarchives a root through the archive scope and chooses its next archived sibling", async () => {
    const active = workspace([node({ id: "active" })]);
    let archived = workspace([
      node({
        id: "archived-first",
        sortKey: 1,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-first"
      }),
      node({
        id: "archived-second",
        sortKey: 2,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-second"
      })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async (_vault, scope) =>
        scope.kind === "archive" ? archived : active
      ),
      unarchiveNode: vi.fn().mockImplementation(async () => {
        archived = workspace(archived.nodes.filter((current) => current.id !== "archived-first"));
        return active;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("archive"));
    await act(async () => result.current.actions.zoomTo("archived-first"));
    await act(async () => result.current.actions.unarchiveNode("archived-first"));

    expect(store.unarchiveNode).toHaveBeenCalledWith(
      "/vault",
      "archived-first",
      historyContext("unarchive")
    );
    expect(store.loadWorkspace).toHaveBeenLastCalledWith("/vault", {
      kind: "archive"
    });
    expect(result.current.state).toMatchObject({
      rootIds: ["archived-second"],
      selectedId: "archived-second",
      zoomRootId: "archived-second",
      editingNoteId: "archived-second",
      pendingFocusId: "archived-second"
    });
  });

  it("focuses the next archived sibling after moving the open archived root to Trash", async () => {
    const active = workspace([node({ id: "active" })]);
    let archived = workspace([
      node({
        id: "archived-first",
        sortKey: 1,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-first"
      }),
      node({
        id: "archived-second",
        sortKey: 2,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-second"
      })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async (_vault, scope) =>
        scope.kind === "archive" ? archived : active
      ),
      softDeleteNode: vi.fn().mockImplementation(async () => {
        archived = workspace(
          archived.nodes.filter((current) => current.id !== "archived-first")
        );
        return active;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("archive"));
    await act(async () => result.current.actions.zoomTo("archived-first"));

    await act(async () => result.current.actions.deleteNode("archived-first"));

    expect(store.softDeleteNode).toHaveBeenCalledWith(
      "/vault",
      "archived-first",
      historyContext("trash")
    );
    expect(result.current.state).toMatchObject({
      rootIds: ["archived-second"],
      selectedId: "archived-second",
      zoomRootId: "archived-second",
      editingNoteId: "archived-second",
      pendingFocusId: "archived-second"
    });
  });
});
