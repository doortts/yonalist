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

describe("Enter inside a bullet that has children", () => {
  it("leaves the two halves adjacent, children still under the source", async () => {
    const { store, view, commands } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "AAA BBB"),
      bullet("child-1", "one", SORT_KEY_STEP, "child1"),
      bullet("child-2", "one", SORT_KEY_STEP * 2, "child2"),
      bullet("two", "page-1", SORT_KEY_STEP * 2, "Next")
    ]);

    await pressEnterAt(view.container, "one", 4);

    expect(titles(view.container))
      .toEqual(["AAA ", "BBB", "child1", "child2", "Next"]);
    const state = store.getSnapshot();
    // The source keeps its id, its children, and the half after the caret.
    expect(state.nodes.filter((node) => node.parentId === "one")
      .map((node) => node.id)).toEqual(["child-1", "child-2"]);
    const split = commands[0] as Extract<
      IpcNotesCommand, { kind: "splitNode" }
    >;
    expect(split.kind).toBe("splitNode");
    expect(split.id).toBe("one");
    expect(split.before_id).toBe("one");
    expect(split.prefix).toBe("BBB");
    expect(split.suffix).toBe("AAA ");
    view.unmount();
  });

  it("puts the caret at the start of the suffix, on the source row", async () => {
    const { view } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "AAA BBB"),
      bullet("child-1", "one", SORT_KEY_STEP, "child1")
    ]);

    await pressEnterAt(view.container, "one", 4);

    await waitFor(() => {
      const active = document.activeElement as HTMLTextAreaElement;
      expect(active.dataset.nodeId).toBe("one");
      expect(active.value).toBe("BBB");
      expect([active.selectionStart, active.selectionEnd]).toEqual([0, 0]);
    });
    view.unmount();
  });

  // The source is the row that survives a split here, so the held-Enter gesture
  // tracks the same id across the whole burst instead of following a new row.
  it("stacks one blank row per repeat above the row it keeps splitting", async () => {
    const { view } = await outline([
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
    await waitFor(() => expect(document.activeElement)
      .toHaveAttribute("data-node-id", "one"));
    view.unmount();
  });

  it("still starts a first child when the caret sits at the end", async () => {
    const { view, commands } = await outline([
      bullet("one", "page-1", SORT_KEY_STEP, "AAA"),
      bullet("child-1", "one", SORT_KEY_STEP, "child1")
    ]);

    await pressEnterAt(view.container, "one", 3);

    expect(commands.map((command) => command.kind)).toEqual(["createNode"]);
    expect(titles(view.container)).toEqual(["AAA", "", "child1"]);
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
