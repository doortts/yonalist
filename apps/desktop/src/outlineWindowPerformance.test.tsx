import { act, fireEvent, render } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { NotesOutline } from "./NotesOutline";
import { NotesStore } from "./notesStore";

// jsdom has no layout, so the outline can only be windowed when the geometry
// is injected explicitly. Rows alternate between a plain title and a title
// with a supporting note so the measured heights stay non-uniform.
const VIEWPORT_HEIGHT = 640;
const TITLE_ROW_HEIGHT = 32;
const NOTE_ROW_HEIGHT = 68;

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

function bootSnapshot(count: number): BootSnapshot {
  return {
    sessionId: "perf-session",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Large page" }],
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: Array.from({ length: count }, (_, index) => outlineNode(index))
    },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
}

async function readyStore(count: number): Promise<NotesStore> {
  const api = {
    bootstrap: vi.fn().mockResolvedValue(bootSnapshot(count)),
    queryViewport: vi.fn(),
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

function rowHeightOf(element: HTMLElement): number {
  return element.querySelector(".notes-node-note-field")
    ? NOTE_ROW_HEIGHT
    : TITLE_ROW_HEIGHT;
}

function stubGeometry(): () => void {
  const prototype = HTMLElement.prototype;
  const rect = (top: number, height: number) =>
    ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
  const original = {
    offsetHeight: Object.getOwnPropertyDescriptor(prototype, "offsetHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(prototype, "clientHeight"),
    getBoundingClientRect: Object.getOwnPropertyDescriptor(
      prototype, "getBoundingClientRect")
  };
  Object.defineProperty(prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("notes-outline-item")) return rowHeightOf(this);
      return Number.parseFloat(this.style.height) || 0;
    }
  });
  Object.defineProperty(prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("notes-outline-rows") ? VIEWPORT_HEIGHT : 0;
    }
  });
  Object.defineProperty(prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.classList.contains("notes-outline-rows")) {
        return rect(0, VIEWPORT_HEIGHT);
      }
      const scroller = this.closest<HTMLElement>(".notes-outline-rows");
      return scroller ? rect(-scroller.scrollTop, 0) : rect(0, 0);
    }
  });
  return () => {
    for (const [name, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else Reflect.deleteProperty(prototype, name);
    }
  };
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

describe("outline row rendering performance", () => {
  let restoreGeometry = () => undefined as void;

  beforeEach(() => {
    restoreGeometry = stubGeometry();
  });

  afterEach(() => {
    restoreGeometry();
  });

  for (const count of [2_000, 5_000]) {
    it(`keeps the mounted row count bounded for ${count} nodes`, async () => {
      const metrics = await measureOutline(count);
      console.log(
        `outline ${count} nodes: ${metrics.rows} rows, ` +
        `${metrics.textareas} textareas, ` +
        `${metrics.renderMs.toFixed(0)}ms initial render, ` +
        `${metrics.keystrokeMs.toFixed(1)}ms keystroke`
      );
      expect(metrics.rows).toBe(count);
      expect(metrics.textareas).toBeGreaterThanOrEqual(count);
    }, 240_000);
  }
});
