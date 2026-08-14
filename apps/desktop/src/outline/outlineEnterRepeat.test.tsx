import { act, fireEvent, render } from "@testing-library/react";
import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "../api";
import { NotesOutline } from "../NotesOutline";
import { NotesStore } from "../notesStore";
import { allocateSiblingSortKey, SORT_KEY_STEP } from "./outlineSortKeys";
import { stubGeometry } from "../test/outlineGeometry";

const BURST = 30;

function bullet(id: string, sortKey: number, text: string): NoteView {
  return {
    id,
    parentId: "page-1",
    sortKey,
    kind: "bullet",
    image: null,
    text,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function bootSnapshot(nodes: readonly NoteView[]): BootSnapshot {
  return {
    sessionId: "enter-session",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Today", sortKey: 1_024 }],
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [...nodes]
    },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
}

/**
 * A backend that allocates sort keys the way notes-core does: bisect the gap
 * between the neighbours, and renumber every sibling once the gap runs out. It
 * only knows the rows whose commands have already reached it, which is what
 * puts its numbering at odds with the optimistic rows still waiting.
 */
function serverModel(seed: readonly NoteView[]) {
  const nodes = new Map(seed.map((node) => [node.id, { ...node }]));
  let revision = 1;
  const insert = (
    id: string, parentId: string, beforeId: string | null, text: string
  ): NoteView[] => {
    const allocation = allocateSiblingSortKey(
      [...nodes.values()], parentId, beforeId);
    const created = bullet(id, allocation.sortKey, text);
    nodes.set(id, created);
    const changed = [created];
    for (const [nodeId, sortKey] of allocation.rebalancedSortKeys) {
      const node = nodes.get(nodeId);
      if (!node) continue;
      node.sortKey = sortKey;
      changed.push({ ...node });
    }
    return changed;
  };
  return {
    execute(envelope: { command: Record<string, unknown> }): MutationReceipt {
      revision += 1;
      const command = envelope.command as {
        kind: string; id: string; new_id?: string; parent_id?: string;
        before_id?: string | null; text?: string; prefix?: string;
        suffix?: string;
      };
      let changedNodes: NoteView[] = [];
      if (command.kind === "createNode") {
        changedNodes = insert(
          command.id, command.parent_id!, command.before_id ?? null,
          command.text ?? "");
      } else if (command.kind === "splitNode") {
        const source = nodes.get(command.id);
        if (source) source.text = command.prefix ?? "";
        changedNodes = insert(
          command.new_id!, command.parent_id!, command.before_id ?? null,
          command.suffix ?? "");
        if (source) changedNodes.push({ ...source });
      }
      return {
        revision,
        changedNodes,
        deletedIds: [],
        history: {
          canUndo: true, canRedo: false, undoDepth: revision, redoDepth: 0
        }
      };
    },
    order: () => [...nodes.values()]
      .filter((node) => node.parentId === "page-1")
      .sort((left, right) =>
        left.sortKey - right.sortKey || left.id.localeCompare(right.id))
      .map((node) => node.id)
  };
}

const EMPTY_RECEIPT: MutationReceipt = {
  revision: 2,
  changedNodes: [],
  deletedIds: [],
  history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
};

// Commands hang until the test releases them, which is what lets the
// keystrokes outrun the round trip the way holding Enter does.
async function deferredStore(
  nodes: readonly NoteView[],
  server?: ReturnType<typeof serverModel>
) {
  const inflight: (() => void)[] = [];
  const api = {
    bootstrap: vi.fn().mockResolvedValue(bootSnapshot(nodes)),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1,
      nodes: [],
      complete: true
    }),
    execute: vi.fn().mockImplementation((envelope) =>
      new Promise<MutationReceipt>((resolve) => {
        inflight.push(() =>
          resolve(server ? server.execute(envelope) : EMPTY_RECEIPT));
      })),
    importImageBytes: vi.fn(),
    importImagePaths: vi.fn(),
    replaceImageBytes: vi.fn(),
    replaceImagePath: vi.fn(),
    readImage: vi.fn(),
    viewImageOriginal: vi.fn(),
    downloadImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn(),
    exportNotes: vi.fn(),
    closeSession: vi.fn()
  } as unknown as NotesApi;
  const store = new NotesStore(api);
  await store.bootstrap();
  // Commands are serialized, so releasing one lets the next reach the fake
  // backend; draining means repeating until nothing new turns up.
  const release = async (limit = Number.POSITIVE_INFINITY) => {
    for (let index = 0; index < limit; index += 1) {
      if (inflight.length === 0) {
        if (limit !== Number.POSITIVE_INFINITY) return;
        await act(async () => undefined);
        if (inflight.length === 0) return;
      }
      await act(async () => {
        inflight.shift()!();
        await Promise.resolve();
      });
    }
  };
  return { store, inflight, release };
}

