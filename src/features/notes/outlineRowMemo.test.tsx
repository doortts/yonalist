import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createElement,
  memo,
  Profiler,
  type ComponentProps,
  useMemo
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteNode, NotesStore, NotesWorkspace } from "../../domain/notes";
import { VaultRootContext } from "../../VaultRootContext";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesStateContext
} from "./NotesWorkspaceContext";
import { NotesOutlinePane } from "./NotesOutlinePane";
import {
  NotesFeedbackProvider,
  NotesStatusBarMessage
} from "./NotesFeedbackContext";
import { NotesImageResidencyProvider } from "./NotesImageResidencyContext";
import type { NotesBatchCommandSettlement } from "./notesCommands";
import {
  useNotesWorkspace,
  type UseNotesWorkspaceHookResult,
  type UseNotesWorkspaceResult
} from "./useNotesWorkspace";

// Per-nodeId render counter for the outline rows. Hoisted so the vi.mock
// factory (also hoisted) can close over it without hitting the temporal dead
// zone.
const { rowRenderCounts, rowPropRenderCounts, rowPropsTransform } = vi.hoisted(
  () => ({
    rowRenderCounts: new Map<string, number>(),
    rowPropRenderCounts: new Map<string, number>(),
    rowPropsTransform: {
      current: null as null | ((
        props: Record<string, unknown>
      ) => Record<string, unknown>)
    }
  })
);

// Replace OutlineNodeRow with a memo() probe that increments a per-node counter
// and delegates to the real component. Because the probe uses React's default
// shallow prop comparison — identical to the real component's own memo — it
// re-renders exactly when the row's props change. Counting probe renders
// therefore measures prop stability: a keystroke that leaves a sibling's props
// referentially unchanged must not bump that sibling's counter.
vi.mock("./OutlineNodeRow", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./OutlineNodeRow")>();
  const Real = actual.OutlineNodeRow;
  const OutlineNodeRowProbe = memo(function OutlineNodeRowProbe(
    props: ComponentProps<typeof Real>
  ) {
    rowPropRenderCounts.set(
      props.nodeId,
      (rowPropRenderCounts.get(props.nodeId) ?? 0) + 1
    );
    const renderedProps =
      rowPropsTransform.current?.(props as unknown as Record<string, unknown>) ??
      props;
    return createElement(
      Profiler,
      {
        id: props.nodeId,
        onRender: (id: string) => {
          rowRenderCounts.set(id, (rowRenderCounts.get(id) ?? 0) + 1);
        }
      },
      createElement(Real, renderedProps as ComponentProps<typeof Real>)
    );
  });
  return { ...actual, OutlineNodeRow: OutlineNodeRowProbe };
});

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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// 10 roots × 4 children = 50 nested nodes. Nesting is deliberate: children carry
// non-empty `ancestorGuideDepths` arrays, so if the pane recomputed the row
// projection every render (instead of memoizing) those arrays would churn and
// every child row would re-render on any keystroke.
const PARENT_COUNT = 10;
const CHILDREN_PER_PARENT = 4;

function seededNodes(): NoteNode[] {
  const nodes: NoteNode[] = [];
  for (let parent = 0; parent < PARENT_COUNT; parent += 1) {
    const parentId = `p-${parent}`;
    nodes.push(node({ id: parentId, sortKey: parent + 1, title: parentId }));
    for (let child = 0; child < CHILDREN_PER_PARENT; child += 1) {
      const childId = `c-${parent}-${child}`;
      nodes.push(
        node({
          id: childId,
          parentId,
          sortKey: child + 1,
          title: childId
        })
      );
    }
  }
  return nodes;
}

