import { act, fireEvent, render } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { focusOutlineEditor } from "./outlineFocus";
import { NotesOutline } from "./NotesOutline";
import { NotesStore } from "./notesStore";
import { stubGeometry } from "./test/outlineGeometry";


function outlineNode(index: number): NoteView {
  return {
    id: `node-${index}`,
    parentId: "page-1",
    sortKey: (index + 1) * 1_024,
    kind: "bullet",
    image: null,
    text: `Row ${index}`,
    note: index % 5 === 0 ? `Supporting note ${index}` : "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function bootSnapshot(count: number, afterCursor: string | null = null): BootSnapshot {
  return {
    sessionId: "perf-session",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Large page", sortKey: 1_024 }],
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor,
      nodes: Array.from({ length: count }, (_, index) => outlineNode(index))
    },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
}

async function readyStore(
  count: number,
  afterCursor: string | null = null
): Promise<NotesStore> {
  const api = {
    bootstrap: vi.fn().mockResolvedValue(bootSnapshot(count, afterCursor)),
    queryViewport: vi.fn().mockResolvedValue({
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [outlineNode(count)]
    }),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1,
      nodes: [],
      complete: true
    }),
    execute: vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }),
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
  return store;
}


function outlineElement(store: NotesStore) {
  return (
    <NotesOutline
      store={store}
      status="ready"
      error={null}
      pendingWrites={0}
      page={{ id: "page-1", title: "Large page" }}
      zoomRootId={null}
      onZoomRootChange={() => undefined}
      onHome={() => undefined}
      onTagClick={() => undefined}
      paneId="primary"
      restoreRequest={null}
    />
  );
}

interface OutlineMetrics {
  readonly rows: number;
  readonly textareas: number;
  readonly renderMs: number;
  readonly keystrokeMs: number;
}

async function measureOutline(count: number): Promise<OutlineMetrics> {
  const store = await readyStore(count);
  const startedAt = performance.now();
  const view = render(outlineElement(store));
  await act(async () => undefined);
  const renderMs = performance.now() - startedAt;
  const container = view.container;
  const rows = container.querySelectorAll("[data-outline-id]").length;
  const textareas = container.querySelectorAll("textarea").length;
  const editor = container.querySelector<HTMLTextAreaElement>(
    "textarea[data-outline-field='title']"
  );
  if (!editor) throw new Error("the outline rendered no editable row");
  const keystrokeStartedAt = performance.now();
  await act(async () => {
    fireEvent.change(editor, { target: { value: `${editor.value}!` } });
  });
  const keystrokeMs = performance.now() - keystrokeStartedAt;
  view.unmount();
  return { rows, textareas, renderMs, keystrokeMs };
}

function report(count: number, metrics: OutlineMetrics): void {
  console.log(
    `outline ${count} nodes: ${metrics.rows} rows, ` +
    `${metrics.textareas} textareas, ` +
    `${metrics.renderMs.toFixed(0)}ms initial render, ` +
    `${metrics.keystrokeMs.toFixed(1)}ms keystroke`
  );
}

function outlineExtent(list: HTMLElement): number {
  return [...list.children].reduce(
    (total, child) => total + (child as HTMLElement).offsetHeight, 0);
}

function mountedRows(list: HTMLElement): (string | undefined)[] {
  return [...list.querySelectorAll<HTMLElement>("[data-outline-id]")]
    .map((row) => row.dataset.outlineId);
}

async function scrollTo(scroller: HTMLElement, position: number): Promise<void> {
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    value: position,
    writable: true
  });
  await act(async () => {
    fireEvent.scroll(scroller);
  });
}

// A spacer stands in for the rows the window left out, so it belongs at one
// end of the list or the other. One with rows on both sides of it is the blank
// band a stranded row leaves behind.
function expectNoInnerSpacer(list: HTMLElement): void {
  for (const child of [...list.children]) {
    if (child.classList.contains("notes-outline-item")) continue;
    expect(child.previousElementSibling === null ||
      child.nextElementSibling === null).toBe(true);
  }
}