function outlineElement(store: NotesStore) {
  return (
    <NotesOutline
      store={store}
      status="ready"
      error={null}
      pendingWrites={0}
      page={{ id: "page-1", title: "Today" }}
      zoomRootId={null}
      onZoomRootChange={() => undefined}
      onHome={() => undefined}
      onTagClick={() => undefined}
      paneId="primary"
      restoreRequest={null}
    />
  );
}

function pageOrder(store: NotesStore): readonly string[] {
  return store.getSnapshot().nodes
    .filter((node) => node.parentId === "page-1" && !node.deleted)
    .slice()
    .sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id))
    .map((node) => node.id);
}

function renderedOrder(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-outline-id]")]
    .map((row) => row.dataset.outlineId!);
}

interface BurstResult {
  readonly order: readonly string[];
  readonly focusTrail: readonly (string | null)[];
}

/**
 * Fires `count` Enter keydowns the way an OS key repeat does: no keyup in
 * between, `repeat` set on everything after the first, and always aimed at
 * whatever holds the caret when the next repeat lands. `onKeystroke` stands in
 * for whatever the runtime gets around to between repeats.
 */
async function holdEnter(
  from: HTMLTextAreaElement,
  count: number,
  onKeystroke: (index: number) => Promise<void> = async () => undefined
): Promise<readonly (string | null)[]> {
  let target = from;
  target.focus();
  target.setSelectionRange(target.value.length, target.value.length);
  const trail: (string | null)[] = [];
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      fireEvent.keyDown(target, { key: "Enter", repeat: index > 0 });
    });
    await onKeystroke(index);
    const active = target.ownerDocument.activeElement;
    trail.push(active instanceof HTMLTextAreaElement
      ? active.dataset.nodeId ?? null
      : null);
    if (active instanceof HTMLTextAreaElement) target = active;
  }
  return trail;
}

function expectCleanRun(
  result: BurstResult,
  anchors: readonly [string, string],
  created: number
): void {
  const { order, focusTrail } = result;
  const at = order.indexOf(anchors[0]);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(new Set(order).size).toBe(order.length);
  const inserted = order.slice(at + 1, at + 1 + created);
  expect(inserted).toHaveLength(created);
  // Everything the burst made sits between the two anchors, in one run, and
  // the row that followed the anchor before the burst still follows it.
  expect(order[at + 1 + created]).toBe(anchors[1]);
  expect(focusTrail[focusTrail.length - 1]).toBe(inserted[created - 1]);
}

