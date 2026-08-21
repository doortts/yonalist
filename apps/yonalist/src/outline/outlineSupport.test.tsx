import { fireEvent, render } from "@testing-library/react";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "../notesStore";
import { OutlineIndex } from "./outlineIndex";
import {
  handleImagePrimaryKeyDown, handleOutlineKeyDown
} from "./outlineSupport";

function bullet(id: string, parentId: string, sortKey: number): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
    image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

// `alpha` is collapsed, so its child stands in the structure list and not the
// visible one. Every position after it therefore differs between the two lists
// and between the two indexes, which is what makes a swapped pair observable.
const structureNodes = [
  bullet("alpha", "page", 1_024),
  bullet("alpha-kid", "alpha", 1_024),
  bullet("beta", "page", 2_048),
  bullet("gamma", "page", 3_072)
] as const;
const visibleNodes = [
  structureNodes[0], structureNodes[2], structureNodes[3]
] as const;

function storeStub() {
  return {
    flushDraft: vi.fn(() => Promise.resolve()),
    beginBackspaceGesture: vi.fn(() => "gesture"),
    endBackspaceGesture: vi.fn(),
    beginRemoveEmptyNode: vi.fn(() => ({ committed: Promise.resolve() })),
    cycleCompleted: vi.fn(() => Promise.resolve()),
    setCompleted: vi.fn(() => Promise.resolve()),
    setCollapsed: vi.fn(() => Promise.resolve())
  };
}

/**
 * One spy per collaborator, never a shared one: the four `() => void` keys are
 * interchangeable to the compiler, so only distinct spies can tell them apart.
 */
function options(store: ReturnType<typeof storeStub>, hasSelection = false) {
  return {
    store: store as unknown as NotesStore,
    node: structureNodes[2],
    nodes: structureNodes,
    visibleNodes,
    structureIndex: new OutlineIndex(structureNodes),
    visibleIndex: new OutlineIndex(visibleNodes),
    pageId: "page",
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    band: {
      headId: hasSelection ? "beta" : null,
      anchorId: hasSelection ? "beta" : null,
      hasSelection
    },
    onExtendSelection: vi.fn(),
    onWidenSelection: vi.fn(),
    onClearSelection: vi.fn(),
    onFocusNote: vi.fn(),
    onMoveTo: vi.fn(),
    supportingNote: "",
    selectionActions: {
      indent: vi.fn(),
      outdent: vi.fn(),
      move: vi.fn(),
      toggleComplete: vi.fn(),
      duplicate: vi.fn(),
      delete: vi.fn(),
      copy: vi.fn(),
      cut: vi.fn(),
      setCollapsed: vi.fn()
    },
    onCopyImage: vi.fn(),
    onCutImage: vi.fn(),
    onCopyRow: vi.fn(),
    onCutRow: vi.fn()
  };
}

/** The row keys the four bare callbacks answer to, on the non-mac bindings. */
const routes = [
  ["zoom in", { key: ".", altKey: true }, "onZoomIn"],
  ["zoom out", { key: ",", altKey: true }, "onZoomOut"],
  ["note", { key: "Enter", shiftKey: true }, "onFocusNote"],
  ["move to", { key: "m", ctrlKey: true, altKey: true }, "onMoveTo"]
] as const;
const bareCallbacks = [
  "onZoomIn", "onZoomOut", "onFocusNote", "onMoveTo"
] as const;

function neighbours() {
  return (
    <>
      <textarea
        data-node-id="alpha"
        data-outline-field="title"
        defaultValue="Alpha"
      />
      <textarea
        data-node-id="gamma"
        data-outline-field="title"
        defaultValue="Gamma"
      />
    </>
  );
}

function focusedNodeId(): string | undefined {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active.dataset.nodeId : undefined;
}

function mountRow(
  given: ReturnType<typeof options>,
  value = "Beta"
): HTMLTextAreaElement {
  const { container } = render(
    <div className="notes-outline">
      {neighbours()}
      <textarea
        data-node-id="beta"
        data-outline-field="title"
        defaultValue={value}
        onKeyDown={(event) => handleOutlineKeyDown({ ...given, event })}
      />
    </div>
  );
  const field = container.querySelector<HTMLTextAreaElement>(
    "[data-node-id=\"beta\"]"
  )!;
  field.setSelectionRange(value.length, value.length);
  return field;
}

function mountImage(given: ReturnType<typeof options>): HTMLDivElement {
  const { container } = render(
    <div className="notes-outline">
      {neighbours()}
      <div
        data-image-row="beta"
        tabIndex={-1}
        onKeyDown={(event) => handleImagePrimaryKeyDown({ ...given, event })}
      />
    </div>
  );
  return container.querySelector<HTMLDivElement>("[data-image-row]")!;
}