function repository(nodes: NoteNode[]): NotesStore {
  const empty = vi.fn().mockResolvedValue(workspace([]));
  const replay = vi.fn().mockResolvedValue({
    kind: "entryMissing" as const,
    canUndo: false,
    canRedo: false,
    historyEpoch: "epoch-a",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
  });
  return {
    initialize: vi.fn().mockResolvedValue({
      canUndo: false,
      canRedo: false,
      historyEpoch: "epoch-a",
      nextUndoEntryId: null,
      nextRedoEntryId: null,
      prunedEntryIds: []
    }),
    historyStatus: vi.fn().mockResolvedValue({
      canUndo: false,
      canRedo: false,
      historyEpoch: "epoch-a",
      nextUndoEntryId: null,
      nextRedoEntryId: null,
      prunedEntryIds: []
    }),
    loadWorkspace: vi.fn().mockResolvedValue(workspace(nodes)),
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
    undo: replay,
    redo: replay,
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
      historyReset: true,
      canUndo: false,
      canRedo: false,
      historyEpoch: "epoch-a",
      nextUndoEntryId: null,
      nextRedoEntryId: null,
      prunedEntryIds: []
    }),
    pruneHistoryEntries: vi.fn().mockResolvedValue({
      canUndo: false,
      canRedo: false,
      historyEpoch: "epoch-a",
      nextUndoEntryId: null,
      nextRedoEntryId: null,
      prunedEntryIds: []
    }),
    prepareNavigation: vi.fn().mockResolvedValue({
      canUndo: false,
      canRedo: false,
      historyEpoch: "epoch-a",
      nextUndoEntryId: null,
      nextRedoEntryId: null,
      prunedEntryIds: []
    }),
    closeHistorySession: vi.fn().mockResolvedValue(undefined),
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi.fn().mockResolvedValue({ attachmentCleanupFailed: false }),
    importAttachmentPaths: vi.fn().mockResolvedValue(workspace([])),
    importAttachmentBytes: vi.fn().mockResolvedValue(workspace([]))
  };
}

let captured: UseNotesWorkspaceHookResult | null = null;

function Harness({
  store,
  vaultRoot = "/vault",
  applyPreparedSelectionBatch
}: {
  store: NotesStore;
  vaultRoot?: string;
  applyPreparedSelectionBatch?: NonNullable<
    UseNotesWorkspaceResult["applyPreparedSelectionBatch"]
  >;
}) {
  const value = useNotesWorkspace({ vaultRoot, repository: store });
  captured = value;
  const baseActions = value.actionsSlice ?? value;
  const actionsValue = useMemo(
    () =>
      applyPreparedSelectionBatch
        ? {
            ...baseActions,
            applyPreparedSelectionBatch
          }
        : baseActions,
    [applyPreparedSelectionBatch, baseActions]
  );
  return (
    <VaultRootContext.Provider value={vaultRoot}>
      <NotesFeedbackProvider active>
        <NotesImageResidencyProvider scopeKey="memo-test">
          <NotesActionsContext.Provider value={actionsValue}>
            <NotesStateContext.Provider value={value.stateSlice ?? value}>
              <NotesDraftsContext.Provider value={value.draftsSlice ?? value}>
                <NotesOutlinePane />
              </NotesDraftsContext.Provider>
            </NotesStateContext.Provider>
          </NotesActionsContext.Provider>
        </NotesImageResidencyProvider>
        <div aria-label="Status bar feedback">
          <NotesStatusBarMessage />
        </div>
      </NotesFeedbackProvider>
    </VaultRootContext.Provider>
  );
}

function titleInput(nodeId: string): HTMLTextAreaElement {
  const input = document
    .querySelector(`[data-outline-id="${nodeId}"]`)
    ?.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit node title"]'
    );
  if (!input) {
    throw new Error(`No title input for ${nodeId}`);
  }
  return input;
}

function renderedOutlineIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-outline-id]")
  ).map((row) => row.dataset.outlineId!);
}

