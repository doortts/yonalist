import { act, fireEvent, render } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { NotesOutline } from "./NotesOutline";
import { NotesStore } from "./notesStore";
import { SORT_KEY_STEP } from "./outlineSortKeys";

function bullet(
  id: string,
  parentId: string,
  sortKey: number,
  text: string
): NoteView {
  return {
    id,
    parentId,
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
    sessionId: "sweep-session",
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

// The pane only trusts a band once the forest behind it has come back, so the
// stub answers with the real subtrees rather than an empty list.
function forestOf(
  nodes: readonly NoteView[],
  rootIds: readonly string[]
): readonly NoteView[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots = new Set(rootIds);
  return nodes.filter((node) => {
    let current: NoteView | undefined = node;
    const seen = new Set<string>();
    while (current && seen.add(current.id)) {
      if (roots.has(current.id)) return true;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  });
}

async function outline(nodes: readonly NoteView[]) {
  const queryForest = vi.fn().mockImplementation(
    (request: { readonly rootIds: readonly string[] }) => Promise.resolve({
      revision: 1,
      nodes: forestOf(nodes, request.rootIds),
      complete: true
    }));
  const api = {
    bootstrap: vi.fn().mockResolvedValue(bootSnapshot(nodes)),
    queryViewport: vi.fn(),
    queryForest,
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
  const view = render(
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
  await act(async () => undefined);
  return { view };
}

function field(container: HTMLElement, nodeId: string): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>(
    `textarea[data-node-id='${nodeId}'][data-outline-field='title']`
  )!;
}

function bandIds(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLElement>(
    ".notes-node[data-range-selected='true']"
  )].map((row) => row.dataset.outlineId!);
}

function caretOf(container: HTMLElement) {
  const active = container.ownerDocument.activeElement;
  if (!(active instanceof HTMLTextAreaElement)) return null;
  return {
    nodeId: active.dataset.nodeId,
    start: active.selectionStart,
    end: active.selectionEnd,
    direction: active.selectionDirection
  };
}

async function press(
  target: HTMLElement,
  key: string,
  init: Record<string, unknown> = {}
): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, { key, ...init });
  });
}

async function placeCaret(
  container: HTMLElement,
  nodeId: string,
  offset: number
): Promise<HTMLTextAreaElement> {
  const editor = field(container, nodeId);
  await act(async () => {
    editor.focus();
    editor.setSelectionRange(offset, offset);
  });
  return editor;
}

const rows = [
  bullet("one", "page-1", SORT_KEY_STEP, "First row"),
  bullet("two", "page-1", SORT_KEY_STEP * 2, "AAA BBB"),
  bullet("three", "page-1", SORT_KEY_STEP * 3, "Third row")
] as const;

describe("Shift and an arrow inside a bullet", () => {
  it("sweeps to the row's start, then takes the row, then its neighbour", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 4);

    await press(editor, "ArrowUp", { shiftKey: true });
    expect(caretOf(view.container)).toEqual({
      nodeId: "two", start: 0, end: 4, direction: "backward"
    });
    expect(bandIds(view.container)).toEqual([]);

    await press(editor, "ArrowUp", { shiftKey: true });
    expect(bandIds(view.container)).toEqual(["two"]);

    await press(editor, "ArrowUp", { shiftKey: true });
    expect(bandIds(view.container)).toEqual(["one", "two"]);
  });

  it("sweeps to the row's end, then takes the row, from its start", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 0);

    await press(editor, "ArrowDown", { shiftKey: true });
    expect(caretOf(view.container)).toEqual({
      nodeId: "two", start: 0, end: 7, direction: "forward"
    });
    expect(bandIds(view.container)).toEqual([]);

    await press(editor, "ArrowDown", { shiftKey: true });
    expect(bandIds(view.container)).toEqual(["two"]);

    await press(editor, "ArrowDown", { shiftKey: true });
    expect(bandIds(view.container)).toEqual(["two", "three"]);
  });

  // Taking a row re-anchors the band on it. A pointer that touched some other
  // row earlier leaves an anchor behind, and extending onto this row from that
  // anchor would hand back a band reaching all the way back to it.
  it("takes one row even after a pointer anchored another", async () => {
    const { view } = await outline(rows);
    await act(async () => {
      fireEvent.pointerDown(field(view.container, "one"), {
        button: 0,
        pointerId: 1
      });
      fireEvent.pointerUp(field(view.container, "one"), { pointerId: 1 });
    });
    // The caret already stands on the row's start, so one press takes the row.
    const editor = await placeCaret(view.container, "three", 0);

    await press(editor, "ArrowUp", { shiftKey: true });

    expect(bandIds(view.container)).toEqual(["three"]);
  });

  it("sweeps to the row's end from mid-row", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 4);

    await press(editor, "ArrowDown", { shiftKey: true });
    expect(caretOf(view.container)).toEqual({
      nodeId: "two", start: 4, end: 7, direction: "forward"
    });
  });
});