describe("outline row rendering performance", () => {
  let restoreGeometry = () => undefined as void;

  beforeEach(() => {
    restoreGeometry = stubGeometry();
  });

  afterEach(() => {
    restoreGeometry();
  });

  it("mounts a bounded row count whatever the outline size", async () => {
    const small = await measureOutline(2_000);
    report(2_000, small);
    const large = await measureOutline(5_000);
    report(5_000, large);

    // Three screenfuls of 32px and 68px rows cannot hold sixty of them.
    expect(small.rows).toBeLessThan(60);
    expect(large.rows).toBe(small.rows);
    expect(large.textareas).toBeLessThan(small.rows * 2);
  }, 240_000);

  it("keeps the pagination anchor below the window and inside the scroller", async () => {
    const observed: {
      root: Element | Document | null;
      target: Element | null;
      callback: IntersectionObserverCallback;
    }[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit
      ) {
        this.entry = { root: options?.root ?? null, target: null, callback };
        observed.push(this.entry);
      }
      private readonly entry: (typeof observed)[number];
      observe(target: Element): void {
        this.entry.target = target;
      }
      disconnect(): void {}
    });
    try {
      const store = await readyStore(2_000, "cursor-1");
      const view = render(outlineElement(store));
      await act(async () => undefined);
      const anchor = view.container.querySelector<HTMLElement>(
        ".notes-outline-autoload")!;

      // Windowing unmounts whatever it does not render, so the anchor has to
      // live outside the row list; and the rows scroll in their own container,
      // so that container has to be the observer root or the rootMargin lead
      // is measured against the wrong box.
      expect(anchor).not.toBeNull();
      expect(anchor.closest(".notes-outline-list")).toBeNull();
      expect(observed).toHaveLength(1);
      expect(observed[0]!.target).toBe(anchor);
      expect(observed[0]!.root).toBe(
        view.container.querySelector(".notes-outline-rows"));

      await act(async () => {
        observed[0]!.callback(
          [{
            isIntersecting: true,
            target: anchor as Element
          } as IntersectionObserverEntry],
          {} as IntersectionObserver
        );
      });
      expect(store.getSnapshot().nodes.some(
        (node) => node.id === `node-2000`)).toBe(true);
      view.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 240_000);

  it("gives back exactly the removed row's height", async () => {
    // Small enough that scrolling to the end and back measures every row, so
    // the reserved height is the sum of real measurements with no estimate
    // left in it and the arithmetic below is exact.
    const store = await readyStore(60);
    const view = render(outlineElement(store));
    await act(async () => undefined);
    const scroller = view.container.querySelector<HTMLElement>(
      ".notes-outline-rows")!;
    const list = view.container.querySelector<HTMLElement>(
      ".notes-outline-list")!;
    await scrollTo(scroller, 1_400);
    await scrollTo(scroller, 600);

    const mounted = mountedRows(list);
    const victim = mounted[Math.floor(mounted.length / 2)]!;
    const victimHeight = list.querySelector<HTMLElement>(
      `[data-outline-id='${victim}']`)!
      .closest<HTMLElement>(".notes-outline-item")!.offsetHeight;
    const restingExtent = outlineExtent(list);

    await act(async () => {
      fireEvent.focus(list.querySelector(
        `[data-outline-id='${victim}'] textarea`)!);
      await store.beginRemoveEmptyNode(victim).committed;
    });

    // The removed row's height is the only thing the outline may give back,
    // and no gap spacer may open between two rows that are now neighbours.
    expect(mountedRows(list)).not.toContain(victim);
    expect(outlineExtent(list)).toBeCloseTo(restingExtent - victimHeight, 5);
    expectNoInnerSpacer(list);
    view.unmount();
  }, 240_000);

  it("measures only the rows it rendered itself", async () => {
    const store = await readyStore(2_000);
    const view = render(outlineElement(store));
    await act(async () => undefined);
    const scroller = view.container.querySelector<HTMLElement>(
      ".notes-outline-rows")!;
    const list = view.container.querySelector<HTMLElement>(
      ".notes-outline-list")!;
    await scrollTo(scroller, 8_000);
    const restingExtent = outlineExtent(list);

    // A row the outline did not put there — the shape a removal leaves behind
    // when a measurement pass and the rendered window fall out of step. Every
    // row after it must still be measured as itself, not as its neighbour.
    const intruder = document.createElement("li");
    intruder.className = "notes-outline-item";
    intruder.append(Object.assign(document.createElement("span"), {
      className: "notes-node-note-field"
    }));
    list.insertBefore(intruder, list.children[1]!);
    await act(async () => {
      fireEvent.scroll(scroller);
    });
    list.removeChild(intruder);

    expect(outlineExtent(list)).toBeCloseTo(restingExtent, -1);
    view.unmount();
  }, 240_000);

  it("follows the scroll position without changing the outline height", async () => {
    const store = await readyStore(2_000);
    const view = render(outlineElement(store));
    await act(async () => undefined);
    const scroller = view.container.querySelector<HTMLElement>(
      ".notes-outline-rows")!;
    const list = view.container.querySelector<HTMLElement>(
      ".notes-outline-list")!;
    const firstRow = () => list.querySelector<HTMLElement>("[data-outline-id]")
      ?.dataset.outlineId;
    const restingExtent = outlineExtent(list);
    expect(firstRow()).toBe("node-0");

    await scrollTo(scroller, 20_000);

    // 20,000px in at an average row height of 39.2px, less one screenful of
    // overscan, lands around row 494.
    const rowIndex = Number(firstRow()?.slice("node-".length));
    expect(rowIndex).toBeGreaterThan(450);
    expect(rowIndex).toBeLessThan(520);
    expect(outlineExtent(list)).toBeCloseTo(restingExtent, -1);
    view.unmount();
  }, 240_000);

  it("keeps the focused row mounted, and lets it go when focus does",
    async () => {
      const store = await readyStore(2_000);
      const view = render(outlineElement(store));
      await act(async () => undefined);
      const scroller = view.container.querySelector<HTMLElement>(
        ".notes-outline-rows")!;
      const list = view.container.querySelector<HTMLElement>(
        ".notes-outline-list")!;
      const editor = list.querySelector<HTMLTextAreaElement>(
        "[data-outline-id='node-3'] textarea")!;
      await act(async () => {
        fireEvent.focusIn(editor);
      });
      await scrollTo(scroller, 20_000);

      // The caret is in it, so it stays even though the window has left it
      // thousands of pixels behind.
      expect(mountedRows(list)).toContain("node-3");

      // The section wraps the scroller, so it stands for anywhere outside it.
      await act(async () => {
        fireEvent.focusOut(editor, {
          relatedTarget: view.container.querySelector(".notes-outline")
        });
      });

      expect(mountedRows(list)).not.toContain("node-3");
      expectNoInnerSpacer(list);
      view.unmount();
    }, 240_000);

  it("drops the pin with the row it was on", async () => {
    const store = await readyStore(2_000);
    const view = render(outlineElement(store));
    await act(async () => undefined);
    const scroller = view.container.querySelector<HTMLElement>(
      ".notes-outline-rows")!;
    const list = view.container.querySelector<HTMLElement>(
      ".notes-outline-list")!;
    await act(async () => {
      fireEvent.focusIn(list.querySelector(
        "[data-outline-id='node-3'] textarea")!);
      await store.beginRemoveEmptyNode("node-3").committed;
    });
    await scrollTo(scroller, 20_000);

    expect(mountedRows(list)).not.toContain("node-3");
    expectNoInnerSpacer(list);
    view.unmount();
  }, 240_000);

  it("holds a revealed row until the focus it was revealed for arrives",
    async () => {
      const store = await readyStore(2_000);
      const view = render(outlineElement(store));
      await act(async () => undefined);
      const list = view.container.querySelector<HTMLElement>(
        ".notes-outline-list")!;
      const scope = view.container.querySelector<HTMLElement>(
        ".notes-outline")!;
      const leaving = list.querySelector<HTMLTextAreaElement>(
        "[data-outline-id='node-0'] textarea")!;
      await act(async () => {
        fireEvent.focusIn(leaving);
      });

      // The reveal pins node-900 and scrolls to it, which unmounts the row the
      // caret is leaving. That row's parting focusout must not take the new
      // pin down with it before the reveal's own focus lands.
      await act(async () => {
        focusOutlineEditor(scope, "node-900", "end");
        fireEvent.focusOut(leaving, { relatedTarget: null });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      expect(mountedRows(list)).toContain("node-900");
      expect(document.activeElement).toBe(list.querySelector(
        "[data-outline-id='node-900'] textarea"));
      view.unmount();
    }, 240_000);
});
