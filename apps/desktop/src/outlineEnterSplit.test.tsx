import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { IpcNotesCommand } from "../../../packages/contracts/generated/IpcNotesCommand";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { NotesOutline } from "./NotesOutline";
import { NotesStore } from "./notesStore";
import { SORT_KEY_STEP } from "./outlineSortKeys";

function bullet(
  id: string,
  parentId: string,
  sortKey: number,
  text: string,
  collapsed = false
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
    collapsed,
    completed: false,
    starred: false,
    deleted: false
  };
}

function bootSnapshot(nodes: readonly NoteView[]): BootSnapshot {
  return {
    sessionId: "split-session",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Today" }],
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

// The receipt carries no rows, so what the assertions read back is the
// optimistic tree the split projected -- which is what the caret and the
// rendered order actually run on.
async function outline(nodes: readonly NoteView[]) {
  const commands: IpcNotesCommand[] = [];
  let revision = 1;
  const api = {
    bootstrap: vi.fn().mockResolvedValue(bootSnapshot(nodes)),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1,
      nodes: [],
      complete: true
    }),
    execute: vi.fn().mockImplementation((envelope) => {
      commands.push(envelope.command as IpcNotesCommand);
      revision += 1;
      return Promise.resolve({
        revision,
        changedNodes: [],
        deletedIds: [],
        history: {
          canUndo: true, canRedo: false, undoDepth: revision, redoDepth: 0
        }
      });
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
      onTagClick={() => undefined}
      paneId="primary"
      restoreRequest={null}
    />
  );
  await act(async () => undefined);
  return { store, view, commands };
}

// Row titles only: the page heading carries the same field marker.
function titles(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLTextAreaElement>(
    ".notes-outline-rows textarea[data-outline-field='title']"
  )].map((field) => field.value);
}

// Children in rendered order, which is what "first child" has to mean.
function childIds(store: NotesStore, parentId: string): readonly string[] {
  return store.getSnapshot().nodes
    .filter((node) => node.parentId === parentId && !node.deleted)
    .slice()
    .sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id))
    .map((node) => node.id);
}

async function pressEnterAt(
  container: HTMLElement,
  nodeId: string,
  offset: number
): Promise<void> {
  const field = container.querySelector<HTMLTextAreaElement>(
    `textarea[data-node-id='${nodeId}']`
  )!;
  act(() => {
    field.focus();
    field.setSelectionRange(offset, offset);
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: "Enter" });
  });
}