describe("holding Enter down", () => {
  it("adds one row per keystroke, in order, with the caret on the last", async () => {
    const { store, inflight } = await deferredStore([
      bullet("bullet-1", SORT_KEY_STEP, "First thought"),
      bullet("bullet-2", SORT_KEY_STEP * 2, "Second thought")
    ]);
    const view = render(outlineElement(store));
    await act(async () => undefined);
    const first = view.container.querySelector<HTMLTextAreaElement>(
      "textarea[data-node-id='bullet-1']")!;

    const focusTrail = await holdEnter(first, BURST);

    // Nothing committed while the burst ran, so every row on screen is
    // optimistic and any double counting would show up here.
    expect(inflight.length).toBeGreaterThan(0);
    const order = pageOrder(store);
    expectCleanRun({ order, focusTrail }, ["bullet-1", "bullet-2"], BURST);
    expect(renderedOrder(view.container)).toEqual(order);
    view.unmount();
  }, 120_000);

  it("keeps the run intact as the deferred creates land", async () => {
    const server = serverModel([
      // Legacy 1,024-spaced rows, which is what pages written before the sort
      // key widened still hold: the backend exhausts that gap and renumbers
      // its siblings partway through the burst, while the rows it has not seen
      // yet keep the numbering the client gave them.
      bullet("bullet-1", 1_024, "First thought"),
      bullet("bullet-2", 2_048, "Second thought")
    ]);
    const { store, inflight, release } = await deferredStore([
      bullet("bullet-1", 1_024, "First thought"),
      bullet("bullet-2", 2_048, "Second thought")
    ], server);
    const view = render(outlineElement(store));
    await act(async () => undefined);
    const first = view.container.querySelector<HTMLTextAreaElement>(
      "textarea[data-node-id='bullet-1']")!;

    const focusTrail = await holdEnter(first, BURST, async () => {
      if (inflight.length > 8) await release(1);
    });
    await release();

    const order = pageOrder(store);
    expectCleanRun({ order, focusTrail }, ["bullet-1", "bullet-2"], BURST);
    expect(order).toEqual(server.order());
    expect(renderedOrder(view.container)).toEqual(order);
    view.unmount();
  }, 120_000);

  it("does not lose or repeat a row when the run leaves the window", async () => {
    const restoreGeometry = stubGeometry();
    try {
      const { store } = await deferredStore(
        Array.from({ length: 2_000 }, (_, index) =>
          bullet(`node-${index}`, (index + 1) * SORT_KEY_STEP, `Row ${index}`)));
      const view = render(outlineElement(store));
      await act(async () => undefined);
      const scroller = view.container.querySelector<HTMLElement>(
        ".notes-outline-rows")!;
      const mounted = [...view.container.querySelectorAll<HTMLTextAreaElement>(
        "textarea[data-outline-field='title']")];
      const anchor = mounted[mounted.length - 2]!;
      const anchorId = anchor.dataset.nodeId!;
      const nextId = pageOrder(store)[pageOrder(store).indexOf(anchorId) + 1]!;
      anchor.focus();
      // Scroll away from the caret so the rows the burst creates land outside
      // the rendered window and have to be revealed before they can be
      // focused.
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        writable: true,
        value: 30_000
      });
      await act(async () => {
        fireEvent.scroll(scroller);
      });

      const focusTrail = await holdEnter(anchor, BURST, async () => {
        // One frame every few keystrokes, the way a runtime that cannot keep
        // up with the repeat rate would deliver them.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      });

      const order = pageOrder(store);
      expect(order).toHaveLength(2_000 + BURST);
      expectCleanRun({ order, focusTrail }, [anchorId, nextId], BURST);
      const rendered = renderedOrder(view.container);
      expect(new Set(rendered).size).toBe(rendered.length);
      // The window shows a contiguous stretch of the model, never a row the
      // model does not have and never one twice.
      expect(order.join("\n")).toContain(rendered.join("\n"));
      view.unmount();
    } finally {
      restoreGeometry();
    }
  }, 120_000);
});

describe("repeated Enter sort key cost", () => {
  // The widened SORT_KEY_STEP only changes how far apart new rows start, so
  // the measurement is the same burst against the two spacings: what pages
  // written before the widening hold, and what they hold after.
  async function measure(spacing: number): Promise<{
    readonly rebalances: number;
    readonly milliseconds: number;
  }> {
    const { store } = await deferredStore([
      bullet("bullet-1", spacing, "First thought"),
      bullet("bullet-2", spacing * 2, "Second thought")
    ]);
    const view = render(outlineElement(store));
    await act(async () => undefined);
    const first = view.container.querySelector<HTMLTextAreaElement>(
      "textarea[data-node-id='bullet-1']")!;
    let rebalances = 0;
    let previous = new Map(store.getSnapshot().nodes
      .map((node) => [node.id, node.sortKey]));
    const startedAt = performance.now();
    await holdEnter(first, BURST, async () => {
      const current = new Map(store.getSnapshot().nodes
        .map((node) => [node.id, node.sortKey]));
      // A rebalance is the only thing that moves a row that already existed.
      if ([...previous].some(([id, key]) =>
        current.has(id) && current.get(id) !== key)) rebalances += 1;
      previous = current;
    });
    const milliseconds = performance.now() - startedAt;
    view.unmount();
    return { rebalances, milliseconds };
  }

  it("stops rebalancing the siblings on every held Enter", async () => {
    const legacy = await measure(1_024);
    const widened = await measure(SORT_KEY_STEP);
    console.log(
      `${BURST} held Enters between two siblings: ` +
      `1,024 spacing ${legacy.rebalances} rebalances ` +
      `${legacy.milliseconds.toFixed(0)}ms, ` +
      `${SORT_KEY_STEP.toLocaleString("en-US")} spacing ` +
      `${widened.rebalances} rebalances ${widened.milliseconds.toFixed(0)}ms`
    );
    expect(legacy.rebalances).toBeGreaterThan(0);
    expect(widened.rebalances).toBe(0);
  }, 120_000);
});