describe("outline row memoization", () => {
  beforeEach(() => {
    rowRenderCounts.clear();
    rowPropRenderCounts.clear();
    rowPropsTransform.current = null;
    captured = null;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true)
      }))
    );
  });

  afterEach(() => {
    rowPropsTransform.current = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exports OutlineNodeRow as a memoized component", async () => {
    const actual =
      await vi.importActual<typeof import("./OutlineNodeRow")>(
        "./OutlineNodeRow"
      );
    const exported = actual.OutlineNodeRow as unknown as {
      $$typeof?: symbol;
    };
    expect(exported.$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("reports a successful keyboard insertion preparation to the pane", async () => {
    const store = repository([node({ id: "leaf", title: "Leaf" })]);
    const prepared = vi.fn();
    rowPropsTransform.current = (props) => {
      const report = props.onKeyboardInsertionPrepared as
        | ((generation: number) => void)
        | undefined;
      return {
        ...props,
        onKeyboardInsertionPrepared: (generation: number) => {
          prepared(generation);
          report?.(generation);
        }
      };
    };
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    const title = titleInput("leaf");
    title.focus();
    title.setSelectionRange(title.value.length, title.value.length);

    fireEvent.keyDown(title, { key: "Enter" });

    await waitFor(() => expect(store.splitNode).toHaveBeenCalledOnce());
    expect(prepared).toHaveBeenCalledOnce();
    expect(prepared).toHaveBeenCalledWith(expect.any(Number));
  });

  it("reports a rejected prepared insertion as terminal without waiting for a publication", async () => {
    const store = repository([node({ id: "leaf", title: "Leaf" })]);
    vi.mocked(store.splitNode).mockRejectedValue(new Error("write failed"));
    const prepared = vi.fn();
    const terminated = vi.fn();
    rowPropsTransform.current = (props) => {
      const reportPrepared = props.onKeyboardInsertionPrepared as
        | ((generation: number) => void)
        | undefined;
      const reportTerminated = props.onKeyboardInsertionTerminated as
        | ((generation: number) => void)
        | undefined;
      return {
        ...props,
        onKeyboardInsertionPrepared: (generation: number) => {
          prepared(generation);
          reportPrepared?.(generation);
        },
        onKeyboardInsertionTerminated: (generation: number) => {
          terminated(generation);
          reportTerminated?.(generation);
        }
      };
    };
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    const title = titleInput("leaf");
    title.focus();
    title.setSelectionRange(title.value.length, title.value.length);

    fireEvent.keyDown(title, { key: "Enter" });

    await waitFor(() => expect(store.splitNode).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect({
        prepared: prepared.mock.calls,
        terminated: terminated.mock.calls
      }).toEqual({
        prepared: [[expect.any(Number)]],
        terminated: prepared.mock.calls
      })
    );
  });

  it("re-renders only the typed row (plus pane shell) on a keystroke", async () => {
    const store = repository(seededNodes());
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    // All 50 rows must be mounted before we baseline.
    await waitFor(() => {
      expect(document.querySelectorAll("[data-outline-id]").length).toBe(
        PARENT_COUNT + PARENT_COUNT * CHILDREN_PER_PARENT
      );
    });

    const target = "c-3-2";
    const input = titleInput(target);

    // Snapshot every row's render count immediately before the keystroke; the
    // absolute values are irrelevant, only the per-row delta matters.
    const before = new Map(rowRenderCounts);
    expect(before.size).toBe(PARENT_COUNT + PARENT_COUNT * CHILDREN_PER_PARENT);

    fireEvent.change(input, { target: { value: "c-3-2 edited" } });

    // The keystroke must actually have propagated into the drafts slice,
    // otherwise the isolation assertions below would pass vacuously.
    expect(captured?.draftsByNodeId[target]?.title).toBe("c-3-2 edited");

    // The typed row re-rendered...
    expect(rowRenderCounts.get(target)!).toBeGreaterThan(before.get(target)!);
    // ...and every other row's render count is untouched.
    const churned: string[] = [];
    for (const [nodeId, count] of rowRenderCounts) {
      if (nodeId === target) {
        continue;
      }
      if (count !== before.get(nodeId)) {
        churned.push(nodeId);
      }
    }
    expect(churned).toEqual([]);
  });

  it("does not re-render an image row when a text sibling draft changes", async () => {
    const store = repository([
      node({
        id: "image-row",
        nodeKind: "image",
        sortKey: 1,
        title: "diagram.png"
      }),
      node({ id: "text-row", sortKey: 2, title: "Text row" })
    ]);
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-outline-id]")
      ).toHaveLength(2)
    );

    const imageBefore = rowRenderCounts.get("image-row")!;
    fireEvent.change(titleInput("text-row"), {
      target: { value: "Text row edited" }
    });

    expect(captured?.draftsByNodeId["text-row"]?.title).toBe(
      "Text row edited"
    );
    expect(rowRenderCounts.get("image-row")).toBe(imageBefore);
  });

  it("re-renders only the typed row while zoomed into a subtree", async () => {
    const store = repository(seededNodes());
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));

    // Zooming rebuilds the body rows (rebased depth + regenerated guide
    // metadata), so this exercises the deriveOutlineBodyRows memo specifically.
    await act(async () => {
      await captured!.actions.zoomTo("p-3");
    });
    await waitFor(() => {
      expect(document.querySelectorAll("[data-outline-id]").length).toBe(
        CHILDREN_PER_PARENT
      );
    });

    const target = "c-3-2";
    const input = titleInput(target);
    const before = new Map(rowRenderCounts);

    fireEvent.change(input, { target: { value: "c-3-2 zoomed edit" } });

    expect(captured?.draftsByNodeId[target]?.title).toBe("c-3-2 zoomed edit");
    expect(rowRenderCounts.get(target)!).toBeGreaterThan(before.get(target)!);
    // Every other counter (the zoomed-in siblings, plus the now-unmounted rows
    // whose counts are frozen) must be untouched.
    const churned: string[] = [];
    for (const [nodeId, count] of rowRenderCounts) {
      if (nodeId === target) {
        continue;
      }
      if (count !== before.get(nodeId)) {
        churned.push(nodeId);
      }
    }
    expect(churned).toEqual([]);
  });

  it("retains unchanged row props through a full authoritative root reorder", async () => {
    const beforeNodes = seededNodes();
    const afterNodes = beforeNodes.map((item) =>
      item.id === "p-0"
        ? { ...item, sortKey: 2 }
        : item.id === "p-1"
          ? { ...item, sortKey: 1 }
          : { ...item }
    );
    const store = repository(beforeNodes);
    vi.mocked(store.moveNode).mockResolvedValue(workspace(afterNodes));
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await waitFor(() =>
      expect(document.querySelectorAll("[data-outline-id]")).toHaveLength(
        PARENT_COUNT + PARENT_COUNT * CHILDREN_PER_PARENT
      )
    );
    const unchangedId = "c-3-2";
    const unchangedBefore = rowPropRenderCounts.get(unchangedId);

    await act(async () => {
      await captured!.actions.moveNode({
        id: "p-1",
        parentId: null,
        afterId: null
      });
    });

    await waitFor(() =>
      expect(renderedOutlineIds().slice(0, 10)).toEqual([
        "p-1",
        "c-1-0",
        "c-1-1",
        "c-1-2",
        "c-1-3",
        "p-0",
        "c-0-0",
        "c-0-1",
        "c-0-2",
        "c-0-3"
      ])
    );
    expect(renderedOutlineIds()).toHaveLength(
      PARENT_COUNT + PARENT_COUNT * CHILDREN_PER_PARENT
    );
    expect(store.moveNode).toHaveBeenCalledOnce();
    expect(rowPropRenderCounts.get(unchangedId)).toBe(unchangedBefore);
  });

  it("retains unchanged final body row props through a zoomed full-result reorder", async () => {
    const beforeNodes = seededNodes();
    const afterNodes = beforeNodes.map((item) =>
      item.id === "c-3-0"
        ? { ...item, sortKey: 2 }
        : item.id === "c-3-1"
          ? { ...item, sortKey: 1 }
          : { ...item }
    );
    const store = repository(beforeNodes);
    vi.mocked(store.moveNode).mockResolvedValue(workspace(afterNodes));
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await act(async () => {
      await captured!.actions.zoomTo("p-3");
    });
    await waitFor(() =>
      expect(renderedOutlineIds()).toEqual([
        "c-3-0",
        "c-3-1",
        "c-3-2",
        "c-3-3"
      ])
    );
    const unchangedId = "c-3-2";
    const unchangedBefore = rowPropRenderCounts.get(unchangedId);

    await act(async () => {
      await captured!.actions.moveNode({
        id: "c-3-1",
        parentId: "p-3",
        afterId: null
      });
    });

    await waitFor(() =>
      expect(renderedOutlineIds()).toEqual([
        "c-3-1",
        "c-3-0",
        "c-3-2",
        "c-3-3"
      ])
    );
    expect(store.moveNode).toHaveBeenCalledOnce();
    expect(rowPropRenderCounts.get(unchangedId)).toBe(unchangedBefore);
  });

  it("does not reuse retained row metadata across Vault replacement", async () => {
    const nodes = [
      node({ id: "root", sortKey: 1 }),
      node({ id: "child", parentId: "root", sortKey: 1 })
    ];
    const oldStore = repository(nodes);
    const newStore = repository(nodes.map((item) => ({ ...item })));
    const childGuideReferences: unknown[] = [];
    rowPropsTransform.current = (props) => {
      if (props.nodeId === "child") {
        childGuideReferences.push(props.ancestorGuideDepths);
      }
      return props;
    };
    const rendered = render(
      <Harness store={oldStore} vaultRoot="/old-vault" />
    );
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await waitFor(() => expect(titleInput("child")).toBeInTheDocument());
    const oldGuideReference = childGuideReferences.at(-1);
    expect(oldGuideReference).toBeDefined();

    rendered.rerender(
      <Harness store={newStore} vaultRoot="/new-vault" />
    );

    await waitFor(() => expect(newStore.loadWorkspace).toHaveBeenCalled());
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await waitFor(() =>
      expect(childGuideReferences.at(-1)).not.toBe(oldGuideReference)
    );
  });

  it("re-renders only the rows whose selection membership flips (Phase 2.2 memo preserved)", async () => {
    const store = repository(seededNodes());
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await waitFor(() => {
      expect(document.querySelectorAll("[data-outline-id]").length).toBe(
        PARENT_COUNT + PARENT_COUNT * CHILDREN_PER_PARENT
      );
    });

    // The direct range ends at c-0-1, but selecting parent p-0 materializes its
    // whole visible subtree as the five selected rows.
    const range = ["p-0", "c-0-0", "c-0-1", "c-0-2", "c-0-3"];
    const before = new Map(rowRenderCounts);

    await act(async () => {
      captured!.actions.setSelectionAnchor("p-0");
      captured!.actions.extendSelectionTo("c-0-1");
    });

    // The selection actually landed on the drafts slice.
    expect(captured?.draftsSlice?.selection).toEqual({
      anchorId: "p-0",
      headId: "c-0-1"
    });
    // The five materialized rows re-rendered (their isSelected flipped true)...
    for (const nodeId of range) {
      expect(rowRenderCounts.get(nodeId)!).toBeGreaterThan(before.get(nodeId)!);
    }
    // ...and no other row's counter moved: selection rides the drafts slice, so
    // the state-context object the rows subscribe to never changed.
    const churned: string[] = [];
    for (const [nodeId, count] of rowRenderCounts) {
      if (range.includes(nodeId)) {
        continue;
      }
      if (count !== before.get(nodeId)) {
        churned.push(nodeId);
      }
    }
    expect(churned).toEqual([]);
  });

  it("keeps unselected row props stable while a selection command is busy and fails", async () => {
    const nodes = seededNodes();
    const store = repository(nodes);
    const batch = deferred<NotesBatchCommandSettlement>();
    const applyPreparedSelectionBatch: NonNullable<
      UseNotesWorkspaceResult["applyPreparedSelectionBatch"]
    > = vi.fn(() => batch.promise);
    render(
      <Harness
        store={store}
        applyPreparedSelectionBatch={applyPreparedSelectionBatch}
      />
    );
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await waitFor(() => {
      expect(document.querySelectorAll("[data-outline-id]").length).toBe(
        PARENT_COUNT + PARENT_COUNT * CHILDREN_PER_PARENT
      );
    });

    await act(async () => {
      captured!.actions.setSelectionAnchor("p-0");
      captured!.actions.extendSelectionTo("c-0-1");
    });
    const toolbar = await screen.findByRole("toolbar", {
      name: "Actions for 5 selected notes"
    });
    const complete = within(toolbar).getByRole("button", { name: "Complete" });
    await waitFor(() =>
      expect(complete).toHaveAttribute("aria-disabled", "false")
    );
    const before = new Map(rowRenderCounts);

    fireEvent.click(complete);
    await waitFor(() =>
      expect(complete).toHaveAttribute("aria-disabled", "true")
    );
    const selectedIds = ["p-0", "c-0-0", "c-0-1", "c-0-2", "c-0-3"];
    const busyChurn = [...before].flatMap(([nodeId, count]) =>
      !selectedIds.includes(nodeId) && rowRenderCounts.get(nodeId) !== count
        ? [nodeId]
        : []
    );
    expect(busyChurn).toEqual([]);

    await act(async () => batch.reject(new Error("batch failed")));
    expect(
      await within(screen.getByLabelText("Status bar feedback")).findByRole(
        "alert"
      )
    ).toHaveTextContent(/command couldn't be completed/i);
    const errorChurn = [...before].flatMap(([nodeId, count]) =>
      !selectedIds.includes(nodeId) && rowRenderCounts.get(nodeId) !== count
        ? [nodeId]
        : []
    );
    expect(errorChurn).toEqual([]);
  });

  it("Shift+Click prefers the active outline row over a stale selectedId", async () => {
    const store = repository(seededNodes());
    render(<Harness store={store} />);
    const user = userEvent.setup();
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await waitFor(() => {
      expect(document.querySelectorAll("[data-outline-id]").length).toBe(
        PARENT_COUNT + PARENT_COUNT * CHILDREN_PER_PARENT
      );
    });

    // Leave the reducer navigation stale on p-1, then place the real DOM caret
    // on p-0 without typing. Shift+Click must anchor from that active row.
    await act(async () => {
      await captured!.actions.focusNode("p-1");
    });
    act(() => titleInput("p-0").focus());
    expect(titleInput("p-0")).toHaveFocus();
    expect(captured?.state.selectedId).toBe("p-1");

    const bullet = document
      .querySelector('[data-outline-id="c-0-1"]')
      ?.querySelector<HTMLButtonElement>('button[aria-label^="Zoom into"]');
    expect(bullet).toBeTruthy();
    await user.keyboard("{Shift>}");
    await user.click(bullet!);
    await user.keyboard("{/Shift}");

    expect(captured?.draftsSlice?.selection).toEqual({
      anchorId: "p-0",
      headId: "c-0-1"
    });
    for (const nodeId of ["p-0", "c-0-0", "c-0-1", "c-0-2", "c-0-3"]) {
      expect(
        document
          .querySelector(`[data-outline-id="${nodeId}"]`)
          ?.getAttribute("data-range-selected")
      ).toBe("true");
    }
    // The selected parent closes over the rest of its visible subtree, while
    // the next root remains outside the selection. The plain-click zoom did not
    // fire (still at the root).
    expect(
      document
        .querySelector('[data-outline-id="p-1"]')
        ?.getAttribute("data-range-selected")
    ).toBeNull();
    expect(captured?.state.zoomRootId).toBeNull();
  });

  it("records real title and note focus but not pending programmatic focus twice", async () => {
    const nodes = seededNodes();
    nodes[0] = { ...nodes[0], note: "details" };
    render(<Harness store={repository(nodes)} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await waitFor(() => expect(titleInput("p-1")).toBeInTheDocument());
    expect(captured?.actions.getNavigationVersion).toBeTypeOf("function");

    const beforeTitle = captured!.actions.getNavigationVersion!();
    act(() => titleInput("p-1").focus());
    expect(captured!.actions.getNavigationVersion!()).toBe(beforeTitle + 1);

    const note = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Supporting note: p-0"]'
    );
    expect(note).toBeTruthy();
    const beforeNote = captured!.actions.getNavigationVersion!();
    act(() => note!.focus());
    expect(captured!.actions.getNavigationVersion!()).toBe(beforeNote + 1);

    const beforePendingFocus = captured!.actions.getNavigationVersion!();
    await act(async () => {
      await captured!.actions.focusNode("p-2");
    });
    await waitFor(() => expect(titleInput("p-2")).toHaveFocus());
    expect(captured!.actions.getNavigationVersion!()).toBe(
      beforePendingFocus + 1
    );
  });

  it("advances the navigation epoch when the same editor field is genuinely refocused", async () => {
    render(<Harness store={repository(seededNodes())} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    const title = titleInput("p-1");

    const beforeFirstFocus = captured!.actions.getNavigationVersion!();
    act(() => title.focus());
    expect(captured!.actions.getNavigationVersion!()).toBe(
      beforeFirstFocus + 1
    );

    act(() => title.blur());
    const beforeRefocus = captured!.actions.getNavigationVersion!();
    act(() => title.focus());
    expect(captured!.actions.getNavigationVersion!()).toBe(beforeRefocus + 1);
  });

  it("does not advance the navigation epoch for repeated draft changes in one focused field", async () => {
    render(<Harness store={repository(seededNodes())} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    const title = titleInput("p-1");
    act(() => title.focus());
    const focusedVersion = captured!.actions.getNavigationVersion!();

    fireEvent.change(title, { target: { value: "first" } });
    fireEvent.change(title, { target: { value: "second" } });

    expect(captured!.actions.getNavigationVersion!()).toBe(focusedVersion);
  });

  it("undoes one completed keyboard drop from the still-focused bullet", async () => {
    const before = [
      node({ id: "first", sortKey: 1, title: "First" }),
      node({ id: "second", sortKey: 2, title: "Second" })
    ];
    const after = [
      node({ id: "second", sortKey: 1, title: "Second" }),
      node({ id: "first", sortKey: 2, title: "First" })
    ];
    let active = before;
    let moveEntryId: string | null = null;
    const store = repository(before);
    // Replay preflight must validate the live session against the exact
    // cursor established by this completed keyboard drop.
    store.historyStatus = vi.fn(async (_vaultRoot, _sessionId) => ({
      canUndo: moveEntryId !== null,
      canRedo: false,
      historyEpoch: "epoch-a",
      nextUndoEntryId: moveEntryId,
      nextRedoEntryId: null,
      prunedEntryIds: []
    }));
    vi.mocked(store.loadWorkspace).mockImplementation(async () =>
      workspace(active)
    );
    const moveNode = vi.mocked(store.moveNode);
    moveNode.mockImplementation(async (_vaultRoot, _input, context) => {
      active = after;
      moveEntryId = context?.entryId ?? null;
      return {
        workspace: workspace(after),
        historyEntryId: moveEntryId,
        canUndo: true,
        canRedo: false,
        historyEpoch: "epoch-a",
        nextUndoEntryId: moveEntryId,
        nextRedoEntryId: null,
        prunedEntryIds: []
      };
    });
    const undo = vi.mocked(store.undo!);
    undo.mockImplementation(async () => {
      active = before;
      return {
        kind: "applied" as const,
        workspace: workspace(before),
        replayedEntryId: moveEntryId!,
        canUndo: false,
        canRedo: true,
        historyEpoch: "epoch-a",
        nextUndoEntryId: null,
        nextRedoEntryId: moveEntryId,
        prunedEntryIds: []
      };
    });
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    const user = userEvent.setup();
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    const rectangle = (top: number) =>
      ({
        x: 0,
        y: top,
        top,
        left: 0,
        right: 640,
        bottom: top + 28,
        width: 640,
        height: 28,
        toJSON: () => ({})
      }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const row = this.closest<HTMLElement>(".notes-node");
        const rows = Array.from(document.querySelectorAll(".notes-node"));
        return rectangle(row ? rows.indexOf(row) * 28 : 0);
      }
    );
    const bullet = await screen.findByRole("button", {
      name: "Zoom into Second"
    });

    bullet.focus();
    await user.keyboard("[Space][ArrowUp][Space]");
    await waitFor(() => expect(moveNode).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll<HTMLElement>("[data-outline-id]")).map(
          (row) => row.dataset.outlineId
        )
      ).toEqual(["second", "first"])
    );
    expect(bullet).toHaveFocus();

    expect(fireEvent.keyDown(bullet, { key: "z", metaKey: true })).toBe(false);
    await waitFor(() => expect(undo).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll<HTMLElement>("[data-outline-id]")).map(
          (row) => row.dataset.outlineId
        )
      ).toEqual(["first", "second"])
    );
  });

});
