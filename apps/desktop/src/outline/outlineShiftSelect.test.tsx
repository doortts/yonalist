import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "../api";
import { NotesOutline } from "../NotesOutline";
import { NotesStore } from "../notesStore";
import { SORT_KEY_STEP } from "./outlineSortKeys";
import { appApi } from "../test/appApiFixture";

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

async function outline(
  nodes: readonly NoteView[],
  page: { id: string; title: string } = { id: "page-1", title: "Today" }
) {
  const queryForest = vi.fn().mockImplementation(
    (request: { readonly rootIds: readonly string[] }) => Promise.resolve({
      revision: 1,
      nodes: forestOf(nodes, request.rootIds),
      complete: true
    }));
  const api: NotesApi = {
    ...appApi(),
    bootstrap: vi.fn().mockResolvedValue(bootSnapshot(nodes)),
    queryForest,
    execute: vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }),
    search: vi.fn()
  };
  const store = new NotesStore(api);
  await store.bootstrap();
  const view = render(
    <NotesOutline
      store={store}
      status="ready"
      error={null}
      pendingWrites={0}
      page={page}
      zoomRootId={null}
      onZoomRootChange={() => undefined}
      onHome={() => undefined}
      onTagClick={() => undefined}
      paneId="primary"
      restoreRequest={null}
    />
  );
  await act(async () => undefined);
  return { view, api };
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

  // Two lit ranges at once read as two selections. Once the band holds the row,
  // the sweep it grew out of goes, and the caret stays at the end it moved to.
  it("drops the text swept upward when the band takes the row", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 4);

    await press(editor, "ArrowUp", { shiftKey: true });
    await press(editor, "ArrowUp", { shiftKey: true });

    expect(bandIds(view.container)).toEqual(["two"]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "two", start: 0, end: 0, direction: "none"
    });
  });

  it("drops the text swept downward when the band takes the row", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 0);

    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });

    expect(bandIds(view.container)).toEqual(["two"]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "two", start: 7, end: 7, direction: "none"
    });
  });

  // The head is the end the arrow is moving, so the caret rides it. A head the
  // pane has to scroll to would otherwise leave the caret on a row nobody is
  // looking at, and the pane would never scroll to the head at all.
  it("carries the caret onto the row the band grows onto", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 0);

    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });

    expect(bandIds(view.container)).toEqual(["two", "three"]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "three", start: 9, end: 9, direction: "none"
    });
  });

  it("carries the caret onto the row above when the band grows upward", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 4);

    await press(editor, "ArrowUp", { shiftKey: true });
    await press(editor, "ArrowUp", { shiftKey: true });
    await press(editor, "ArrowUp", { shiftKey: true });

    expect(bandIds(view.container)).toEqual(["one", "two"]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "one", start: 0, end: 0, direction: "none"
    });
  });

  // Giving a row back moves the head too, so the caret follows it the same way.
  it("carries the caret back when the band gives a row up", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 0);

    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowUp", { shiftKey: true });

    expect(bandIds(view.container)).toEqual(["two"]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "two", start: 0, end: 0, direction: "none"
    });
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

