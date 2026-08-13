import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";

const ROWS: readonly NoteView[] = [
  "CUT ME", "CUT ME TOO", "CUT ME THREE", "KEEP ME"
].map((text, index) => ({
  id: `bullet-${index + 1}`,
  parentId: "page",
  sortKey: (index + 1) * 1_024,
  kind: "bullet",
  image: null,
  text,
  note: "",
  marker: "bullet",
  collapsed: false,
  completed: false,
  starred: false,
  deleted: false
}));

const snapshot: BootSnapshot = {
  sessionId: "session-history-band",
  revision: 7,
  activePageId: "page",
  pages: [{ id: "page", title: "Today", sortKey: 1_024 }],
  viewport: {
    pageId: "page",
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    nodes: [...ROWS]
  },
  history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
};

/**
 * The rows are all siblings, so a delete takes exactly the ids it was given and
 * the undo behind it hands exactly those back -- which is what the Rust side
 * already does correctly, and what leaves the band as the only thing under test.
 */
function api(): NotesApi {
  let cut: readonly string[] = [];
  return {
    bootstrap: vi.fn().mockResolvedValue(snapshot),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockImplementation(async (request) => ({
      revision: snapshot.revision,
      nodes: ROWS.filter((row) => request.rootIds.includes(row.id)),
      complete: true
    })),
    execute: vi.fn().mockImplementation(async (envelope) => {
      const command = envelope.command as { kind: string; ids?: string[] };
      if (command.kind === "deleteSubtrees") cut = command.ids ?? [];
      return {
        revision: 8,
        changedNodes: [],
        deletedIds: command.kind === "deleteSubtrees" ? [...cut] : [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    }),
    importImageBytes: vi.fn(),
    importImagePaths: vi.fn(),
    replaceImageBytes: vi.fn(),
    replaceImagePath: vi.fn(),
    readImage: vi.fn(),
    viewImageOriginal: vi.fn(),
    downloadImage: vi.fn(),
    undo: vi.fn().mockImplementation(async () => ({
      revision: 9,
      changedNodes: ROWS.filter((row) => cut.includes(row.id)),
      deletedIds: [],
      history: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1 }
    })),
    redo: vi.fn().mockImplementation(async () => ({
      revision: 10,
      changedNodes: [],
      deletedIds: [...cut],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    })),
    search: vi.fn().mockResolvedValue({ hits: [], nextCursor: null }),
    exportNotes: vi.fn(),
    closeSession: vi.fn(),
    unusedAssets: vi.fn(),
    deleteAllData: vi.fn()
  } as unknown as NotesApi;
}

function row(text: string): HTMLElement {
  const node = screen.getByDisplayValue(text)
    .closest<HTMLElement>("[data-outline-id]");
  if (!node) throw new Error(`no row around ${text}`);
  return node;
}

async function caretIn(text: string): Promise<HTMLTextAreaElement> {
  const field = await screen.findByDisplayValue<HTMLTextAreaElement>(text);
  act(() => {
    field.focus();
    field.setSelectionRange(0, 0);
  });
  return field;
}

/**
 * Shift and an arrow sweep the row's own text before they take the row, and the
 * row before its neighbour, so a band reaching one row past the caret's own is
 * three presses of the chord.
 */
function bandUp(field: HTMLTextAreaElement, presses: number): void {
  for (let press = 0; press < presses; press += 1) {
    fireEvent.keyDown(field, { key: "ArrowUp", shiftKey: true });
  }
}

function press(key: string, shiftKey = false): Promise<void> {
  return act(async () => {
    fireEvent.keyDown(window, { key, ctrlKey: true, shiftKey });
  });
}

function cutBand(): void {
  fireEvent.cut(screen.getByRole("region", { name: "Notes outline" }), {
    clipboardData: { setData: vi.fn() }
  });
}

describe("history band", () => {
  it("puts the cut band back on undo and takes it away on redo", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const second = await caretIn("CUT ME TOO");
    bandUp(second, 3);
    await screen.findByRole("toolbar", { name: "Actions for 2 selected notes" });

    cutBand();

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { kind: "deleteSubtrees", ids: ["bullet-1", "bullet-2"] }
      })
    ));
    await waitFor(() => expect(screen.queryByDisplayValue("CUT ME")).toBeNull());

    await press("z");

    await waitFor(() => {
      expect(row("CUT ME")).toHaveAttribute("data-selected", "true");
      expect(row("CUT ME TOO")).toHaveAttribute("data-selected", "true");
    });
    // The band the cut started from, and the caret with it -- the row the chord
    // was swept from, not wherever the delete handed the caret off to.
    expect(document.activeElement)
      .toHaveAttribute("data-node-id", "bullet-2");
    expect(screen.getByRole("toolbar", { name: "Actions for 2 selected notes" }))
      .toBeInTheDocument();

    // And a redo lands on the far side of the cut again: the rows go, and the
    // band restored a moment ago goes with them.
    await press("z", true);

    await waitFor(() => expect(notesApi.redo).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByDisplayValue("CUT ME")).toBeNull());
    expect(screen.queryByRole("toolbar", { name: /selected notes/ }))
      .toBeNull();
  });

  // The band's far end is the last row it recorded, and the chord that grows a
  // band reads it: a head the outline has no row for leaves Shift and an arrow
  // doing nothing at all, so a partly returned band has to end on a live row.
  it("bands only the rows the step actually handed back", async () => {
    const notesApi = api();
    notesApi.undo = vi.fn().mockResolvedValue({
      revision: 9,
      changedNodes: ROWS.filter((candidate) => candidate.id !== "bullet-3"),
      deletedIds: [],
      history: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1 }
    });
    render(<App api={notesApi} />);
    bandUp(await caretIn("CUT ME THREE"), 4);
    await screen.findByRole("toolbar", { name: "Actions for 3 selected notes" });
    cutBand();
    await waitFor(() => expect(screen.queryByDisplayValue("CUT ME")).toBeNull());

    await press("z");

    await waitFor(() => expect(row("CUT ME"))
      .toHaveAttribute("data-selected", "true"));
    expect(row("CUT ME TOO")).toHaveAttribute("data-selected", "true");
    expect(screen.queryByDisplayValue("CUT ME THREE")).toBeNull();
    expect(screen.getByRole("toolbar", { name: "Actions for 2 selected notes" }))
      .toBeInTheDocument();

    fireEvent.keyDown(screen.getByDisplayValue("CUT ME TOO"), {
      key: "ArrowDown",
      shiftKey: true
    });

    expect(await screen.findByRole(
      "toolbar", { name: "Actions for 3 selected notes" }
    )).toBeInTheDocument();
    expect(row("KEEP ME")).toHaveAttribute("data-selected", "true");
  });

  it("puts back a band the action bar cut with no caret behind it", async () => {
    const notesApi = api();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write }
    });
    // The asynchronous write path a toolbar Cut takes, which jsdom ships
    // neither half of.
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: class {
        constructor(readonly items: Record<string, Blob>) {}
      }
    });
    render(<App api={notesApi} />);
    fireEvent.pointerDown(await screen.findByDisplayValue("CUT ME"));
    fireEvent.pointerDown(screen.getByDisplayValue("CUT ME TOO"), {
      shiftKey: true
    });
    await screen.findByRole("toolbar", { name: "Actions for 2 selected notes" });
    // The band was built with the pointer and the Cut lives behind a button, so
    // nothing in the outline holds a caret when the command runs.
    expect(document.activeElement).not.toBeInstanceOf(HTMLTextAreaElement);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Cut" }));

    await waitFor(() => expect(screen.queryByDisplayValue("CUT ME")).toBeNull());
    expect(write).toHaveBeenCalledOnce();

    await press("z");

    await waitFor(() => {
      expect(row("CUT ME")).toHaveAttribute("data-selected", "true");
      expect(row("CUT ME TOO")).toHaveAttribute("data-selected", "true");
    });
  });

  it("restores the caret alone when the command had no band", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const keep = await caretIn("KEEP ME");
    act(() => keep.setSelectionRange(4, 4));
    await act(async () => {
      fireEvent.keyDown(keep, { key: "Enter" });
    });
    await waitFor(() => expect(notesApi.execute).toHaveBeenCalled());

    await press("z");

    await waitFor(() => expect(notesApi.undo).toHaveBeenCalledOnce());
    expect(document.activeElement)
      .toHaveAttribute("data-node-id", "bullet-4");
    expect(screen.queryByRole("toolbar", { name: /selected notes/ }))
      .toBeNull();
  });

  // The entry holds the whole pane, empty band included, so a band raised after
  // the command goes when the command does -- the state before it had none.
  it("clears a band the command it undoes never had", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const keep = await caretIn("KEEP ME");
    await act(async () => {
      fireEvent.keyDown(keep, { key: "Enter" });
    });
    await waitFor(() => expect(notesApi.execute).toHaveBeenCalled());
    fireEvent.pointerDown(screen.getByDisplayValue("CUT ME"));
    fireEvent.pointerDown(screen.getByDisplayValue("CUT ME TOO"), {
      shiftKey: true
    });
    await screen.findByRole("toolbar", { name: "Actions for 2 selected notes" });

    await press("z");

    await waitFor(() => expect(notesApi.undo).toHaveBeenCalledOnce());
    await waitFor(() => expect(
      screen.queryByRole("toolbar", { name: /selected notes/ })
    ).toBeNull());
    expect(row("CUT ME")).not.toHaveAttribute("data-selected", "true");
  });
});
