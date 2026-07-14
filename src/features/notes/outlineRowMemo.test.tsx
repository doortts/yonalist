import { act, fireEvent, render, waitFor } from "@testing-library/react";
import {
  createElement,
  memo,
  Profiler,
  type ComponentProps
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteNode, NotesStore, NotesWorkspace } from "../../domain/notes";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesStateContext
} from "./NotesWorkspaceContext";
import { NotesOutlinePane } from "./NotesOutlinePane";
import {
  useNotesWorkspace,
  type UseNotesWorkspaceResult
} from "./useNotesWorkspace";

// Per-nodeId render counter for the outline rows. Hoisted so the vi.mock
// factory (also hoisted) can close over it without hitting the temporal dead
// zone.
const { rowRenderCounts } = vi.hoisted(() => ({
  rowRenderCounts: new Map<string, number>()
}));

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
    return createElement(
      Profiler,
      {
        id: props.nodeId,
        onRender: (id: string) => {
          rowRenderCounts.set(id, (rowRenderCounts.get(id) ?? 0) + 1);
        }
      },
      createElement(Real, props)
    );
  });
  return { ...actual, OutlineNodeRow: OutlineNodeRowProbe };
});

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
    workspace: workspace([]),
    replayedEntryId: null,
    canUndo: false,
    canRedo: false
  });
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    loadWorkspace: vi.fn().mockResolvedValue(workspace(nodes)),
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
    undo: replay,
    redo: replay,
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi.fn().mockResolvedValue({ attachmentCleanupFailed: false }),
    importAttachmentPaths: vi.fn().mockResolvedValue(workspace([])),
    importAttachmentBytes: vi.fn().mockResolvedValue(workspace([]))
  };
}

let captured: UseNotesWorkspaceResult | null = null;

function Harness({ store }: { store: NotesStore }) {
  const value = useNotesWorkspace({ vaultRoot: "/vault", repository: store });
  captured = value;
  return (
    <NotesActionsContext.Provider value={value.actionsSlice ?? value}>
      <NotesStateContext.Provider value={value.stateSlice ?? value}>
        <NotesDraftsContext.Provider value={value.draftsSlice ?? value}>
          <NotesOutlinePane />
        </NotesDraftsContext.Provider>
      </NotesStateContext.Provider>
    </NotesActionsContext.Provider>
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

describe("outline row memoization", () => {
  beforeEach(() => {
    rowRenderCounts.clear();
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

  it("re-renders only the rows whose selection membership flips (Phase 2.2 memo preserved)", async () => {
    const store = repository(seededNodes());
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await waitFor(() => {
      expect(document.querySelectorAll("[data-outline-id]").length).toBe(
        PARENT_COUNT + PARENT_COUNT * CHILDREN_PER_PARENT
      );
    });

    // Visible order starts p-0, c-0-0, c-0-1, c-0-2, ...; a range from p-0 to
    // c-0-1 covers exactly those three rows.
    const range = ["p-0", "c-0-0", "c-0-1"];
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
    // The three in-range rows re-rendered (their isSelected flipped true)...
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

  it("Shift+Click on a bullet selects the range from the caret node to the clicked row", async () => {
    const store = repository(seededNodes());
    render(<Harness store={store} />);
    await waitFor(() => expect(captured?.status).toBe("ready"));
    await waitFor(() => {
      expect(document.querySelectorAll("[data-outline-id]").length).toBe(
        PARENT_COUNT + PARENT_COUNT * CHILDREN_PER_PARENT
      );
    });

    // Place the caret (single-select anchor source) on p-0, then Shift+Click the
    // bullet on c-0-1.
    await act(async () => {
      await captured!.actions.focusNode("p-0");
    });
    const bullet = document
      .querySelector('[data-outline-id="c-0-1"]')
      ?.querySelector<HTMLButtonElement>('button[aria-label^="Zoom into"]');
    expect(bullet).toBeTruthy();
    await act(async () => {
      fireEvent.click(bullet!, { shiftKey: true });
    });

    expect(captured?.draftsSlice?.selection).toEqual({
      anchorId: "p-0",
      headId: "c-0-1"
    });
    for (const nodeId of ["p-0", "c-0-0", "c-0-1"]) {
      expect(
        document
          .querySelector(`[data-outline-id="${nodeId}"]`)
          ?.getAttribute("data-range-selected")
      ).toBe("true");
    }
    // A row just outside the range is not highlighted, and the plain-click zoom
    // did not fire (still at the root).
    expect(
      document
        .querySelector('[data-outline-id="c-0-2"]')
        ?.getAttribute("data-range-selected")
    ).toBeNull();
    expect(captured?.state.zoomRootId).toBeNull();
  });
});
