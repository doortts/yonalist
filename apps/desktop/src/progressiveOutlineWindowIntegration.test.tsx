import {
  act, fireEvent, render, screen, waitFor
} from "@testing-library/react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { App } from "./App";
import { NotesOutline } from "./NotesOutline";
import { NotesStore } from "./notesStore";
import { focusOutlineEditor } from "./outlineFocus";
import { appApi, snapshot } from "./test/appApiFixture";

class ControlledIntersectionObserver implements IntersectionObserver {
  static instances: ControlledIntersectionObserver[] = [];

  readonly root = null;
  readonly rootMargin = "";
  readonly scrollMargin = "";
  readonly thresholds = [0];
  private target: Element | null = null;

  constructor(private readonly callback: IntersectionObserverCallback) {
    ControlledIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }

  unobserve() {}

  disconnect() {
    this.target = null;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(isIntersecting: boolean) {
    if (!this.target) return;
    this.callback([{
      target: this.target,
      isIntersecting
    } as IntersectionObserverEntry], this);
  }
}

class ControlledResizeObserver implements ResizeObserver {
  static instances: ControlledResizeObserver[] = [];

  private target: Element | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }

  unobserve() {}

  disconnect() {
    this.target = null;
  }

  trigger(height: number) {
    if (!this.target) return;
    this.callback([{
      target: this.target,
      contentRect: { height }
    } as ResizeObserverEntry], this);
  }
}

function outlineNodes(count: number): NoteView[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    parentId: "page-1",
    sortKey: (index + 1) * 1_024,
    kind: "bullet",
    image: null,
    text: `Row ${index}`,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  }));
}

function apiWithRows(count: number) {
  const api = appApi();
  const nodes = outlineNodes(count);
  api.bootstrap = vi.fn().mockResolvedValue({
    ...snapshot,
    viewport: {
      ...snapshot.viewport!,
      nodes
    }
  });
  api.queryForest = vi.fn().mockImplementation(async (request) => ({
    revision: snapshot.revision,
    nodes: nodes.filter((node) => request.rootIds.includes(node.id)),
    complete: true
  }));
  return api;
}

function apiWithNextPage() {
  const api = apiWithRows(60);
  api.bootstrap = vi.fn().mockResolvedValue({
    ...snapshot,
    viewport: {
      ...snapshot.viewport!,
      afterCursor: "r:7:o:60",
      nodes: outlineNodes(60)
    }
  });
  api.queryViewport = vi.fn().mockResolvedValue({
    pageId: "page-1",
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    nodes: outlineNodes(120).slice(60)
  });
  return api;
}

