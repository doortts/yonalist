import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { PaneCaret } from "./appNavigation";
import {
  NotesInteractionHistory,
  type InteractionHistoryStore
} from "./notesInteractionHistory";

interface Location {
  readonly pageId: string;
  readonly zoomRootId: string | null;
}

interface Row {
  readonly id: string;
  readonly text: string;
  readonly note?: string;
}

function store() {
  const listeners = new Set<
    Parameters<InteractionHistoryStore["subscribeHistory"]>[0]
  >();
  let capture: () => PaneCaret | null = () => null;
  const value: InteractionHistoryStore & {
    nodes: readonly NoteView[];
    readonly emitMutation: () => void;
  } = {
    nodes: [],
    flushAllDrafts: vi.fn().mockResolvedValue(undefined),
    undo: vi.fn().mockResolvedValue(undefined),
    redo: vi.fn().mockResolvedValue(undefined),
    breakHistoryGroup: vi.fn(),
    setCaretCapture: (next) => {
      capture = next;
    },
    subscribeHistory(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({
      canUndo: true,
      canRedo: true,
      nodes: value.nodes
    }),
    // Mirrors the command seam: the caret is read the moment the mutation
    // starts, and the entry the store emits carries it.
    emitMutation: () => {
      const caret = capture();
      listeners.forEach((listener) => listener({
        kind: "recordMutation",
        undoDepth: 1,
        redoDepth: 0,
        caret
      }));
    }
  };
  return value;
}

function bullet(row: Row, index: number): NoteView {
  return {
    id: row.id,
    parentId: "page-1",
    sortKey: (index + 1) * 1_024,
    kind: "bullet",
    image: null,
    text: row.text,
    note: row.note ?? "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

/** The pane the caret plumbing reads and writes, as the outline renders it. */
function renderPane(rows: readonly Row[]): void {
  document.body.innerHTML = "";
  const section = document.createElement("section");
  section.className = "notes-outline";
  section.dataset.outlinePaneId = "primary";
  for (const row of rows) {
    for (const [field, value] of [
      ["title", row.text],
      ...(row.note === undefined ? [] : [["note", row.note] as const])
    ] as const) {
      const editor = document.createElement("textarea");
      editor.dataset.nodeId = row.id;
      editor.dataset.outlineField = field;
      editor.value = value;
      section.append(editor);
    }
  }
  document.body.append(section);
}

function editor(nodeId: string, field = "title"): HTMLTextAreaElement {
  const found = document.querySelector<HTMLTextAreaElement>(
    `textarea[data-node-id="${nodeId}"][data-outline-field="${field}"]`
  );
  if (!found) throw new Error(`no ${field} editor for ${nodeId}`);
  return found;
}

function putCaret(nodeId: string, offset: number, field = "title"): void {
  const target = editor(nodeId, field);
  target.focus();
  target.setSelectionRange(offset, offset);
}

function caretHistory(
  rows: readonly Row[]
): ReturnType<typeof store> & {
  readonly history: NotesInteractionHistory<Location>;
  readonly settle: (next: readonly Row[]) => void;
} {
  const notesStore = store();
  const settle = (next: readonly Row[]) => {
    notesStore.nodes = next.map(bullet);
    renderPane(next);
  };
  settle(rows);
  const history = new NotesInteractionHistory<Location>(
    notesStore,
    vi.fn().mockResolvedValue(undefined)
  );
  return Object.assign(notesStore, { history, settle });
}

describe("notes interaction history", () => {
  it("restores a navigation location locally without replaying SQLite", async () => {
    const notesStore = store();
    const apply = vi.fn().mockResolvedValue(undefined);
    const history = new NotesInteractionHistory<Location>(notesStore, apply);
    const before = { pageId: "page", zoomRootId: null };
    const after = { pageId: "page", zoomRootId: "child" };

    history.recordNavigation(before, after);
    await history.undo();
    await history.redo();

    expect(apply).toHaveBeenNthCalledWith(1, before);
    expect(apply).toHaveBeenNthCalledWith(2, after);
    expect(notesStore.undo).not.toHaveBeenCalled();
    expect(notesStore.redo).not.toHaveBeenCalled();
    expect(notesStore.breakHistoryGroup).toHaveBeenCalledOnce();
  });

  it("interleaves navigation and mutation entries in user order", async () => {
    const notesStore = store();
    const apply = vi.fn().mockResolvedValue(undefined);
    const history = new NotesInteractionHistory<Location>(notesStore, apply);
    const before = { pageId: "page", zoomRootId: null };
    const after = { pageId: "page", zoomRootId: "child" };
    notesStore.emitMutation();
    history.recordNavigation(before, after);
    notesStore.emitMutation();

    await history.undo();
    await history.undo();
    await history.undo();
    await history.redo();
    await history.redo();
    await history.redo();

    expect(notesStore.undo).toHaveBeenCalledTimes(2);
    expect(notesStore.redo).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenNthCalledWith(1, before);
    expect(apply).toHaveBeenNthCalledWith(2, after);
  });

  it("folds the mutation that moved the view into one entry", async () => {
    const notesStore = store();
    const apply = vi.fn().mockResolvedValue(undefined);
    const history = new NotesInteractionHistory<Location>(notesStore, apply);
    const before = { pageId: "page", zoomRootId: null };
    const after = { pageId: "new-page", zoomRootId: null };
    // "New page": the command lands first and the view follows it.
    notesStore.emitMutation();
    history.recordMutationNavigation(before, after);

    await history.undo();

    expect(notesStore.undo).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(before);
    // Nothing left behind for a second press.
    await history.undo();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("replays the store before the view when redoing that entry", async () => {
    const notesStore = store();
    const apply = vi.fn().mockResolvedValue(undefined);
    const history = new NotesInteractionHistory<Location>(notesStore, apply);
    const before = { pageId: "page", zoomRootId: null };
    const after = { pageId: "new-page", zoomRootId: null };
    notesStore.emitMutation();
    history.recordMutationNavigation(before, after);
    await history.undo();

    await history.redo();

    expect(notesStore.redo).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenLastCalledWith(after);
  });

  it("leaves an unrelated mutation of its own alone", async () => {
    const notesStore = store();
    const apply = vi.fn().mockResolvedValue(undefined);
    const history = new NotesInteractionHistory<Location>(notesStore, apply);
    const before = { pageId: "page", zoomRootId: null };
    const after = { pageId: "new-page", zoomRootId: null };
    // A draft flushed on the way out, then the page creation itself.
    notesStore.emitMutation();
    notesStore.emitMutation();
    history.recordMutationNavigation(before, after);

    await history.undo();
    await history.undo();

    expect(notesStore.undo).toHaveBeenCalledTimes(2);
  });

  it("records a draft flushed immediately before Undo as the newest entry", async () => {
    const notesStore = store();
    notesStore.flushAllDrafts = vi.fn(async () => notesStore.emitMutation());
    const history = new NotesInteractionHistory<Location>(
      notesStore,
      vi.fn().mockResolvedValue(undefined)
    );
    history.recordNavigation(
      { pageId: "page", zoomRootId: null },
      { pageId: "page", zoomRootId: "child" }
    );

    await history.undo();

    expect(notesStore.undo).toHaveBeenCalledOnce();
  });
});

describe("history caret", () => {
  it("puts the caret back at the offset the mutation started from", async () => {
    const notesStore = caretHistory([{ id: "bullet-1", text: "어우우우야" }]);
    putCaret("bullet-1", 2);
    // Enter splits the row; the caret it started from is offset 2.
    notesStore.emitMutation();
    notesStore.settle([
      { id: "bullet-1", text: "어우" },
      { id: "bullet-2", text: "우우야" }
    ]);
    putCaret("bullet-2", 0);
    notesStore.undo = vi.fn(async () =>
      notesStore.settle([{ id: "bullet-1", text: "어우우우야" }]));

    await notesStore.history.undo();

    expect(editor("bullet-1")).toHaveFocus();
    expect([
      editor("bullet-1").selectionStart,
      editor("bullet-1").selectionEnd
    ]).toEqual([2, 2]);
  });

  it("restores a caret mid-text rather than the end of the row", async () => {
    const notesStore = caretHistory([{ id: "bullet-1", text: "before" }]);
    putCaret("bullet-1", 3);
    notesStore.emitMutation();
    notesStore.settle([{ id: "bullet-1", text: "beXYZfore" }]);
    putCaret("bullet-1", 6);
    notesStore.undo = vi.fn(async () =>
      notesStore.settle([{ id: "bullet-1", text: "before" }]));

    await notesStore.history.undo();

    expect(editor("bullet-1").selectionStart).toBe(3);
  });

  it("restores the caret inside a row a delete had removed", async () => {
    const notesStore = caretHistory([
      { id: "bullet-1", text: "First" },
      { id: "bullet-2", text: "Second" }
    ]);
    putCaret("bullet-2", 3);
    notesStore.emitMutation();
    notesStore.settle([{ id: "bullet-1", text: "First" }]);
    notesStore.undo = vi.fn(async () => notesStore.settle([
      { id: "bullet-1", text: "First" },
      { id: "bullet-2", text: "Second" }
    ]));

    await notesStore.history.undo();

    expect(editor("bullet-2")).toHaveFocus();
    expect(editor("bullet-2").selectionStart).toBe(3);
  });

  it("falls back to the previous sibling when the recorded row is gone", async () => {
    const notesStore = caretHistory([
      { id: "bullet-1", text: "First" },
      { id: "bullet-2", text: "Second" }
    ]);
    putCaret("bullet-2", 4);
    notesStore.emitMutation();
    // Undoing the step that created bullet-2 takes the recorded row with it.
    notesStore.undo = vi.fn(async () =>
      notesStore.settle([{ id: "bullet-1", text: "First" }]));

    await notesStore.history.undo();

    expect(editor("bullet-1")).toHaveFocus();
    expect(editor("bullet-1").selectionStart).toBe("First".length);
  });

  it("restores a caret that sat in the supporting note", async () => {
    const notesStore = caretHistory([
      { id: "bullet-1", text: "First", note: "supporting" }
    ]);
    putCaret("bullet-1", 3, "note");
    notesStore.emitMutation();
    putCaret("bullet-1", 0);
    notesStore.undo = vi.fn().mockResolvedValue(undefined);

    await notesStore.history.undo();

    expect(editor("bullet-1", "note")).toHaveFocus();
    expect(editor("bullet-1", "note").selectionStart).toBe(3);
  });

  it("returns the caret to where the action left it on redo", async () => {
    const notesStore = caretHistory([{ id: "bullet-1", text: "어우우우야" }]);
    putCaret("bullet-1", 2);
    notesStore.emitMutation();
    const split = [
      { id: "bullet-1", text: "어우" },
      { id: "bullet-2", text: "우우야" }
    ];
    notesStore.settle(split);
    putCaret("bullet-2", 0);
    notesStore.undo = vi.fn(async () =>
      notesStore.settle([{ id: "bullet-1", text: "어우우우야" }]));
    notesStore.redo = vi.fn(async () => notesStore.settle(split));

    await notesStore.history.undo();
    await notesStore.history.redo();

    expect(editor("bullet-2")).toHaveFocus();
    expect(editor("bullet-2").selectionStart).toBe(0);
  });

  it("keeps a caret the DOM still holds when nothing was recorded", async () => {
    const notesStore = caretHistory([{ id: "bullet-1", text: "First" }]);
    // Nothing focused when the mutation ran, so no caret was recorded.
    notesStore.emitMutation();
    putCaret("bullet-1", 2);

    await notesStore.history.undo();

    expect(editor("bullet-1").selectionStart).toBe(2);
  });
});