describe("v2 outline row keys reach the collaborator they name", () => {
  it("routes the caret-only clipboard chords to the row's own callback", () => {
    const given = options(storeStub());

    fireEvent.keyDown(mountRow(given), { key: "x", ctrlKey: true });

    expect(given.onCutRow).toHaveBeenCalledWith("beta");
    expect(given.onCopyRow).not.toHaveBeenCalled();

    fireEvent.keyDown(mountRow(given), { key: "c", ctrlKey: true });

    expect(given.onCopyRow).toHaveBeenCalledWith("beta");
    expect(given.onCutRow).toHaveBeenCalledTimes(1);
  });

  it("leaves the chords to the band and to swept text", () => {
    const banded = options(storeStub(), true);

    fireEvent.keyDown(mountRow(banded), { key: "c", ctrlKey: true });
    fireEvent.keyDown(mountRow(banded), { key: "x", ctrlKey: true });

    expect(banded.onCopyRow).not.toHaveBeenCalled();
    expect(banded.onCutRow).not.toHaveBeenCalled();

    // Swept text keeps the textarea's own copy: no intent, so no
    // `preventDefault`, which is what a truthy `fireEvent` return reports.
    const given = options(storeStub());
    const field = mountRow(given);
    field.setSelectionRange(0, 4);

    expect(fireEvent.keyDown(field, { key: "c", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(field, { key: "x", ctrlKey: true })).toBe(true);
    expect(given.onCopyRow).not.toHaveBeenCalled();
    expect(given.onCutRow).not.toHaveBeenCalled();
  });

  it.each(routes)(
    "sends the %s key to its own callback and to no other",
    async (_label, init, expected) => {
      const given = options(storeStub());
      fireEvent.keyDown(mountRow(given), init);

      await vi.waitFor(() =>
        expect(given[expected]).toHaveBeenCalledTimes(1));
      for (const name of bareCallbacks) {
        if (name !== expected) expect(given[name]).not.toHaveBeenCalled();
      }
    }
  );

  it("sends the completion chord to the cycle, and never to a plain toggle", () => {
    const store = storeStub();
    const given = options(store);

    // jsdom reports no Mac platform, so the primary modifier here is Control.
    fireEvent.keyDown(mountRow(given), { key: "Enter", ctrlKey: true });

    expect(store.cycleCompleted).toHaveBeenCalledWith("beta");
    // The server decides which of the three presses this is, so the client has
    // no business naming a state.
    expect(store.setCompleted).not.toHaveBeenCalled();
  });

  it("hands a band key to the selection command, not to the row", () => {
    const given = options(storeStub(), true);
    fireEvent.keyDown(mountRow(given), { key: "Tab" });

    expect(given.selectionActions.indent).toHaveBeenCalledTimes(1);
    expect(given.selectionActions.outdent).not.toHaveBeenCalled();
    expect(given.onExtendSelection).not.toHaveBeenCalled();
    expect(given.onClearSelection).not.toHaveBeenCalled();
  });

  it("extends the band from the row the key came from", () => {
    const given = options(storeStub());
    fireEvent.keyDown(mountRow(given), { key: "ArrowDown", shiftKey: true });

    expect(given.onExtendSelection)
      .toHaveBeenCalledWith("beta", "beta", "end");
    expect(given.onClearSelection).not.toHaveBeenCalled();
  });

  it("clears the band toward the edge the arrow points at", () => {
    const given = options(storeStub(), true);
    fireEvent.keyDown(mountRow(given), { key: "ArrowLeft" });

    expect(given.onClearSelection).toHaveBeenCalledWith("start", false);
    expect(given.onExtendSelection).not.toHaveBeenCalled();
  });

  it("walks the caret down the visible list, not the structure list", () => {
    const given = options(storeStub());
    fireEvent.keyDown(mountRow(given), { key: "ArrowDown" });

    expect(focusedNodeId()).toBe("gamma");
  });

  it("sends fold and expand shortcuts to store.setCollapsed on a single row", () => {
    const store = storeStub();
    const given = options(store);
    const field = mountRow(given);

    // Primary shortcuts (Control on non-Mac test runner)
    fireEvent.keyDown(field, { key: "ArrowUp", ctrlKey: true });
    expect(store.setCollapsed).toHaveBeenCalledWith("beta", true);

    fireEvent.keyDown(field, { key: "ArrowDown", ctrlKey: true });
    expect(store.setCollapsed).toHaveBeenCalledWith("beta", false);

    // Alias shortcuts
    fireEvent.keyDown(field, { key: "[", ctrlKey: true, altKey: true });
    expect(store.setCollapsed).toHaveBeenCalledWith("beta", true);

    fireEvent.keyDown(field, { key: "]", ctrlKey: true, altKey: true });
    expect(store.setCollapsed).toHaveBeenCalledWith("beta", false);
  });

  it("hands fold and expand shortcuts to selectionActions when a band is live", () => {
    const given = options(storeStub(), true);
    const field = mountRow(given);

    fireEvent.keyDown(field, { key: "ArrowUp", ctrlKey: true });
    expect(given.selectionActions.setCollapsed).toHaveBeenCalledWith(true);

    fireEvent.keyDown(field, { key: "ArrowDown", ctrlKey: true });
    expect(given.selectionActions.setCollapsed).toHaveBeenCalledWith(false);
  });

  // The note gates the empty-row Backspace, and the page id is the caret's last
  // resort on the same key: two bare strings, so the swap has to be observable.
  it("takes an empty row away only when its note is empty too", () => {
    const store = storeStub();
    fireEvent.keyDown(mountRow({ ...options(store), pageId: "page" }, ""), {
      key: "Backspace"
    });

    expect(store.beginRemoveEmptyNode).toHaveBeenCalledWith("beta", "gesture");
  });
});

describe("v2 image row keys reach the collaborator they name", () => {
  it.each(routes)(
    "sends the %s key to its own callback and to no other",
    async (_label, init, expected) => {
      const given = options(storeStub());
      fireEvent.keyDown(mountImage(given), init);

      await vi.waitFor(() =>
        expect(given[expected]).toHaveBeenCalledTimes(1));
      for (const name of bareCallbacks) {
        if (name !== expected) expect(given[name]).not.toHaveBeenCalled();
      }
    }
  );

  it("routes the clipboard chords to the image, each to its own callback", () => {
    const copy = options(storeStub());
    fireEvent.keyDown(mountImage(copy), { key: "c", ctrlKey: true });

    expect(copy.onCopyImage).toHaveBeenCalledWith("beta");
    expect(copy.onCutImage).not.toHaveBeenCalled();

    const cut = options(storeStub());
    fireEvent.keyDown(mountImage(cut), { key: "x", ctrlKey: true });

    expect(cut.onCutImage).toHaveBeenCalledWith("beta");
    expect(cut.onCopyImage).not.toHaveBeenCalled();
  });

  it("hands a band key to the selection command, not to the row", () => {
    const given = options(storeStub(), true);
    fireEvent.keyDown(mountImage(given), { key: "Tab" });

    expect(given.selectionActions.indent).toHaveBeenCalledTimes(1);
    expect(given.onCopyImage).not.toHaveBeenCalled();
  });

  it("extends the band from the station the key came from", () => {
    const given = options(storeStub());
    fireEvent.keyDown(mountImage(given), { key: "ArrowRight", shiftKey: true });

    expect(given.onExtendSelection)
      .toHaveBeenCalledWith("beta", "beta", "end");
    expect(given.onClearSelection).not.toHaveBeenCalled();
  });

  it("clears the band toward the edge the arrow points at", () => {
    const given = options(storeStub(), true);
    fireEvent.keyDown(mountImage(given), { key: "ArrowLeft" });

    expect(given.onClearSelection).toHaveBeenCalledWith("start", false);
    expect(given.onExtendSelection).not.toHaveBeenCalled();
  });

  it("walks the caret down the visible list, not the structure list", () => {
    const given = options(storeStub());
    fireEvent.keyDown(mountImage(given), { key: "ArrowDown" });

    expect(focusedNodeId()).toBe("gamma");
  });

  it("sends fold and expand shortcuts to store.setCollapsed on an image row", () => {
    const store = storeStub();
    const given = options(store);
    const frame = mountImage(given);

    fireEvent.keyDown(frame, { key: "ArrowUp", ctrlKey: true });
    expect(store.setCollapsed).toHaveBeenCalledWith("beta", true);

    fireEvent.keyDown(frame, { key: "ArrowDown", ctrlKey: true });
    expect(store.setCollapsed).toHaveBeenCalledWith("beta", false);
  });

  it("hands fold and expand shortcuts to selectionActions when an image is banded", () => {
    const given = options(storeStub(), true);
    const frame = mountImage(given);

    fireEvent.keyDown(frame, { key: "ArrowUp", ctrlKey: true });
    expect(given.selectionActions.setCollapsed).toHaveBeenCalledWith(true);

    fireEvent.keyDown(frame, { key: "ArrowDown", ctrlKey: true });
    expect(given.selectionActions.setCollapsed).toHaveBeenCalledWith(false);
  });
});