describe("Shift and Down across a parent that carries children", () => {
  const family = [
    bullet("parent", "page-1", SORT_KEY_STEP, "PARENT"),
    bullet("kid-one", "parent", SORT_KEY_STEP, "kid one"),
    bullet("kid-two", "parent", SORT_KEY_STEP * 2, "kid two"),
    bullet("kid-three", "parent", SORT_KEY_STEP * 3, "kid three"),
    bullet("after", "page-1", SORT_KEY_STEP * 2, "After")
  ] as const;
  const subtree = ["parent", "kid-one", "kid-two", "kid-three"];

  async function bandOverSubtree(container: HTMLElement) {
    const editor = await placeCaret(container, "parent", 0);
    // Sweep the title, then take the row -- which takes the three children with
    // it, since a band holding a parent holds its subtree.
    await press(editor, "ArrowDown", { shiftKey: true });
    expect(bandIds(container)).toEqual([]);
    await press(editor, "ArrowDown", { shiftKey: true });
    expect(bandIds(container)).toEqual(subtree);
    return editor;
  }

  it("reaches the next sibling on the press after the subtree", async () => {
    const { view } = await outline(family);
    const editor = await bandOverSubtree(view.container);

    await press(editor, "ArrowDown", { shiftKey: true });

    expect(bandIds(view.container)).toEqual([...subtree, "after"]);
  });

  async function bandOverSubtreeAndSibling(container: HTMLElement) {
    const editor = await bandOverSubtree(container);
    await press(editor, "ArrowDown", { shiftKey: true });
    expect(bandIds(container)).toEqual([...subtree, "after"]);
    return editor;
  }

  // The band can never fall below the anchor's own subtree, so the sizes stop at
  // four; what the fix buys is that the presses which cannot change them are
  // refused instead of walking the head down the subtree one child at a time.
  it("gives the sibling back on the first press and then holds", async () => {
    const { view } = await outline(family);
    const editor = await bandOverSubtreeAndSibling(view.container);

    const sizes = [bandIds(view.container).length];
    for (let count = 0; count < 6; count += 1) {
      await press(editor, "ArrowUp", { shiftKey: true });
      sizes.push(bandIds(view.container).length);
    }

    expect(sizes).toEqual([5, 4, 4, 4, 4, 4, 4]);
  });

  // Two presses put the head back on the anchor, so the third has the whole
  // subtree to step over and reaches the sibling again.
  it("reaches the sibling again on the first press back down", async () => {
    const { view } = await outline(family);
    const editor = await bandOverSubtreeAndSibling(view.container);

    await press(editor, "ArrowUp", { shiftKey: true });
    await press(editor, "ArrowUp", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });

    expect(bandIds(view.container)).toEqual([...subtree, "after"]);
  });

  it("steps past the visual end of the band a bare Down drops", async () => {
    const { view } = await outline(family);
    const editor = await bandOverSubtree(view.container);

    await press(editor, "ArrowDown");

    expect(bandIds(view.container)).toEqual([]);
    // Past the band's last visible row, which is the deepest child -- stepping
    // from the anchor instead would land back inside the subtree.
    expect(caretOf(view.container)).toEqual({
      nodeId: "after", start: 0, end: 0, direction: expect.anything()
    });
  });

  it("lands the caret at the band's first row for a bare Up", async () => {
    const { view } = await outline(family);
    const editor = await bandOverSubtree(view.container);

    await press(editor, "ArrowUp");

    expect(bandIds(view.container)).toEqual([]);
    // The band opened on the first row, so the step above it lands where a bare
    // arrow off that row lands: the page title.
    expect(caretOf(view.container)).toEqual({
      nodeId: "page-1", start: 0, end: 0, direction: expect.anything()
    });
  });

  it("leaves the caret in the row the band started from on Escape", async () => {
    const { view } = await outline(family);
    const editor = await bandOverSubtree(view.container);
    const before = caretOf(view.container);

    await press(editor, "Escape");

    expect(bandIds(view.container)).toEqual([]);
    expect(before?.nodeId).toBe("parent");
    expect(caretOf(view.container)).toEqual(before);
  });

  // The band collapses to its visible ends, not to the anchor and head, so a
  // band built upward hands the caret to the same rows a downward one does.
  it("collapses an upward band to the same rows", async () => {
    const { view } = await outline(family);
    const editor = await placeCaret(view.container, "after", 0);
    for (let press_ = 0; press_ < 5; press_ += 1) {
      await press(editor, "ArrowUp", { shiftKey: true });
    }
    expect(bandIds(view.container)).toEqual([...subtree, "after"]);

    await press(editor, "ArrowDown");

    expect(caretOf(view.container)).toEqual({
      nodeId: "after", start: 5, end: 5, direction: expect.anything()
    });
  });
});