describe("progressive outline window integration", () => {
  beforeEach(() => {
    ControlledIntersectionObserver.instances = [];
    ControlledResizeObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", ControlledIntersectionObserver);
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bounds the initial mounted rows and preserves the loaded tail height", async () => {
    const { container } = render(<App api={apiWithRows(140)} />);
    await screen.findByDisplayValue("Row 0");

    expect(container.querySelectorAll("[data-outline-id]")).toHaveLength(60);
    expect(container.querySelector("[data-outline-window-spacer]"))
      .toHaveStyle({ height: "2240px" });
    expect(screen.queryByDisplayValue("Row 60")).toBeNull();
  });

  it("materializes a hidden keyboard target before focusing it", async () => {
    const { container } = render(<App api={apiWithRows(140)} />);
    const first = await screen.findByDisplayValue("Row 0");
    const scope = first.closest<HTMLElement>(".notes-outline")!;

    act(() => {
      focusOutlineEditor(scope, "row-119", "start");
    });

    const target = await screen.findByDisplayValue("Row 119");
    await waitFor(() => expect(target).toHaveFocus());
    expect(container.querySelectorAll("[data-outline-id]")).toHaveLength(120);
    expect(container.contains(first)).toBe(true);
    expect(container.querySelector("[data-outline-window-spacer]"))
      .toHaveStyle({ height: "560px" });
  });

  it("grows the traversed prefix without evicting earlier rows", async () => {
    const { container } = render(<App api={apiWithRows(140)} />);
    const first = await screen.findByDisplayValue("Row 0");
    expect(container.querySelectorAll("[data-outline-id]")).toHaveLength(60);
    await waitFor(() =>
      expect(ControlledIntersectionObserver.instances).toHaveLength(1));

    act(() => {
      ControlledIntersectionObserver.instances[0]!.trigger(true);
    });

    await screen.findByDisplayValue("Row 119");
    expect(container.querySelectorAll("[data-outline-id]")).toHaveLength(120);
    expect(container.contains(first)).toBe(true);
  });

  it("continues the mounted prefix through the bounded SQLite cursor", async () => {
    const { container } = render(<App api={apiWithNextPage()} />);
    await screen.findByDisplayValue("Row 0");
    expect(container.querySelectorAll("[data-outline-id]")).toHaveLength(60);
    await waitFor(() =>
      expect(ControlledIntersectionObserver.instances).toHaveLength(1));

    act(() => {
      ControlledIntersectionObserver.instances[0]!.trigger(true);
    });

    await screen.findByDisplayValue("Row 119");
    expect(container.querySelectorAll("[data-outline-id]")).toHaveLength(120);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("refines the invisible tail height from mounted variable-height rows", async () => {
    const { container } = render(<App api={apiWithRows(140)} />);
    await screen.findByDisplayValue("Row 0");
    const spacer = container.querySelector(
      "[data-outline-window-spacer]"
    );
    expect(spacer).toHaveStyle({ height: "2240px" });
    expect(ControlledResizeObserver.instances).toHaveLength(1);

    act(() => {
      ControlledResizeObserver.instances[0]!.trigger(4_340);
    });

    await waitFor(() => expect(spacer).toHaveStyle({ height: "2800px" }));
  });

  it("materializes a keyboard selection that crosses the mounted tail", async () => {
    render(<App api={apiWithRows(140)} />);
    const boundary = await screen.findByDisplayValue(
      "Row 59"
    ) as HTMLTextAreaElement;
    act(() => {
      boundary.focus();
      boundary.setSelectionRange(boundary.value.length, boundary.value.length);
    });

    fireEvent.keyDown(boundary, {
      key: "ArrowDown",
      shiftKey: true
    });

    const selectedTail = await screen.findByDisplayValue("Row 60");
    expect(boundary).toBeInTheDocument();
    expect(selectedTail.closest("[data-outline-id]")).toHaveAttribute(
      "data-selected",
      "true"
    );
  });

  it("materializes a hidden pane-history focus before restoring its caret", async () => {
    const store = new NotesStore(apiWithRows(140));
    await store.bootstrap();
    render(
      <NotesOutline
        store={store}
        status="ready"
        error={null}
        pendingWrites={0}
        page={{ id: "page-1", title: "Today" }}
        zoomRootId={null}
        onZoomRootChange={vi.fn()}
        onTagClick={vi.fn()}
        paneId="primary"
        restoreRequest={{
          epoch: 1,
          selectedIds: [],
          focus: {
            nodeId: "row-119",
            field: "title",
            selectionStart: 3,
            selectionEnd: 5
          }
        }}
      />
    );

    const restored = await screen.findByDisplayValue(
      "Row 119"
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(restored).toHaveFocus());
    expect(restored.selectionStart).toBe(3);
    expect(restored.selectionEnd).toBe(5);
  });

  it("keeps progressive scrolling available without IntersectionObserver", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(<App api={apiWithRows(140)} />);
    await screen.findByDisplayValue("Row 0");
    const rows = container.querySelector<HTMLElement>(
      ".notes-outline-rows"
    )!;
    Object.defineProperties(rows, {
      scrollHeight: { configurable: true, value: 3_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 2_000, writable: true }
    });

    fireEvent.scroll(rows);

    await screen.findByDisplayValue("Row 119");
    expect(container.querySelectorAll("[data-outline-id]")).toHaveLength(120);
  });
});