// A bullet with children always takes Enter as "make a first child": empty when
// the caret sits at the end, carrying the half after the caret when it does not.
describe("Enter inside a bullet that has children", () => {
  it("puts the half after the caret in as the first child", async () => {
    const { store, view, commands } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "AAA BBB"),
      bullet("child-1", "one", SORT_KEY_STEP, "child1"),
      bullet("child-2", "one", SORT_KEY_STEP * 2, "child2"),
      bullet("two", "page-1", SORT_KEY_STEP * 2, "Next")
    ]);

    await pressEnterAt(view.container, "one", 4);

    expect(titles(view.container))
      .toEqual(["AAA ", "BBB", "child1", "child2", "Next"]);
    const split = commands[0] as Extract<
      IpcNotesCommand, { kind: "splitNode" }
    >;
    expect(split.kind).toBe("splitNode");
    expect(split.id).toBe("one");
    expect(split.parent_id).toBe("one");
    expect(split.before_id).toBe("child-1");
    expect(split.prefix).toBe("AAA ");
    expect(split.suffix).toBe("BBB");
    // The source keeps the prefix and every child it had; the new row goes in
    // ahead of them rather than beside the source.
    expect(childIds(store, "one"))
      .toEqual([split.new_id, "child-1", "child-2"]);
    expect(childIds(store, "page-1")).toEqual(["one", "two"]);
    view.unmount();
  });

  it("puts the caret at offset 0 of the new child", async () => {
    const { view, commands } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "AAA BBB"),
      bullet("child-1", "one", SORT_KEY_STEP, "child1")
    ]);

    await pressEnterAt(view.container, "one", 4);

    const split = commands[0] as Extract<
      IpcNotesCommand, { kind: "splitNode" }
    >;
    await waitFor(() => {
      const active = document.activeElement as HTMLTextAreaElement;
      expect(active.dataset.nodeId).toBe(split.new_id);
      expect(active.value).toBe("BBB");
      expect([active.selectionStart, active.selectionEnd]).toEqual([0, 0]);
    });
    view.unmount();
  });

  // The `14b13e36` guard, on the nesting path: one visible structural action
  // costs exactly one undo, so the split has to be the only command the
  // keystroke sends and the blur that follows the caret out must find nothing
  // left to flush.
  it("sends the split alone, with nothing left for the blur to flush", async () => {
    const { view, commands } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "AAA BBB"),
      bullet("child-1", "one", SORT_KEY_STEP, "child1")
    ]);

    await pressEnterAt(view.container, "one", 4);
    await waitFor(() => expect(document.activeElement)
      .not.toHaveAttribute("data-node-id", "one"));
    await act(async () => undefined);

    expect(commands.map((command) => command.kind)).toEqual(["splitNode"]);
    view.unmount();
  });

  it("starts an empty first child when the caret sits at the end", async () => {
    const { store, view, commands } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "AAA"),
      bullet("child-1", "one", SORT_KEY_STEP, "child1")
    ]);

    await pressEnterAt(view.container, "one", 3);

    // Same command as the mid-text split now, with an empty half after the
    // caret -- the two Enter branches are one rule.
    expect(commands.map((command) => command.kind)).toEqual(["splitNode"]);
    expect(titles(view.container)).toEqual(["AAA", "", "child1"]);
    const split = commands[0] as Extract<
      IpcNotesCommand, { kind: "splitNode" }
    >;
    expect(childIds(store, "one")).toEqual([split.new_id, "child-1"]);
    view.unmount();
  });

  it("opens a collapsed source so the new child is visible", async () => {
    const { view } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "AAA BBB", true),
      bullet("child-1", "one", SORT_KEY_STEP, "child1")
    ]);
    expect(titles(view.container)).toEqual(["AAA BBB"]);

    await pressEnterAt(view.container, "one", 4);

    expect(titles(view.container)).toEqual(["AAA ", "BBB", "child1"]);
    view.unmount();
  });

  // This one was already broken before the nesting rule and nobody saw it: the
  // empty row landed under a collapsed parent and the caret chased a row that
  // was never rendered.
  it("opens a collapsed source for the empty first child too", async () => {
    const { view } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "AAA", true),
      bullet("child-1", "one", SORT_KEY_STEP, "child1")
    ]);
    expect(titles(view.container)).toEqual(["AAA"]);

    await pressEnterAt(view.container, "one", 3);

    expect(titles(view.container)).toEqual(["AAA", "", "child1"]);
    await waitFor(() => {
      const active = document.activeElement as HTMLTextAreaElement;
      expect(active.dataset.outlineField).toBe("title");
      expect(active.value).toBe("");
    });
    view.unmount();
  });

  // Each repeat splits whatever holds the caret, which is the row carrying the
  // half after the caret. So the blanks pile up as children in order and the
  // half stays last, right above the children the source already had.
  it("stacks one blank child per repeat, the tail keeping the caret", async () => {
    const { store, view } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "AAA BBB"),
      bullet("child-1", "one", SORT_KEY_STEP, "child1")
    ]);
    const field = view.container.querySelector<HTMLTextAreaElement>(
      "textarea[data-node-id='one']"
    )!;
    act(() => {
      field.focus();
      field.setSelectionRange(4, 4);
    });

    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        fireEvent.keyDown(
          document.activeElement!, { key: "Enter", repeat: index > 0 });
      });
    }

    expect(titles(view.container))
      .toEqual(["AAA ", "", "", "", "BBB", "child1"]);
    expect(childIds(store, "one")).toHaveLength(5);
    expect(childIds(store, "one").at(-1)).toBe("child-1");
    await waitFor(() => {
      const active = document.activeElement as HTMLTextAreaElement;
      expect(active.value).toBe("BBB");
      expect(childIds(store, "one").at(-2)).toBe(active.dataset.nodeId);
    });
    view.unmount();
  });
});

describe("Enter inside a childless bullet", () => {
  // One visible structural action has to cost exactly one undo, so the split
  // command must be the only thing the keystroke sends. The optimistic draft it
  // leaves on the source used to look unsent to the blur that follows the
  // caret, which pushed a second updateText and a second history entry.
  it("sends the split alone, with nothing left for the blur to flush", async () => {
    const { view, commands } = await outline([
      bullet("solo", "page-1", SORT_KEY_STEP, "alphaomega"),
      bullet("two", "page-1", SORT_KEY_STEP * 2, "Next")
    ]);

    await pressEnterAt(view.container, "solo", 5);
    await waitFor(() => expect(document.activeElement)
      .not.toHaveAttribute("data-node-id", "solo"));
    await act(async () => undefined);

    expect(commands.map((command) => command.kind)).toEqual(["splitNode"]);
    expect(titles(view.container)).toEqual(["alpha", "omega", "Next"]);
    view.unmount();
  });
});
