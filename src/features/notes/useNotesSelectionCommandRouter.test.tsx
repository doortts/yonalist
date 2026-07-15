import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NoteId, NoteNode } from "../../domain/notes";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type { NotesSelectionActionSnapshot } from "./notesSelectionActions";
import type { NotesBatchCommandSettlement } from "./notesCommands";
import type { NotesClipboardEvent } from "./notesClipboard";
import { MAX_PASTE_IMPORT_NODES } from "./notesPasteImport";
import {
  createNotesSelectionCommandRouter,
  useNotesSelectionCommandRouter,
  type NotesSelectionCommandRouterDependencies,
  type NotesFrozenSelectionCommandContext,
  type NotesSelectionRouterAuthority
} from "./useNotesSelectionCommandRouter";

function node(
  id: NoteId,
  overrides: Partial<NoteNode> = {}
): NoteNode {
  return {
    id,
    parentId: null,
    sortKey: 1024,
    title: id,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-15T00:00:00Z",
    updatedAt: "2026-07-15T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function eligible(nodeIds: readonly NoteId[]) {
  return { eligible: true as const, nodeIds };
}

function unavailable(reason = "Unavailable") {
  return { eligible: false as const, reason };
}

function snapshot(
  overrides: Partial<NotesSelectionActionSnapshot> = {}
): NotesSelectionActionSnapshot {
  return {
    selection: { anchorId: "a", headId: "c" },
    selectedNodeIds: ["a", "b", "c"],
    structuralRootIds: ["a", "b", "c"],
    completion: "none",
    deleteFocusNodeId: "tail",
    eligibility: {
      copy: eligible(["a", "b", "c"]),
      cut: eligible(["a", "b", "c"]),
      delete: eligible(["a", "b", "c"]),
      duplicate: eligible(["a", "b", "c"]),
      indent: eligible(["b", "c"]),
      outdent: eligible(["a", "b"]),
      moveUp: {
        ...eligible(["a", "b", "c"]),
        target: { parentId: null, afterId: null, beforeId: "previous" }
      },
      moveDown: {
        ...eligible(["a", "b", "c"]),
        target: { parentId: null, afterId: "next" }
      },
      moveTo: eligible(["a", "b", "c"])
    },
    ...overrides
  };
}

function authority(
  selectedNodeIds: readonly NoteId[],
  workspace = normalizeWorkspace({
    nodes: [
      node("a", { sortKey: 1, title: "A" }),
      node("b", { sortKey: 2, title: "B" }),
      node("c", { sortKey: 3, title: "C" }),
      node("tail", { sortKey: 4, title: "Tail" })
    ]
  }),
  selectionRevision = 7
): NotesSelectionRouterAuthority {
  return { selectedNodeIds, workspace, selectionRevision };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nativeClipboardEvent(options: { throwOnWrite?: boolean } = {}) {
  const setData = vi.fn(() => {
    if (options.throwOnWrite) {
      throw new Error("clipboard denied");
    }
  });
  const preventDefault = vi.fn();
  const event: NotesClipboardEvent = {
    clipboardData: { setData },
    preventDefault
  };
  return { event, setData, preventDefault };
}

function dependencies(
  overrides: Partial<
    NotesSelectionCommandRouterDependencies<NotesSelectionRouterAuthority>
  > = {}
) {
  let currentSnapshot = snapshot();
  let currentRevision = 7;
  let currentNavigationVersion = 11;
  const projectedWorkspace = authority(["a", "b", "c"]).workspace;
  let visibleNodeIds: readonly NoteId[] = ["a", "b", "c", "tail"];
  const prepared = authority(["a", "b", "c"]);
  const deps: NotesSelectionCommandRouterDependencies<NotesSelectionRouterAuthority> = {
    getSnapshot: () => currentSnapshot,
    getSelectionRevision: () => currentRevision,
    getNavigationVersion: () => currentNavigationVersion,
    getVisibleNodeIds: () => visibleNodeIds,
    flushDrafts: vi.fn().mockResolvedValue(true),
    prepareAuthority: vi.fn().mockResolvedValue(prepared),
    isAuthorityCurrent: vi.fn().mockReturnValue(true),
    applyBatch: vi.fn(async () => ({
      outcome: "committed" as const,
      mutationCommitted: true,
      projectedWorkspace
    })),
    replaceSelection: vi.fn().mockReturnValue(true),
    focusNode: vi.fn(),
    writeClipboard: vi.fn().mockResolvedValue({
      kind: "success",
      method: "plainText"
    }),
    ...overrides
  };
  return {
    deps,
    setSnapshot(value: NotesSelectionActionSnapshot) {
      currentSnapshot = value;
    },
    setRevision(value: number) {
      currentRevision = value;
    },
    setNavigationVersion(value: number) {
      currentNavigationVersion = value;
    },
    setVisibleNodeIds(value: readonly NoteId[]) {
      visibleNodeIds = value;
    }
  };
}

describe("createNotesSelectionCommandRouter", () => {
  it("prepares one fresh bounded clipboard session after flush and exact authority validation", async () => {
    const order: string[] = [];
    const prepared = authority(["a", "b", "c"]);
    const harness = dependencies({
      flushDrafts: vi.fn(async () => {
        order.push("flush");
        return true;
      }),
      prepareAuthority: vi.fn(async (nodeIds) => {
        order.push(`prepare:${nodeIds.join(",")}`);
        return prepared;
      }),
      isAuthorityCurrent: vi.fn((candidate) => {
        order.push("current");
        return candidate === prepared;
      })
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    const session = await router.prepareClipboard();

    expect(session).not.toBeNull();
    expect(order).toEqual(["flush", "prepare:a,b,c", "current"]);
    expect(harness.deps.writeClipboard).not.toHaveBeenCalled();
  });

  it("does not install a clipboard session when selection changes during draft flush", async () => {
    let revision = 7;
    const harness = dependencies({
      getSelectionRevision: () => revision,
      flushDrafts: vi.fn(async () => {
        revision = 8;
        return true;
      })
    });

    const session = await createNotesSelectionCommandRouter(
      harness.deps
    ).prepareClipboard();

    expect(session).toBeNull();
    expect(harness.deps.prepareAuthority).not.toHaveBeenCalled();
  });

  it("lets the latest overlapping clipboard preparation win without losing both sessions", async () => {
    const firstFlush = deferred<boolean>();
    const secondFlush = deferred<boolean>();
    const feedback = vi.fn();
    const harness = dependencies({
      flushDrafts: vi
        .fn()
        .mockReturnValueOnce(firstFlush.promise)
        .mockReturnValueOnce(secondFlush.promise),
      onFeedback: feedback
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    const firstPreparation = router.prepareClipboard();
    const secondPreparation = router.prepareClipboard();
    secondFlush.resolve(true);
    const latestSession = await secondPreparation;
    firstFlush.resolve(true);

    await expect(firstPreparation).resolves.toBeNull();
    expect(latestSession).not.toBeNull();
    const clipboard = nativeClipboardEvent();
    expect(
      router.commitPreparedClipboardEvent(
        "copy",
        clipboard.event,
        latestSession!
      )
    ).toEqual({ kind: "committed", intent: "copy" });
    expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
    expect(feedback).toHaveBeenCalledTimes(1);
    expect(feedback).toHaveBeenLastCalledWith({
      status: "Copied.",
      error: null
    });
  });

  it("silently discards a stale failed clipboard preparation after a newer session succeeds", async () => {
    const firstFlush = deferred<boolean>();
    const feedback = vi.fn();
    const harness = dependencies({
      flushDrafts: vi
        .fn()
        .mockReturnValueOnce(firstFlush.promise)
        .mockResolvedValueOnce(true),
      onFeedback: feedback
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    const stalePreparation = router.prepareClipboard();
    const latestSession = await router.prepareClipboard();
    firstFlush.resolve(false);

    await expect(stalePreparation).resolves.toBeNull();
    expect(latestSession).not.toBeNull();
    expect(feedback).not.toHaveBeenCalled();

    const clipboard = nativeClipboardEvent();
    expect(
      router.commitPreparedClipboardEvent(
        "copy",
        clipboard.event,
        latestSession!
      )
    ).toEqual({ kind: "committed", intent: "copy" });
    expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("does not block a semantic command while background clipboard preparation is pending", async () => {
    const preparationFlush = deferred<boolean>();
    const harness = dependencies({
      flushDrafts: vi
        .fn()
        .mockReturnValueOnce(preparationFlush.promise)
        .mockResolvedValueOnce(true)
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    const preparation = router.prepareClipboard();
    const command = await router.execute({ type: "complete" });
    preparationFlush.resolve(true);

    expect(command.outcome).toBe("committed");
    await expect(preparation).resolves.toBeNull();
  });

  it("does not toggle command busy or clear existing status for successful background preparation", async () => {
    const busyChange = vi.fn();
    const feedback = vi.fn();
    const harness = dependencies({
      onBusyChange: busyChange,
      onFeedback: feedback
    });
    const router = createNotesSelectionCommandRouter(harness.deps);
    await router.execute({ type: "complete" });
    expect(feedback).toHaveBeenLastCalledWith({
      status: "Completed selection.",
      error: null
    });
    busyChange.mockClear();

    const session = await router.prepareClipboard();

    expect(session).not.toBeNull();
    expect(busyChange).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenLastCalledWith({
      status: "Completed selection.",
      error: null
    });
  });

  it("commits prepared native Copy synchronously through the event writer with zero mutation", async () => {
    const harness = dependencies();
    const router = createNotesSelectionCommandRouter(harness.deps);
    const session = await router.prepareClipboard();
    expect(session).not.toBeNull();
    const clipboard = nativeClipboardEvent();

    const outcome = router.commitPreparedClipboardEvent(
      "copy",
      clipboard.event,
      session!
    );

    expect(outcome).toEqual({ kind: "committed", intent: "copy" });
    expect(outcome).not.toBeInstanceOf(Promise);
    expect(clipboard.setData.mock.calls).toEqual([
      ["text/plain", "- A\n- B\n- C"],
      ["text/markdown", "- A\n- B\n- C"]
    ]);
    expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.deps.writeClipboard).not.toHaveBeenCalled();
    expect(harness.deps.applyBatch).not.toHaveBeenCalled();
  });

  it("consumes a prepared native Cut once and starts at most one async delete without navigator writing", async () => {
    const pendingDelete = deferred<NotesBatchCommandSettlement>();
    const harness = dependencies({
      applyBatch: vi.fn().mockReturnValue(pendingDelete.promise)
    });
    const router = createNotesSelectionCommandRouter(harness.deps);
    const session = await router.prepareClipboard();
    expect(session).not.toBeNull();
    const first = nativeClipboardEvent();
    const reused = nativeClipboardEvent();

    const firstOutcome = router.commitPreparedClipboardEvent(
      "cut",
      first.event,
      session!
    );
    const reusedOutcome = router.commitPreparedClipboardEvent(
      "cut",
      reused.event,
      session!
    );

    expect(firstOutcome).toEqual({ kind: "committed", intent: "cut" });
    expect(reusedOutcome).toEqual({ kind: "rejected", reason: "stale" });
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(reused.setData).not.toHaveBeenCalled();
    expect(reused.preventDefault).not.toHaveBeenCalled();
    expect(harness.deps.writeClipboard).not.toHaveBeenCalled();
    expect(harness.deps.applyBatch).toHaveBeenCalledTimes(1);

    pendingDelete.resolve({
      outcome: "committed",
      mutationCommitted: true,
      projectedWorkspace: authority(["tail"]).workspace
    });
    await vi.waitFor(() =>
      expect(harness.deps.replaceSelection).toHaveBeenCalledTimes(1)
    );
    expect(harness.deps.applyBatch).toHaveBeenCalledTimes(1);
  });

  it("captures prepared native Cut navigation ownership at commit, not prewarm", async () => {
    const harness = dependencies();
    const router = createNotesSelectionCommandRouter(harness.deps);
    const session = await router.prepareClipboard();
    harness.setNavigationVersion(14);

    router.commitPreparedClipboardEvent(
      "cut",
      nativeClipboardEvent().event,
      session!
    );

    await vi.waitFor(() =>
      expect(harness.deps.applyBatch).toHaveBeenCalledWith(
        expect.anything(),
        { type: "delete" },
        { focusNodeId: "tail", expectedNavigationVersion: 14 }
      )
    );
  });

  it("preserves newer focus when a prepared native Cut loses navigation ownership", async () => {
    const revision = 7;
    const pendingDelete = deferred<NotesBatchCommandSettlement>();
    const replaceSelection = vi.fn(
      (_selection, expectedRevision: number) => expectedRevision === revision
    );
    const focusNode = vi.fn();
    const harness = dependencies({
      getSelectionRevision: () => revision,
      applyBatch: vi.fn().mockReturnValue(pendingDelete.promise),
      replaceSelection,
      focusNode
    });
    const router = createNotesSelectionCommandRouter(harness.deps);
    const session = await router.prepareClipboard();

    router.commitPreparedClipboardEvent(
      "cut",
      nativeClipboardEvent().event,
      session!
    );
    pendingDelete.resolve({
      outcome: "committed",
      mutationCommitted: true,
      navigationOwned: false,
      projectedWorkspace: normalizeWorkspace({
        nodes: [node("tail", { sortKey: 1 })]
      })
    });

    await vi.waitFor(() =>
      expect(replaceSelection).toHaveBeenCalledWith(null, 7)
    );
    expect(focusNode).not.toHaveBeenCalled();
  });

  it.each(["stale", "authority", "rich", "writeFailure"] as const)(
    "leaves a rejected native Cut event unowned for %s preparation",
    async (condition) => {
      let revision = 7;
      let authorityCurrent = true;
      const richWorkspace = normalizeWorkspace({
        nodes: [node("a", { note: "supporting note" })]
      });
      const harness = dependencies({
        getSnapshot: () =>
          snapshot({
            selection: { anchorId: "a", headId: "a" },
            selectedNodeIds: ["a"],
            structuralRootIds: ["a"],
            eligibility: {
              ...snapshot().eligibility,
              copy: eligible(["a"]),
              cut: eligible(["a"])
            }
          }),
        getSelectionRevision: () => revision,
        isAuthorityCurrent: vi.fn(() => authorityCurrent),
        prepareAuthority: vi.fn().mockResolvedValue(
          authority(
            ["a"],
            condition === "rich" ? richWorkspace : authority(["a"]).workspace
          )
        )
      });
      const router = createNotesSelectionCommandRouter(harness.deps);
      const session = await router.prepareClipboard();
      expect(session).not.toBeNull();
      if (condition === "stale") {
        revision = 8;
      } else if (condition === "authority") {
        authorityCurrent = false;
      }
      const clipboard = nativeClipboardEvent({
        throwOnWrite: condition === "writeFailure"
      });

      const outcome = router.commitPreparedClipboardEvent(
        "cut",
        clipboard.event,
        session!
      );

      expect(outcome.kind).not.toBe("committed");
      if (condition !== "writeFailure") {
        expect(clipboard.setData).not.toHaveBeenCalled();
      }
      expect(clipboard.preventDefault).not.toHaveBeenCalled();
      expect(harness.deps.applyBatch).not.toHaveBeenCalled();
    }
  );

  it("invalidates a prepared clipboard session without touching the native event", async () => {
    const harness = dependencies();
    const router = createNotesSelectionCommandRouter(harness.deps);
    const session = await router.prepareClipboard();
    expect(session).not.toBeNull();
    router.invalidatePreparedClipboard();
    const clipboard = nativeClipboardEvent();

    const outcome = router.commitPreparedClipboardEvent(
      "copy",
      clipboard.event,
      session!
    );

    expect(outcome).toEqual({ kind: "rejected", reason: "stale" });
    expect(clipboard.setData).not.toHaveBeenCalled();
    expect(clipboard.preventDefault).not.toHaveBeenCalled();
  });

  it("reports clipboard success when the prepared Cut delete later skips", async () => {
    const feedback = vi.fn();
    const harness = dependencies({
      applyBatch: vi.fn().mockResolvedValue({
        outcome: "skipped",
        mutationCommitted: false
      }),
      onFeedback: feedback
    });
    const router = createNotesSelectionCommandRouter(harness.deps);
    const session = await router.prepareClipboard();
    const clipboard = nativeClipboardEvent();

    router.commitPreparedClipboardEvent("cut", clipboard.event, session!);

    await vi.waitFor(() =>
      expect(feedback).toHaveBeenLastCalledWith({
        status: "Copied.",
        error: "Notes changed, so nothing was removed."
      })
    );
    expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("aborts oversized clipboard forest construction before cloning every node", async () => {
    const nodes = [node("root", { sortKey: 1 })];
    for (let index = 0; index < MAX_PASTE_IMPORT_NODES; index += 1) {
      nodes.push(
        node(`child-${index}`, {
          parentId: "root",
          sortKey: index + 1
        })
      );
    }
    const normalized = normalizeWorkspace({ nodes });
    let nodeReads = 0;
    const trackedWorkspace = {
      ...normalized,
      nodesById: new Proxy(normalized.nodesById, {
        get(target, property, receiver) {
          if (typeof property === "string" && property in target) {
            nodeReads += 1;
          }
          return Reflect.get(target, property, receiver);
        }
      })
    };
    const feedback = vi.fn();
    const harness = dependencies({
      getSnapshot: () =>
        snapshot({
          selection: { anchorId: "root", headId: "root" },
          selectedNodeIds: ["root"],
          structuralRootIds: ["root"],
          eligibility: {
            ...snapshot().eligibility,
            copy: eligible(["root"]),
            cut: eligible(["root"])
          }
        }),
      prepareAuthority: vi
        .fn()
        .mockResolvedValue(authority(["root"], trackedWorkspace)),
      onFeedback: feedback
    });

    const session = await createNotesSelectionCommandRouter(
      harness.deps
    ).prepareClipboard();

    expect(session).toBeNull();
    expect(nodeReads).toBeLessThan(10);
    expect(feedback).toHaveBeenLastCalledWith({
      status: null,
      error: "The selected outline is too large or invalid to copy."
    });
  });

  it("bounds toolbar Cut forest construction before rich-content traversal", async () => {
    const nodes = [node("root", { sortKey: 1 })];
    for (let index = 0; index < MAX_PASTE_IMPORT_NODES; index += 1) {
      nodes.push(
        node(`child-${index}`, {
          parentId: "root",
          sortKey: index + 1
        })
      );
    }
    const normalized = normalizeWorkspace({ nodes });
    let nodeReads = 0;
    const trackedWorkspace = {
      ...normalized,
      nodesById: new Proxy(normalized.nodesById, {
        get(target, property, receiver) {
          if (typeof property === "string" && property in target) {
            nodeReads += 1;
          }
          return Reflect.get(target, property, receiver);
        }
      })
    };
    const targetedSnapshot = snapshot({
      selection: { anchorId: "root", headId: "root" },
      selectedNodeIds: ["root"],
      structuralRootIds: ["root"],
      eligibility: {
        ...snapshot().eligibility,
        copy: eligible(["root"]),
        cut: eligible(["root"])
      }
    });
    const harness = dependencies({
      getSnapshot: () => targetedSnapshot,
      prepareAuthority: vi
        .fn()
        .mockResolvedValue(authority(["root"], trackedWorkspace))
    });

    const result = await createNotesSelectionCommandRouter(
      harness.deps
    ).execute({ type: "cut" });

    expect(result.outcome).toBe("failed");
    expect(nodeReads).toBeLessThan(10);
    expect(harness.deps.writeClipboard).not.toHaveBeenCalled();
    expect(harness.deps.applyBatch).not.toHaveBeenCalled();
  });

  it("uses the exact partially eligible indent targets rather than expanding to the visible selection", async () => {
    const harness = dependencies();
    vi.mocked(harness.deps.prepareAuthority).mockImplementation(
      async (nodeIds) => authority(nodeIds)
    );
    const router = createNotesSelectionCommandRouter(harness.deps);

    await router.execute({ type: "indent" });

    expect(harness.deps.prepareAuthority).toHaveBeenCalledWith(["b", "c"]);
    expect(harness.deps.applyBatch).toHaveBeenCalledWith(
      expect.objectContaining({ selectedNodeIds: ["b", "c"] }),
      { type: "indent" },
      undefined
    );
  });

  it.each([
    [{ type: "complete" }, ["a", "b", "c"]],
    [
      {
        type: "addTag",
        tag: { prefix: "#", normalizedTag: "launch", displayTag: "Launch" }
      },
      ["a", "b", "c"]
    ],
    [
      {
        type: "removeTag",
        tag: { prefix: "#", normalizedTag: "launch" }
      },
      ["a", "b", "c"]
    ],
    [{ type: "duplicate" }, ["a", "c"]],
    [{ type: "delete" }, ["a", "c"]],
    [{ type: "copy" }, ["a", "c"]],
    [{ type: "cut" }, ["a", "c"]]
  ] as const)(
    "prepares the action-specific explicit-row or structural-root target for %j",
    async (intent, expectedIds) => {
      const structuralIds = ["a", "c"];
      const targetedSnapshot = snapshot({
        structuralRootIds: structuralIds,
        eligibility: {
          ...snapshot().eligibility,
          copy: eligible(structuralIds),
          cut: eligible(structuralIds),
          delete: eligible(structuralIds),
          duplicate: eligible(structuralIds)
        }
      });
      const harness = dependencies({ getSnapshot: () => targetedSnapshot });
      vi.mocked(harness.deps.prepareAuthority).mockImplementation(
        async (nodeIds) => authority(nodeIds)
      );

      await createNotesSelectionCommandRouter(harness.deps).execute(intent);

      expect(harness.deps.prepareAuthority).toHaveBeenCalledWith(expectedIds);
    }
  );

  it("maps explicit-row and structural intents to their authoritative batch targets", async () => {
    const harness = dependencies();
    vi.mocked(harness.deps.prepareAuthority).mockImplementation(
      async (nodeIds) => authority(nodeIds)
    );
    const router = createNotesSelectionCommandRouter(harness.deps);

    await router.execute({ type: "complete" });
    await router.execute({
      type: "addTag",
      tag: { prefix: "#", normalizedTag: "launch", displayTag: "Launch" }
    });
    await router.execute({ type: "outdent" });
    await router.execute({ type: "moveDown" });

    expect(harness.deps.prepareAuthority).toHaveBeenNthCalledWith(1, [
      "a",
      "b",
      "c"
    ]);
    expect(harness.deps.prepareAuthority).toHaveBeenNthCalledWith(2, [
      "a",
      "b",
      "c"
    ]);
    expect(harness.deps.prepareAuthority).toHaveBeenNthCalledWith(3, [
      "a",
      "b"
    ]);
    expect(harness.deps.applyBatch).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      { type: "complete" },
      undefined
    );
    expect(harness.deps.applyBatch).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      {
        type: "addTag",
        tag: {
          prefix: "#",
          normalizedTag: "launch",
          displayTag: "Launch"
        }
      },
      undefined
    );
    expect(harness.deps.applyBatch).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      {
        type: "move",
        parentId: null,
        afterId: "tail"
      },
      undefined
    );
  });

  it.each([
    {
      type: "moveUp" as const,
      selected: ["c", "d"],
      staleTarget: { parentId: null, afterId: "a" },
      freshNodes: [
        node("a", { sortKey: 1 }),
        node("b", { sortKey: 2 }),
        node("e", { sortKey: 3 }),
        node("c", { sortKey: 4 }),
        node("d", { sortKey: 5 })
      ],
      expectedTarget: { parentId: null, afterId: "b" }
    },
    {
      type: "moveDown" as const,
      selected: ["b", "c"],
      staleTarget: { parentId: null, afterId: "d" },
      freshNodes: [
        node("a", { sortKey: 1 }),
        node("b", { sortKey: 2 }),
        node("c", { sortKey: 3 }),
        node("e", { sortKey: 4 }),
        node("d", { sortKey: 5 })
      ],
      expectedTarget: { parentId: null, afterId: "e" }
    }
  ])(
    "recomputes $type as exactly one step in the freshly prepared sibling order",
    async ({ type, selected, staleTarget, freshNodes, expectedTarget }) => {
      const targetedSnapshot = snapshot({
        selection: { anchorId: "c", headId: "d" },
        selectedNodeIds: selected,
        structuralRootIds: selected,
        eligibility: {
          ...snapshot().eligibility,
          [type]: { ...eligible(selected), target: staleTarget }
        }
      });
      const freshWorkspace = normalizeWorkspace({ nodes: freshNodes });
      const harness = dependencies({
        getSnapshot: () => targetedSnapshot,
        prepareAuthority: vi
          .fn()
          .mockResolvedValue(authority(selected, freshWorkspace))
      });

      await createNotesSelectionCommandRouter(harness.deps).execute({ type });

      expect(harness.deps.applyBatch).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: freshWorkspace }),
        { type: "move", ...expectedTarget },
        undefined
      );
    }
  );

  it("forwards a valid multi-drag expansion target only with its prepared reorder", async () => {
    const harness = dependencies();

    await createNotesSelectionCommandRouter(harness.deps).execute({
      type: "reorder",
      target: { parentId: "tail", afterId: null },
      expandNodeId: "tail"
    });

    expect(harness.deps.applyBatch).toHaveBeenCalledWith(
      expect.anything(),
      {
        type: "move",
        parentId: "tail",
        afterId: null
      },
      { expandNodeId: "tail" }
    );
  });

  it("reports Complete direction from the freshly prepared authority, not a stale aggregate label", async () => {
    const completed = normalizeWorkspace({
      nodes: [
        node("a", { completedAt: "2026-07-15T01:00:00Z" }),
        node("b", { completedAt: "2026-07-15T01:00:00Z" }),
        node("c", { completedAt: "2026-07-15T01:00:00Z" })
      ]
    });
    const feedback = vi.fn();
    const harness = dependencies({
      // Deliberately stale: the rendered snapshot still says none complete.
      getSnapshot: () => snapshot({ completion: "none" }),
      prepareAuthority: vi
        .fn()
        .mockResolvedValue(authority(["a", "b", "c"], completed)),
      onFeedback: feedback
    });

    await createNotesSelectionCommandRouter(harness.deps).execute({
      type: "complete"
    });

    expect(feedback).toHaveBeenLastCalledWith({
      status: "Uncompleted selection.",
      error: null
    });
  });

  it("runs a Cut in flush, prepare, clipboard, revalidate, exactly-one delete order", async () => {
    const order: string[] = [];
    const tree = normalizeWorkspace({
      nodes: [
        node("a", { sortKey: 1, title: "Parent" }),
        node("child", {
          parentId: "a",
          sortKey: 1,
          title: "Child"
        }),
        node("tail", { sortKey: 2, title: "Tail" })
      ]
    });
    const cutSnapshot = snapshot({
      selection: { anchorId: "a", headId: "a" },
      selectedNodeIds: ["a"],
      structuralRootIds: ["a"],
      deleteFocusNodeId: "tail",
      eligibility: {
        ...snapshot().eligibility,
        cut: eligible(["a"])
      }
    });
    const prepared = authority(["a"], tree);
    const harness = dependencies({
      getSnapshot: () => cutSnapshot,
      flushDrafts: vi.fn(async () => {
        order.push("flush");
        return true;
      }),
      prepareAuthority: vi.fn(async () => {
        order.push("prepare");
        return prepared;
      }),
      writeClipboard: vi.fn(async (text) => {
        order.push(`clipboard:${text}`);
        return { kind: "success" as const, method: "plainText" as const };
      }),
      isAuthorityCurrent: vi.fn(() => {
        order.push("current");
        return true;
      }),
      applyBatch: vi.fn(async () => {
        order.push("delete");
        return {
          outcome: "committed" as const,
          mutationCommitted: true,
          projectedWorkspace: normalizeWorkspace({
            nodes: [node("tail", { sortKey: 1, title: "Tail" })]
          })
        };
      })
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    await router.execute({ type: "cut" });

    expect(order).toEqual([
      "flush",
      "prepare",
      "clipboard:- Parent\n  - Child",
      "current",
      "delete"
    ]);
    expect(harness.deps.applyBatch).toHaveBeenCalledTimes(1);
    expect(harness.deps.applyBatch).toHaveBeenCalledWith(
      prepared,
      { type: "delete" },
      { focusNodeId: "tail", expectedNavigationVersion: 11 }
    );
    expect(harness.deps.replaceSelection).toHaveBeenCalledWith(null, 7);
    expect(harness.deps.focusNode).toHaveBeenCalledWith("tail");
  });

  it("captures navigation ownership before an executing command awaits draft flush", async () => {
    const flush = deferred<boolean>();
    const harness = dependencies({
      flushDrafts: vi.fn().mockReturnValue(flush.promise)
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    const completion = router.execute({ type: "delete" });
    await vi.waitFor(() =>
      expect(harness.deps.flushDrafts).toHaveBeenCalledTimes(1)
    );
    harness.setNavigationVersion(15);
    flush.resolve(true);
    await completion;

    expect(harness.deps.applyBatch).toHaveBeenCalledWith(
      expect.anything(),
      { type: "delete" },
      { focusNodeId: "tail", expectedNavigationVersion: 11 }
    );
  });

  it("never deletes when Cut clipboard writing fails", async () => {
    const harness = dependencies({
      writeClipboard: vi.fn().mockResolvedValue({
        kind: "failure",
        message: "The clipboard could not be written."
      })
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    const result = await router.execute({ type: "cut" });

    expect(result.outcome).toBe("failed");
    expect(harness.deps.applyBatch).not.toHaveBeenCalled();
    expect(harness.deps.replaceSelection).not.toHaveBeenCalled();
  });

  it.each([
    [node("a", { note: "flushed supporting note" })],
    [node("a", { title: "line one\nline two" })]
  ])(
    "rechecks lossless Cut eligibility after flush and preparation",
    async (changedNode) => {
      const changed = normalizeWorkspace({ nodes: [changedNode] });
      const cutSnapshot = snapshot({
        selection: { anchorId: "a", headId: "a" },
        selectedNodeIds: ["a"],
        structuralRootIds: ["a"],
        eligibility: {
          ...snapshot().eligibility,
          cut: eligible(["a"])
        }
      });
      const harness = dependencies({
        getSnapshot: () => cutSnapshot,
        prepareAuthority: vi
          .fn()
          .mockResolvedValue(authority(["a"], changed))
      });
      const router = createNotesSelectionCommandRouter(harness.deps);

      const result = await router.execute({ type: "cut" });

      expect(result.outcome).toBe("skipped");
      expect(harness.deps.writeClipboard).not.toHaveBeenCalled();
      expect(harness.deps.applyBatch).not.toHaveBeenCalled();
    }
  );

  it("rechecks flushed attachments before Cut and does not copy or delete", async () => {
    const changed = normalizeWorkspace({
      nodes: [node("a")],
      attachmentsByNodeId: {
        a: [
          {
            id: "image",
            nodeId: "a",
            sortKey: 1,
            relativePath: "notes-assets/hash.png",
            contentHash: "a".repeat(64),
            originalName: "image.png",
            mimeType: "image/png",
            byteSize: 1,
            intrinsicWidth: 1,
            intrinsicHeight: 1,
            displayWidth: 160,
            createdAt: "2026-07-15T00:00:00Z",
            updatedAt: "2026-07-15T00:00:00Z"
          }
        ]
      }
    });
    const cutSnapshot = snapshot({
      selection: { anchorId: "a", headId: "a" },
      selectedNodeIds: ["a"],
      structuralRootIds: ["a"],
      eligibility: {
        ...snapshot().eligibility,
        cut: eligible(["a"])
      }
    });
    const harness = dependencies({
      getSnapshot: () => cutSnapshot,
      prepareAuthority: vi.fn().mockResolvedValue(authority(["a"], changed))
    });

    await createNotesSelectionCommandRouter(harness.deps).execute({
      type: "cut"
    });

    expect(harness.deps.writeClipboard).not.toHaveBeenCalled();
    expect(harness.deps.applyBatch).not.toHaveBeenCalled();
  });

  it("never deletes when Cut authority becomes stale after clipboard success", async () => {
    const harness = dependencies({
      isAuthorityCurrent: vi.fn().mockReturnValue(false)
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    const result = await router.execute({ type: "cut" });

    expect(result.outcome).toBe("skipped");
    expect(harness.deps.writeClipboard).toHaveBeenCalledTimes(1);
    expect(harness.deps.applyBatch).not.toHaveBeenCalled();
    expect(harness.deps.replaceSelection).not.toHaveBeenCalled();
  });

  it("reports the exact partial Cut failure and preserves selection when delete is rejected", async () => {
    const feedback = vi.fn();
    const harness = dependencies({
      applyBatch: vi.fn().mockResolvedValue({
        outcome: "failed",
        mutationCommitted: false
      }),
      onFeedback: feedback
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    await router.execute({ type: "cut" });

    expect(feedback).toHaveBeenLastCalledWith({
      status: "Copied.",
      error: "Copied, but couldn't remove."
    });
    expect(harness.deps.replaceSelection).not.toHaveBeenCalled();
  });

  it.each(["delete", "cut"] as const)(
    "preserves selection when committed %s cannot project the authoritative result",
    async (type) => {
      const feedback = vi.fn();
      const harness = dependencies({
        applyBatch: vi.fn().mockResolvedValue({
          outcome: "failed",
          mutationCommitted: true
        }),
        onFeedback: feedback
      });

      const result = await createNotesSelectionCommandRouter(
        harness.deps
      ).execute({ type });

      expect(result).toEqual({
        outcome: "failed",
        mutationCommitted: true
      });
      expect(harness.deps.replaceSelection).not.toHaveBeenCalled();
      expect(feedback).toHaveBeenLastCalledWith({
        status: type === "cut" ? "Cut selection." : "Deleted selection.",
        error:
          "The command completed, but the current view could not be refreshed."
      });
    }
  );

  it.each(["delete", "cut"] as const)(
    "clears the frozen range without restoring %s survivor focus after navigation ownership is lost",
    async (type) => {
      const focusNode = vi.fn();
      const replaceSelection = vi.fn(() => true);
      const harness = dependencies({
        applyBatch: vi.fn().mockResolvedValue({
          outcome: "committed",
          mutationCommitted: true,
          navigationOwned: false,
          projectedWorkspace: authority(["tail"]).workspace
        }),
        replaceSelection,
        focusNode
      });
      const router = createNotesSelectionCommandRouter(harness.deps);

      await router.execute({ type });

      expect(replaceSelection).toHaveBeenCalledWith(null, 7);
      expect(focusNode).not.toHaveBeenCalled();
    }
  );

  it("selects the full copied forest from the settlement projection without waiting for render", async () => {
    const afterDuplicate = normalizeWorkspace({
      nodes: [
        node("a", { sortKey: 1 }),
        node("b", { sortKey: 2 }),
        node("copy-a", { sortKey: 3 }),
        node("copy-a-child", { parentId: "copy-a", sortKey: 1 }),
        node("copy-b", { sortKey: 4 }),
        node("copy-b-child", { parentId: "copy-b", sortKey: 1 }),
        node("tail", { sortKey: 5 })
      ]
    });
    const projectedVisibleIds = [
      "a",
      "b",
      "copy-a",
      "copy-a-child",
      "copy-b",
      "copy-b-child",
      "tail"
    ];
    const getVisibleNodeIds = vi.fn(() => projectedVisibleIds);
    const harness = dependencies({
      getVisibleNodeIds,
      applyBatch: vi.fn().mockResolvedValue({
        outcome: "committed",
        mutationCommitted: true,
        duplicatedRootIds: ["copy-a", "copy-b"],
        projectedWorkspace: afterDuplicate
      })
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    const result = await router.execute({ type: "duplicate" });

    expect(result).toMatchObject({
      outcome: "committed",
      mutationCommitted: true
    });
    expect(harness.deps.replaceSelection).toHaveBeenCalledWith(
      { anchorId: "copy-a", headId: "copy-b-child" },
      7
    );
    expect(getVisibleNodeIds).toHaveBeenCalledWith(afterDuplicate);
  });

  it("preserves the original range when Duplicate committed but projection failed", async () => {
    const feedback = vi.fn();
    const harness = dependencies({
      applyBatch: vi.fn().mockResolvedValue({
        outcome: "failed",
        mutationCommitted: true,
        duplicatedRootIds: ["copy-a", "copy-b"]
      }),
      onFeedback: feedback
    });

    await createNotesSelectionCommandRouter(harness.deps).execute({
      type: "duplicate"
    });

    expect(harness.deps.replaceSelection).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenLastCalledWith({
      status: "Duplicated selection.",
      error: "The command completed, but the current view could not be refreshed."
    });
  });

  it("preserves the original range when a committed duplicate omits duplicatedRootIds", async () => {
    const feedback = vi.fn();
    const harness = dependencies({
      applyBatch: vi.fn().mockResolvedValue({
        outcome: "committed",
        mutationCommitted: true,
        projectedWorkspace: authority(["a", "b", "c"]).workspace
      }),
      onFeedback: feedback
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    await router.execute({ type: "duplicate" });

    expect(harness.deps.replaceSelection).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenLastCalledWith({
      status: "Duplicated selection.",
      error: "The copied selection could not be resolved."
    });
  });

  it("preserves the original range when copied roots cannot materialize as a visible forest", async () => {
    const feedback = vi.fn();
    const afterDuplicate = normalizeWorkspace({
      nodes: [
        node("a", { sortKey: 1 }),
        node("b", { sortKey: 2 }),
        node("c", { sortKey: 3 }),
        node("copy-a", { sortKey: 4 }),
        node("tail", { sortKey: 5 })
      ]
    });
    const harness = dependencies({
      getVisibleNodeIds: vi.fn(() => ["a", "b", "c", "tail"]),
      applyBatch: vi.fn().mockResolvedValue({
        outcome: "committed",
        mutationCommitted: true,
        duplicatedRootIds: ["copy-a"],
        projectedWorkspace: afterDuplicate
      }),
      onFeedback: feedback
    });

    await createNotesSelectionCommandRouter(harness.deps).execute({
      type: "duplicate"
    });

    expect(harness.deps.replaceSelection).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenLastCalledWith({
      status: "Duplicated selection.",
      error: "The copied selection could not be resolved."
    });
  });

  it("clears a successful non-destructive selection only when an endpoint became invisible", async () => {
    const harness = dependencies();
    harness.setVisibleNodeIds(["a", "b", "tail"]);
    const router = createNotesSelectionCommandRouter(harness.deps);

    await router.execute({ type: "complete" });

    expect(harness.deps.replaceSelection).toHaveBeenCalledWith(null, 7);
  });

  it("derives endpoint visibility from the completed-filter projection returned by the command", async () => {
    const completedAt = "2026-07-15T01:00:00Z";
    const afterComplete = normalizeWorkspace({
      nodes: [
        node("a", { sortKey: 1, completedAt }),
        node("b", { sortKey: 2, completedAt }),
        node("c", { sortKey: 3, completedAt }),
        node("tail", { sortKey: 4 })
      ]
    });
    const getVisibleNodeIds = vi.fn(
      (workspace: typeof afterComplete) =>
        workspace.rootIds.filter(
          (nodeId) => workspace.nodesById[nodeId].completedAt === null
        )
    );
    const harness = dependencies({
      getVisibleNodeIds,
      applyBatch: vi.fn().mockResolvedValue({
        outcome: "committed",
        mutationCommitted: true,
        projectedWorkspace: afterComplete
      })
    });

    await createNotesSelectionCommandRouter(harness.deps).execute({
      type: "complete"
    });

    expect(getVisibleNodeIds).toHaveBeenCalledWith(afterComplete);
    expect(harness.deps.replaceSelection).toHaveBeenCalledWith(null, 7);
  });

  it("preserves the range on skipped or backend-uncommitted failure", async () => {
    const harness = dependencies({
      applyBatch: vi
        .fn()
        .mockResolvedValueOnce({
          outcome: "skipped",
          mutationCommitted: false
        })
        .mockResolvedValueOnce({
          outcome: "failed",
          mutationCommitted: false
        })
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    await router.execute({ type: "complete" });
    await router.execute({ type: "complete" });

    expect(harness.deps.replaceSelection).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "complete" }],
    [
      {
        type: "addTag",
        tag: { prefix: "#", normalizedTag: "launch", displayTag: "Launch" }
      }
    ],
    [
      {
        type: "removeTag",
        tag: { prefix: "#", normalizedTag: "launch" }
      }
    ],
    [{ type: "indent" }],
    [{ type: "outdent" }],
    [{ type: "moveUp" }],
    [{ type: "moveDown" }],
    [
      {
        type: "reorder",
        target: { parentId: null, afterId: "tail" }
      }
    ],
    [
      {
        type: "moveTo",
        target: { parentId: "tail", afterId: null }
      }
    ],
    [{ type: "copy" }]
  ] as const)(
    "keeps the visible selection after successful non-destructive intent %j",
    async (intent) => {
      const harness = dependencies();
      const router = createNotesSelectionCommandRouter(harness.deps);

      await router.execute(intent);

      expect(harness.deps.replaceSelection).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["delete", "next"],
    ["delete", "previous"],
    ["delete", null],
    ["cut", "next"],
    ["cut", "previous"],
    ["cut", null]
  ] as const)(
    "%s applies the frozen %s survivor focus only after clearing at its revision",
    async (type, focusNodeId) => {
      const current = snapshot({ deleteFocusNodeId: focusNodeId });
      const order: string[] = [];
      const projectedWorkspace = normalizeWorkspace({
        nodes:
          focusNodeId === null
            ? []
            : [node(focusNodeId, { sortKey: 1 })]
      });
      const replaceSelection = vi.fn(() => {
        order.push("selection");
        return true;
      });
      const focusNode = vi.fn((nodeId: NoteId) => {
        order.push(`focus:${nodeId}`);
      });
      const harness = dependencies({
        getSnapshot: () => current,
        applyBatch: vi.fn().mockResolvedValue({
          outcome: "committed",
          mutationCommitted: true,
          projectedWorkspace
        }),
        replaceSelection,
        focusNode
      });
      const router = createNotesSelectionCommandRouter(harness.deps);

      await router.execute({ type });

      expect(harness.deps.applyBatch).toHaveBeenCalledWith(
        expect.anything(),
        { type: "delete" },
        { focusNodeId, expectedNavigationVersion: 11 }
      );
      expect(replaceSelection).toHaveBeenCalledWith(null, 7);
      if (focusNodeId === null) {
        expect(focusNode).not.toHaveBeenCalled();
        expect(order).toEqual(["selection"]);
      } else {
        expect(focusNode).toHaveBeenCalledWith(focusNodeId);
        expect(order).toEqual(["selection", `focus:${focusNodeId}`]);
      }
    }
  );

  it.each(["delete", "cut"] as const)(
    "does not restore the frozen survivor focus when selection changes during pending %s",
    async (type) => {
      let revision = 7;
      const settlement = deferred<NotesBatchCommandSettlement>();
      const focusNode = vi.fn();
      const replaceSelection = vi.fn(
        (_selection, expectedRevision: number) =>
          expectedRevision === revision
      );
      const harness = dependencies({
        getSelectionRevision: () => revision,
        applyBatch: vi.fn().mockReturnValue(settlement.promise),
        replaceSelection,
        focusNode
      });
      const router = createNotesSelectionCommandRouter(harness.deps);

      const completion = router.execute({ type });
      await vi.waitFor(() =>
        expect(harness.deps.applyBatch).toHaveBeenCalledTimes(1)
      );
      revision = 8;
      settlement.resolve({
        outcome: "committed",
        mutationCommitted: true,
        projectedWorkspace: authority(["tail"]).workspace
      });
      await completion;

      expect(harness.deps.applyBatch).toHaveBeenCalledWith(
        expect.anything(),
        { type: "delete" },
        { focusNodeId: "tail", expectedNavigationVersion: 11 }
      );
      expect(replaceSelection).toHaveBeenCalledWith(null, 7);
      expect(focusNode).not.toHaveBeenCalled();
    }
  );

  it("drops work after a failed draft flush or a selection revision change", async () => {
    const failedFlush = dependencies({
      flushDrafts: vi.fn().mockResolvedValue(false)
    });
    await createNotesSelectionCommandRouter(failedFlush.deps).execute({
      type: "complete"
    });
    expect(failedFlush.deps.prepareAuthority).not.toHaveBeenCalled();
    expect(failedFlush.deps.applyBatch).not.toHaveBeenCalled();

    const changed = dependencies();
    vi.mocked(changed.deps.flushDrafts).mockImplementation(async () => {
      changed.setRevision(8);
      return true;
    });
    await createNotesSelectionCommandRouter(changed.deps).execute({
      type: "complete"
    });
    expect(changed.deps.prepareAuthority).not.toHaveBeenCalled();
    expect(changed.deps.applyBatch).not.toHaveBeenCalled();
  });

  it("guards double activation synchronously and toggles busy exactly once", async () => {
    const flush = deferred<boolean>();
    const busy = vi.fn();
    const harness = dependencies({
      flushDrafts: vi.fn().mockReturnValue(flush.promise),
      onBusyChange: busy
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    const first = router.execute({ type: "complete" });
    const second = router.execute({ type: "complete" });

    await expect(second).resolves.toMatchObject({ outcome: "busy" });
    expect(harness.deps.flushDrafts).toHaveBeenCalledTimes(1);
    flush.resolve(true);
    await first;
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });

  it("Copy serializes the authoritative full forest without a repository mutation", async () => {
    const tree = normalizeWorkspace({
      nodes: [
        node("a", { title: "Parent" }),
        node("child", { parentId: "a", title: "Child" })
      ]
    });
    const copySnapshot = snapshot({
      selection: { anchorId: "a", headId: "a" },
      selectedNodeIds: ["a"],
      structuralRootIds: ["a"],
      eligibility: {
        ...snapshot().eligibility,
        copy: eligible(["a"])
      }
    });
    const harness = dependencies({
      getSnapshot: () => copySnapshot,
      prepareAuthority: vi.fn().mockResolvedValue(authority(["a"], tree))
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    await router.execute({ type: "copy" });

    expect(harness.deps.writeClipboard).toHaveBeenCalledWith(
      "- Parent\n  - Child"
    );
    expect(harness.deps.applyBatch).not.toHaveBeenCalled();
    expect(harness.deps.replaceSelection).not.toHaveBeenCalled();
  });

  it("surfaces ineligible reasons without flushing or mutating", async () => {
    const feedback = vi.fn();
    const harness = dependencies({ onFeedback: feedback });
    harness.setSnapshot(
      snapshot({
        eligibility: {
          ...snapshot().eligibility,
          duplicate: unavailable("Duplicate requires one parent.")
        }
      })
    );
    const router = createNotesSelectionCommandRouter(harness.deps);

    await router.execute({ type: "duplicate" });

    expect(feedback).toHaveBeenLastCalledWith({
      status: null,
      error: "Duplicate requires one parent."
    });
    expect(harness.deps.flushDrafts).not.toHaveBeenCalled();
  });

  it("commits a chooser against its frozen action snapshot and prepared authority, never the live selection", async () => {
    const openedSnapshot = snapshot({
      selection: { anchorId: "a", headId: "b" },
      selectedNodeIds: ["a", "b"],
      structuralRootIds: ["a", "b"],
      eligibility: {
        ...snapshot().eligibility,
        moveTo: eligible(["a", "b"])
      }
    });
    const openedAuthority = authority(["a", "b"]);
    const frozen: NotesFrozenSelectionCommandContext<NotesSelectionRouterAuthority> = {
      nodeIds: ["a", "b"],
      ownership: {
        actionSnapshot: openedSnapshot,
        authority: openedAuthority
      }
    };
    let freshAuthority: NotesSelectionRouterAuthority | null = null;
    const harness = dependencies({
      getSnapshot: () =>
        snapshot({
          selection: { anchorId: "c", headId: "c" },
          selectedNodeIds: ["c"],
          structuralRootIds: ["c"]
        }),
      prepareAuthority: vi.fn(async (nodeIds) => {
        freshAuthority = authority(nodeIds);
        return freshAuthority;
      })
    });
    const router = createNotesSelectionCommandRouter(harness.deps);

    await router.execute(
      {
        type: "addTag",
        tag: { prefix: "#", normalizedTag: "frozen", displayTag: "Frozen" }
      },
      frozen
    );

    expect(harness.deps.prepareAuthority).toHaveBeenCalledWith(["a", "b"]);
    expect(harness.deps.applyBatch).toHaveBeenCalledWith(
      freshAuthority,
      {
        type: "addTag",
        tag: { prefix: "#", normalizedTag: "frozen", displayTag: "Frozen" }
      },
      undefined
    );
  });

  it.each([
    [
      "Move",
      {
        type: "moveTo" as const,
        target: { parentId: "tail", afterId: null }
      }
    ],
    [
      "Tag",
      {
        type: "addTag" as const,
        tag: { prefix: "#" as const, normalizedTag: "frozen", displayTag: "Frozen" }
      }
    ]
  ])(
    "drops frozen chooser %s when its opened authority becomes stale during draft flush",
    async (_name, intent) => {
      const openedSnapshot = snapshot({
        selection: { anchorId: "a", headId: "b" },
        selectedNodeIds: ["a", "b"],
        structuralRootIds: ["a", "b"],
        eligibility: {
          ...snapshot().eligibility,
          moveTo: eligible(["a", "b"])
        }
      });
      const openedAuthority = authority(["a", "b"]);
      const frozen: NotesFrozenSelectionCommandContext<NotesSelectionRouterAuthority> = {
        nodeIds: ["a", "b"],
        ownership: {
          actionSnapshot: openedSnapshot,
          authority: openedAuthority
        }
      };
      let openedCurrent = true;
      const harness = dependencies({
        isAuthorityCurrent: vi.fn((candidate) =>
          candidate === openedAuthority ? openedCurrent : true
        ),
        flushDrafts: vi.fn(async () => {
          openedCurrent = false;
          return true;
        })
      });

      const result = await createNotesSelectionCommandRouter(
        harness.deps
      ).execute(intent, frozen);

      expect(result.outcome).toBe("skipped");
      expect(harness.deps.prepareAuthority).not.toHaveBeenCalled();
      expect(harness.deps.applyBatch).not.toHaveBeenCalled();
    }
  );

  it("drops a frozen chooser commit when its prepared ownership or revision is stale", async () => {
    const openedSnapshot = snapshot({
      selection: { anchorId: "a", headId: "b" },
      selectedNodeIds: ["a", "b"],
      structuralRootIds: ["a", "b"],
      eligibility: {
        ...snapshot().eligibility,
        moveTo: eligible(["a", "b"])
      }
    });
    const openedAuthority = authority(["a", "b"]);
    const frozen: NotesFrozenSelectionCommandContext<NotesSelectionRouterAuthority> = {
      nodeIds: ["a", "b"],
      ownership: {
        actionSnapshot: openedSnapshot,
        authority: openedAuthority
      }
    };
    const harness = dependencies({
      getSelectionRevision: () => 8,
      isAuthorityCurrent: vi.fn().mockReturnValue(false)
    });

    const result = await createNotesSelectionCommandRouter(
      harness.deps
    ).execute(
      {
        type: "moveTo",
        target: { parentId: "tail", afterId: null }
      },
      frozen
    );

    expect(result.outcome).toBe("skipped");
    expect(harness.deps.flushDrafts).not.toHaveBeenCalled();
    expect(harness.deps.prepareAuthority).not.toHaveBeenCalled();
    expect(harness.deps.applyBatch).not.toHaveBeenCalled();
  });
});

describe("useNotesSelectionCommandRouter", () => {
  it("exposes stable execution with reactive busy and feedback state", async () => {
    const flush = deferred<boolean>();
    const harness = dependencies({
      flushDrafts: vi.fn().mockReturnValue(flush.promise)
    });
    const { result } = renderHook(() =>
      useNotesSelectionCommandRouter(harness.deps)
    );

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.execute({ type: "complete" });
    });
    expect(result.current.busy).toBe(true);

    await act(async () => flush.resolve(true));
    await act(async () => completion);

    expect(result.current.busy).toBe(false);
    expect(result.current.status).toBe("Completed selection.");
    expect(result.current.error).toBeNull();
  });
});