describe("A bare arrow against a live row band", () => {
  async function bandAcross(container: HTMLElement) {
    const editor = await placeCaret(container, "two", 0);
    // Start, take the row, take the row above: "one" and "two" banded.
    await press(editor, "ArrowUp", { shiftKey: true });
    await press(editor, "ArrowUp", { shiftKey: true });
    expect(bandIds(container)).toEqual(["one", "two"]);
    return editor;
  }

  // A vertical arrow moves a line as it drops a swept span of letters, so it
  // moves a row as it drops a band: the row past the end it points at.
  it("drops the band and steps onto the row past its end", async () => {
    const { view } = await outline(rows);
    const editor = await bandAcross(view.container);

    await press(editor, "ArrowDown");

    expect(bandIds(view.container)).toEqual([]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "three", start: 0, end: 0, direction: expect.anything()
    });
  });

  it("drops the band and steps onto the row above its start", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 0);
    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });
    expect(bandIds(view.container)).toEqual(["two", "three"]);

    await press(editor, "ArrowUp");

    expect(bandIds(view.container)).toEqual([]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "one", start: 0, end: 0, direction: expect.anything()
    });
  });

  // Nothing past the band means nowhere to step, so the caret keeps the end it
  // would have landed on anyway.
  it("stays at the band's end when the outline runs out", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 0);
    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });

    await press(editor, "ArrowDown");

    expect(bandIds(view.container)).toEqual([]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "three", start: 9, end: 9, direction: expect.anything()
    });
  });

  it("drops the band and lands the caret at the band's start", async () => {
    const { view } = await outline(rows);
    const editor = await bandAcross(view.container);

    await press(editor, "ArrowLeft");

    expect(bandIds(view.container)).toEqual([]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "one", start: 0, end: 0, direction: expect.anything()
    });
  });

  it("leaves the caret alone when Escape drops the band", async () => {
    const { view } = await outline(rows);
    const editor = await bandAcross(view.container);
    const before = caretOf(view.container);

    await press(editor, "Escape");

    expect(bandIds(view.container)).toEqual([]);
    expect(caretOf(view.container)).toEqual(before);
  });
  // Backspace on a band is the band's key, not the caret's: the rows the
  // reader is looking at go, rather than a letter they cannot see.
  it.each(["Backspace", "Delete"])("trashes the band on %s", async (key) => {
    const { view, api } = await outline(rows);
    const editor = await bandAcross(view.container);

    await press(editor, key);

    expect(vi.mocked(api.execute).mock.calls.map(
      ([envelope]) => envelope.command
    )).toEqual([{ kind: "deleteSubtrees", ids: ["one", "two"] }]);
  });

  // The note field answers to none of the band's keys, so leaving the row for
  // it has to take the band with it.
  it("drops the band when the caret leaves the row for its note", async () => {
    const { view } = await outline(rows);
    const editor = await bandAcross(view.container);

    await press(editor, "Enter", { shiftKey: true });

    expect(bandIds(view.container)).toEqual([]);
    // The note field takes the caret a frame later, once it is mounted.
    await waitFor(() => expect(view.container.querySelector(
      "textarea[data-node-id='two'][data-outline-field='note']"
    )).toHaveFocus());
  });

});

describe("The modified vertical arrows against a live row band", () => {
  // Two lit things at once read as two selections, so the band goes when the
  // caret leaves it for the far end of the outline.
  it("drops the band on the way to the last row", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 0);
    await press(editor, "ArrowDown", { shiftKey: true });
    await press(editor, "ArrowDown", { shiftKey: true });
    expect(bandIds(view.container)).toEqual(["two"]);

    await press(editor, "ArrowDown", { ctrlKey: true });

    expect(bandIds(view.container)).toEqual([]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "three", start: 9, end: 9, direction: expect.anything()
    });
  });
});

describe("The modifier with A", () => {
  it("takes the row's text, then every visible row", async () => {
    const { view } = await outline(rows);
    const editor = await placeCaret(view.container, "two", 3);

    await press(editor, "a", { ctrlKey: true });

    expect(bandIds(view.container)).toEqual([]);
    expect(caretOf(view.container)).toEqual({
      nodeId: "two", start: 0, end: 7, direction: "forward"
    });

    await press(editor, "a", { ctrlKey: true });

    expect(bandIds(view.container)).toEqual(["one", "two", "three"]);
    // Two lit ranges at once read as two selections, so the swept text goes
    // when the band takes the rows.
    expect(caretOf(view.container)).toEqual({
      nodeId: "two", start: 7, end: 7, direction: "none"
    });
  });

  it("takes every visible row from a row with no text of its own", async () => {
    const { view } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "First row"),
      bullet("blank", "page-1", SORT_KEY_STEP * 2, "")
    ]);
    const editor = await placeCaret(view.container, "blank", 0);

    await press(editor, "a", { ctrlKey: true });

    expect(bandIds(view.container)).toEqual(["one", "blank"]);
  });
});

// Home is the root itself and the root is nobody's title, so the page has no
// heading there and the chord has to land on the first row instead.
describe("The modified Up where the page carries no title", () => {
  it("takes the first row", async () => {
    const homeRows = [
      bullet("one", "root", SORT_KEY_STEP, "First row"),
      bullet("two", "root", SORT_KEY_STEP * 2, "AAA BBB")
    ];
    const { view } = await outline(homeRows, { id: "root", title: "" });
    const editor = await placeCaret(view.container, "two", 3);

    await press(editor, "ArrowUp", { ctrlKey: true });

    expect(caretOf(view.container)).toEqual({
      nodeId: "one", start: 0, end: 0, direction: expect.anything()
    });
  });
});
