import {
  fireEvent, render, screen, waitFor, within
} from "@testing-library/react";
import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { NotesApi } from "../api";
import { App } from "../App";
import type { ImageImportRequest } from "../image/imageApi";
import { buildOutlineClipboardFormats } from "./outlineClipboard";
const snapshot: BootSnapshot = {
  sessionId: "session-clipboard",
  revision: 7,
  activePageId: "page",
  pages: [{ id: "page", title: "Today", sortKey: 1_024 }],
  viewport: {
    pageId: "page",
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    nodes: ["First thought", "Second thought", "Third thought"].map((text, index) => ({
      id: `bullet-${index + 1}`,
      parentId: "page",
      sortKey: (index + 1) * 1_024,
      kind: "bullet", image: null,
      text,
      note: "",
      marker: "bullet",
      collapsed: false,
      completed: false,
      starred: false,
      deleted: false
    }))
  },
  history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
};

function api(): NotesApi {
  return {
    bootstrap: vi.fn().mockResolvedValue(snapshot),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockImplementation(async (request) => ({
      revision: snapshot.revision,
      nodes: snapshot.viewport?.nodes.filter((node) =>
        request.rootIds.includes(node.id)) ?? [],
      complete: true
    })),
    execute: vi.fn().mockResolvedValue({
      revision: 8,
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
    search: vi.fn().mockResolvedValue({ hits: [], nextCursor: null }),
    exportNotes: vi.fn(),
    closeSession: vi.fn(),
    unusedAssets: vi.fn(),
    deleteAllData: vi.fn(),
    syncVaultGet: vi.fn().mockResolvedValue(null),
    syncVaultSet: vi.fn(),
    syncConflicts: vi.fn().mockResolvedValue([]),
    syncFlush: vi.fn(),
    syncStatus: vi.fn().mockResolvedValue({
      refused: [], writeError: null, watchError: null
    }),
    syncAttachments: vi.fn(),
    syncDeleteAttachment: vi.fn(),
    syncRestoreConflict: vi.fn()
  };
}

const COPIED_IMAGE = {
  contentHash: "d".repeat(64),
  originalName: "sample.png",
  mimeType: "image/png",
  byteLength: 1,
  pixelWidth: 1,
  pixelHeight: 1,
  displayWidth: 320
};

/**
 * What a copy of a to-do row carrying a note and an image actually puts on the
 * clipboard, so the paste under test reads our own writer rather than a fixture
 * that could drift away from it.
 */
function copiedFormat(type: string): string {
  const rows = [
    {
      ...snapshot.viewport!.nodes[0],
      id: "copied",
      text: "Buy milk",
      marker: "todo" as const,
      completed: true,
      note: "Two litres"
    },
    {
      ...snapshot.viewport!.nodes[1],
      id: "copied-image",
      parentId: "copied",
      kind: "image" as const,
      text: "sample.png",
      image: COPIED_IMAGE
    }
  ];
  const written = buildOutlineClipboardFormats(
    { nodes: rows, drafts: {}, noteDrafts: {} },
    ["copied"]
  )!;
  return type === "text/html" ? written.html : written.plain;
}

/**
 * Shift and an arrow sweep a row's own text before they take the row, and the
 * row before its neighbour, so a band reaching one row past the caret's own is
 * three presses of the chord.
 */
function bandDownFrom(field: HTMLElement): void {
  for (let press = 0; press < 3; press += 1) {
    fireEvent.keyDown(field, { key: "ArrowDown", shiftKey: true });
  }
}

/**
 * A cut that got through schedules its delete a microtask out, so "nothing was
 * deleted" is only worth asserting from the far side of a macrotask -- read one
 * tick early it holds whether the guard fired or not.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("outline clipboard integration", () => {
  it("materializes a selected parent into its complete authoritative subtree", async () => {
    const notesApi = api();
    const parent = {
      ...snapshot.viewport!.nodes[0],
      id: "parent",
      text: "Parent"
    };
    const child = {
      ...snapshot.viewport!.nodes[1],
      id: "child",
      parentId: "parent",
      text: "Child"
    };
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [parent, child]
      }
    });
    notesApi.queryForest = vi.fn().mockResolvedValue({
      revision: snapshot.revision,
      nodes: [parent, child],
      complete: true
    });
    render(<App api={notesApi} />);
    fireEvent.pointerDown(
      await screen.findByDisplayValue("Parent"),
      { button: 0, pointerId: 3, ctrlKey: true }
    );
    expect(await screen.findByRole("toolbar", {
      name: "Actions for 2 selected notes"
    })).toBeVisible();
    expect(screen.getByDisplayValue("Child").closest(".notes-node"))
      .toHaveAttribute("data-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          kind: "setCompletedMany",
          ids: ["parent", "child"],
          completed: true
        }
      })
    ));
  });
  it("enters contextual selection mode for one modifier-selected row", async () => {
    render(<App api={api()} />);
    const first = await screen.findByDisplayValue("First thought");
    fireEvent.pointerDown(first, { button: 0, pointerId: 4, ctrlKey: true });
    expect(await screen.findByRole("toolbar", {
      name: "Actions for 1 selected notes"
    })).toBeVisible();
    expect(first.closest(".notes-node")).toHaveAttribute(
      "data-selected",
      "true"
    );
  });

  it("clears selection when the live zoom scope changes", async () => {
    render(<App api={api()} />);
    fireEvent.pointerDown(
      await screen.findByDisplayValue("First thought"),
      { button: 0, pointerId: 9, ctrlKey: true }
    );
    await screen.findByRole("toolbar", {
      name: "Actions for 1 selected notes"
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Zoom to item" })[0]);

    await waitFor(() => expect(screen.queryByRole("toolbar", {
      name: /selected notes/
    })).toBeNull());
  });

  it("latches a selection mutation synchronously against double activation", async () => {
    const notesApi = api();
    let release: (() => void) | undefined;
    let call = 0;
    notesApi.execute = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        revision: 8,
        changedNodes: [],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    render(<App api={notesApi} />);
    fireEvent.pointerDown(
      await screen.findByDisplayValue("First thought"),
      { button: 0, pointerId: 12, ctrlKey: true }
    );
    await waitFor(() => expect(notesApi.queryForest).toHaveBeenCalled());
    const complete = screen.getByRole("button", { name: "Complete" });

    fireEvent.click(complete);
    fireEvent.click(complete);

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledOnce());
    release?.();
    await waitFor(() => expect(screen.queryByText("Saving...")).toBeNull());
    expect(notesApi.execute).toHaveBeenCalledOnce();
  });

  it("copies one modifier-selected row as a structural outline", async () => {
    render(<App api={api()} />);
    const first = await screen.findByDisplayValue("First thought");
    fireEvent.pointerDown(first, { button: 0, pointerId: 5, ctrlKey: true });
    const setData = vi.fn();

    fireEvent.copy(screen.getByRole("region", { name: "Notes outline" }), {
      clipboardData: { setData }
    });

    expect(setData).toHaveBeenNthCalledWith(
      1,
      "text/plain",
      "- First thought"
    );
    expect(setData).toHaveBeenNthCalledWith(
      2,
      "text/markdown",
      "- First thought"
    );
  });

  it("refuses destructive Cut when the authoritative forest exceeds its bound", async () => {
    const notesApi = api();
    notesApi.queryForest = vi.fn().mockResolvedValue({
      revision: snapshot.revision,
      nodes: [snapshot.viewport!.nodes[0]],
      complete: false
    });
    render(<App api={notesApi} />);
    fireEvent.pointerDown(
      await screen.findByDisplayValue("First thought"),
      { button: 0, pointerId: 6, ctrlKey: true }
    );
    await waitFor(() => expect(notesApi.queryForest).toHaveBeenCalled());
    const setData = vi.fn();

    fireEvent.cut(screen.getByRole("region", { name: "Notes outline" }), {
      clipboardData: { setData }
    });

    await settled();
    expect(setData).not.toHaveBeenCalled();
    expect(notesApi.execute).not.toHaveBeenCalled();
  });

  /** A row whose note runs past what the clipboard format can carry. */
  async function selectOversizedRow(notesApi: NotesApi): Promise<void> {
    const oversized = {
      ...snapshot.viewport!.nodes[0],
      note: "x".repeat(100_001)
    };
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [oversized, ...snapshot.viewport!.nodes.slice(1)]
      }
    });
    notesApi.queryForest = vi.fn().mockResolvedValue({
      revision: snapshot.revision,
      nodes: [oversized],
      complete: true
    });
    render(<App api={notesApi} />);
    fireEvent.pointerDown(
      await screen.findByDisplayValue("First thought"),
      { button: 0, pointerId: 61, ctrlKey: true }
    );
    await waitFor(() => expect(notesApi.queryForest).toHaveBeenCalled());
  }

  const CUT_OVER_BOUNDS =
    "Cut is unavailable because these rows are too large for the clipboard.";

  // The forest is whole here, so the completeness gate lets the cut through --
  // but a note past the format's own bound leaves nothing to delete against.
  // A row menu reads the loaded window and deletes what the server holds. The
  // forest behind some other selection says nothing about the row that was
  // right-clicked, so the window itself is what has to be whole.
  it("refuses a row Cut while the outline is still paginated", async () => {
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: { ...snapshot.viewport!, afterCursor: "cursor-1" }
    });
    // The next page never lands, so the window stays the partial one.
    notesApi.queryViewport = vi.fn()
      .mockReturnValue(new Promise(() => undefined));
    // A working clipboard, so the refusal is the only thing that can stop the
    // delete: without one the write throws and nothing is deleted regardless.
    vi.stubGlobal("ClipboardItem", class {
      constructor(readonly data: Record<string, Promise<Blob>>) {}
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { write: vi.fn().mockResolvedValue(undefined) },
      configurable: true
    });
    render(<App api={notesApi} />);
    // One unrelated row selected, and its own forest comes back whole -- the
    // signal that used to let this Cut through.
    fireEvent.pointerDown(
      await screen.findByDisplayValue("First thought"),
      { button: 0, pointerId: 71, ctrlKey: true }
    );
    await waitFor(() => expect(notesApi.queryForest).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", {
      name: "Actions for Second thought"
    }));
    const cut = within(await screen.findByRole("menu", { name: "Row actions" }))
      .getAllByRole("menuitem")
      .find((item) => item.querySelector("span")?.textContent === "Cut")!;

    expect(cut).toHaveAttribute("aria-disabled", "true");
    expect(cut).toHaveAttribute(
      "title",
      "The complete selection is not available yet."
    );
    fireEvent.click(cut);
    await settled();
    expect(notesApi.execute).not.toHaveBeenCalled();
  });

  it("refuses destructive Cut when the rows outrun the clipboard format", async () => {
    const notesApi = api();
    await selectOversizedRow(notesApi);
    const setData = vi.fn();

    fireEvent.cut(screen.getByRole("region", { name: "Notes outline" }), {
      clipboardData: { setData }
    });

    // The size is the reason, so the size is what the pane says -- the write
    // never ran, and blaming it would send the reader after the wrong thing.
    await screen.findByText(CUT_OVER_BOUNDS);
    await settled();
    expect(setData).not.toHaveBeenCalled();
    expect(notesApi.execute).not.toHaveBeenCalled();
  });

  // The action bar takes the asynchronous path instead of the cut event, and
  // the same refusal has to reach the same words there.
  it("names the size when the action bar cuts rows past the bound", async () => {
    const notesApi = api();
    await selectOversizedRow(notesApi);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Cut" }));

    await screen.findByText(CUT_OVER_BOUNDS);
    await settled();
    expect(notesApi.execute).not.toHaveBeenCalled();
  });

  // Nothing is serialized until the copy gesture asks for it, so an incomplete
  // forest writes nothing at all rather than a partial outline.
  it("writes no format at all while the authoritative forest is incomplete", async () => {
    const notesApi = api();
    notesApi.queryForest = vi.fn().mockResolvedValue({
      revision: snapshot.revision,
      nodes: [snapshot.viewport!.nodes[0]],
      complete: false
    });
    render(<App api={notesApi} />);
    fireEvent.pointerDown(
      await screen.findByDisplayValue("First thought"),
      { button: 0, pointerId: 16, ctrlKey: true }
    );
    await waitFor(() => expect(notesApi.queryForest).toHaveBeenCalled());
    const setData = vi.fn();

    fireEvent.copy(screen.getByRole("region", { name: "Notes outline" }), {
      clipboardData: { setData }
    });

    expect(setData).not.toHaveBeenCalled();
  });

  it("keeps same-row text drag native and promotes a cross-row drag", async () => {
    render(<App api={api()} />);
    const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    const third = screen.getByDisplayValue("Third thought");
    first.focus();
    first.setSelectionRange(0, 3);

    fireEvent.pointerDown(first, { button: 0, pointerId: 7 });
    fireEvent.pointerMove(first, { buttons: 1, pointerId: 7 });

    expect(first.selectionStart).toBe(0);
    expect(first.selectionEnd).toBe(3);
    expect(first.closest(".notes-node")).not.toHaveAttribute("data-selected");

    fireEvent.pointerMove(third, { buttons: 1, pointerId: 7 });

    expect(await screen.findByRole("toolbar", {
      name: "Actions for 3 selected notes"
    })).toBeVisible();
    for (const value of ["First thought", "Second thought", "Third thought"]) {
      expect(screen.getByDisplayValue(value).closest(".notes-node"))
        .toHaveAttribute("data-selected", "true");
    }
    fireEvent.pointerUp(third, { button: 0, pointerId: 7 });
  });

  it("suppresses native text selection while a cross-row drag is live",
    async () => {
      render(<App api={api()} />);
      const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
        "First thought"
      );
      const third = screen.getByDisplayValue("Third thought");
      const rows = first.closest("ol");

      fireEvent.pointerDown(first, { button: 0, pointerId: 8 });
      fireEvent.pointerMove(first, { buttons: 1, pointerId: 8 });
      // A drag inside one row is ordinary text selection and stays native.
      expect(rows).not.toHaveAttribute("data-row-selecting");

      fireEvent.pointerMove(third, { buttons: 1, pointerId: 8 });
      expect(rows).toHaveAttribute("data-row-selecting", "true");

      // Clearing the range once is not enough — the browser re-extends it on
      // every later move, so the attribute has to outlive the promotion.
      fireEvent.pointerMove(third, { buttons: 1, pointerId: 8 });
      expect(rows).toHaveAttribute("data-row-selecting", "true");

      fireEvent.pointerUp(third, { button: 0, pointerId: 8 });
      expect(rows).not.toHaveAttribute("data-row-selecting");
    });

  it("copies a shift-selected row range as structural plain text and Markdown", async () => {
    render(<App api={api()} />);
    const first = await screen.findByDisplayValue("First thought");
    const second = screen.getByDisplayValue("Second thought");
    fireEvent.pointerDown(first);
    fireEvent.pointerDown(second, { shiftKey: true });
    const setData = vi.fn();

    fireEvent.copy(screen.getByRole("region", { name: "Notes outline" }), {
      clipboardData: { setData }
    });

    for (const [index, type] of ["text/plain", "text/markdown"].entries()) {
      expect(setData).toHaveBeenNthCalledWith(
        index + 1,
        type,
        "- First thought\n- Second thought"
      );
    }
  });

  it("copies a mixed range as marked-up text and a full-fidelity payload", async () => {
    const notesApi = api();
    const image = {
      contentHash: "d".repeat(64),
      originalName: "sample.png",
      mimeType: "image/png",
      byteLength: 1,
      pixelWidth: 1,
      pixelHeight: 1,
      displayWidth: 320
    };
    const rows = [
      {
        ...snapshot.viewport!.nodes[0],
        id: "todo",
        text: "Buy milk",
        marker: "todo" as const,
        completed: true,
        note: "Two litres"
      },
      {
        ...snapshot.viewport!.nodes[1],
        id: "photo",
        kind: "image" as const,
        text: "sample.png",
        image
      },
      { ...snapshot.viewport!.nodes[2], id: "plain", text: "Plain thought" }
    ];
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: { ...snapshot.viewport!, nodes: rows }
    });
    notesApi.queryForest = vi.fn().mockImplementation(async (request) => ({
      revision: snapshot.revision,
      nodes: rows.filter((row) => request.rootIds.includes(row.id)),
      complete: true
    }));
    notesApi.readImage = vi.fn().mockResolvedValue(Uint8Array.from([1]));
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue("Buy milk");
    fireEvent.pointerDown(first);
    fireEvent.pointerDown(screen.getByDisplayValue("Plain thought"), {
      shiftKey: true
    });
    await screen.findByRole("toolbar", {
      name: "Actions for 3 selected notes"
    });
    const setData = vi.fn();

    fireEvent.copy(screen.getByRole("region", { name: "Notes outline" }), {
      clipboardData: { setData }
    });

    expect(setData).toHaveBeenNthCalledWith(1, "text/plain", [
      "- [x] Buy milk",
      "  > Two litres",
      "- sample.png",
      "- Plain thought"
    ].join("\n"));
    const [type, html] = setData.mock.calls[2]!;
    expect(type).toBe("text/html");
    const marker = "<!--yonalist-outline-clipboard:";
    expect(html.startsWith(marker)).toBe(true);
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(
      atob(html.slice(marker.length, html.indexOf("-->"))),
      (character: string) => character.charCodeAt(0)
    )));
    expect(payload).toEqual({
      kind: "yonalist-outline-clipboard",
      version: 1,
      nodes: [
        expect.objectContaining({
          text: "Buy milk",
          note: "Two litres",
          marker: "todo",
          completed: true
        }),
        expect.objectContaining({ text: "sample.png", image }),
        expect.objectContaining({ text: "Plain thought", marker: "bullet" })
      ]
    });
  });

  it("imports an indented outline beside the caret row, not beneath it", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("First thought");

    fireEvent.paste(editor, {
      clipboardData: { getData: () => "- Alpha\n  - Beta" }
    });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "importNodes",
          parent_id: "page",
          before_id: "bullet-2",
          nodes: [
            { id: expect.any(String), parentId: "page", text: "Alpha" },
            { id: expect.any(String), parentId: expect.any(String), text: "Beta" }
          ]
        })
      })
    ));
  });

  it("lands a paste on the last row at the end of the run", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("Third thought");

    fireEvent.paste(editor, {
      clipboardData: { getData: () => "- Alpha\n- Beta" }
    });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "importNodes",
          parent_id: "page",
          before_id: null
        })
      })
    ));
  });

  it("pastes our own copy back with every field it carried", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("First thought");

    fireEvent.paste(editor, { clipboardData: { getData: copiedFormat } });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "importNodes",
          parent_id: "page",
          before_id: "bullet-2",
          nodes: [
            expect.objectContaining({
              parentId: "page",
              text: "Buy milk",
              note: "Two litres",
              marker: "todo",
              completed: true
            }),
            expect.objectContaining({
              text: "sample.png",
              marker: "bullet",
              image: COPIED_IMAGE
            })
          ]
        })
      })
    ));
    expect(notesApi.execute).toHaveBeenCalledOnce();
  });

  // A copied image row rides the clipboard twice over: the bytes as a file item
  // and the whole row in the payload. Importing the bytes would land a fresh
  // lone picture and drop the children, the note and the marker with it.
  it("takes the payload over the picture it rides with", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("First thought");
    const png = new File([Uint8Array.from([1])], "sample.png", {
      type: "image/png"
    });

    fireEvent.paste(editor, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => png }],
        getData: copiedFormat
      }
    });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "importNodes",
          nodes: [
            expect.objectContaining({ text: "Buy milk", marker: "todo" }),
            expect.objectContaining({ text: "sample.png", image: COPIED_IMAGE })
          ]
        })
      })
    ));
    expect(notesApi.execute).toHaveBeenCalledOnce();
    expect(notesApi.importImageBytes).not.toHaveBeenCalled();
  });

  it("falls back to the plain text when the payload cannot be read", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("First thought");

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => type === "text/html"
          ? "<!--yonalist-outline-clipboard:!!!--><ul><li>Alpha</li></ul>"
          : "- Alpha\n  - Beta"
      }
    });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "importNodes",
          nodes: [
            expect.objectContaining({ text: "Alpha" }),
            expect.objectContaining({ text: "Beta" })
          ]
        })
      })
    ));
  });

  // Half a paste would be worse than none, so a refused import says so and
  // stops rather than quietly retrying the title-only text behind it. The
  // bytes on the clipboard beside the payload are no fallback either: importing
  // them would answer a stale hash with a lone picture, the note, the marker
  // and the children of the row all gone.
  it("says so when the copied image outlived the bytes it points at", async () => {
    const notesApi = api();
    notesApi.execute = vi.fn().mockRejectedValue({
      code: "invalid_command",
      message: "A pasted image is no longer in the image store."
    });
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("First thought");
    const png = new File([Uint8Array.from([1])], "sample.png", {
      type: "image/png"
    });

    fireEvent.paste(editor, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => png }],
        getData: copiedFormat
      }
    });

    expect(await screen.findByText(
      "Could not paste: that image is no longer available."
    )).toBeVisible();
    expect(notesApi.execute).toHaveBeenCalledOnce();
    expect(notesApi.importImageBytes).not.toHaveBeenCalled();
  });

  /**
   * The same three rows with the middle one blank, which is the row Enter
   * leaves behind and the one a paste is nearly always aimed at.
   */
  function withBlankSecondRow(
    extra: Partial<NonNullable<BootSnapshot["viewport"]>["nodes"][number]> = {}
  ): NotesApi {
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: snapshot.viewport!.nodes.map((node) =>
          node.id === "bullet-2" ? { ...node, text: "", ...extra } : node)
      }
    });
    return notesApi;
  }

  function envelopesOf(notesApi: NotesApi) {
    return vi.mocked(notesApi.execute).mock.calls.map(([envelope]) => envelope);
  }

  it("replaces an empty bullet with what was pasted into it", async () => {
    const notesApi = withBlankSecondRow();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("First thought");
    const blank = editor.closest("ol")!
      .querySelector<HTMLTextAreaElement>("[data-outline-id='bullet-2'] textarea")!;

    fireEvent.paste(blank, {
      clipboardData: { getData: () => "- Alpha\n- Beta" }
    });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledTimes(2));
    const [imported, removed] = envelopesOf(notesApi);
    // The pasted rows take the blank row's own place, and the blank row goes.
    expect(imported!.command).toEqual(expect.objectContaining({
      kind: "importNodes",
      parent_id: "page",
      before_id: "bullet-3"
    }));
    expect(removed!.command).toEqual({
      kind: "removeEmptyNode",
      id: "bullet-2"
    });
    // One history group across both commands is what folds them into a single
    // undo step: the coalescer keeps merging while the group holds.
    expect(imported!.historyGroup).toEqual(expect.any(String));
    expect(removed!.historyGroup).toBe(imported!.historyGroup);
  });

  it("keeps a caret row that carries anything at all", async () => {
    for (const extra of [
      { marker: "todo" as const },
      { note: "Keep this context" },
      { text: "Second thought" }
    ]) {
      const notesApi = withBlankSecondRow(extra);
      const view = render(<App api={notesApi} />);
      await screen.findByDisplayValue("First thought");
      const row = document.querySelector<HTMLTextAreaElement>(
        "[data-outline-id='bullet-2'] textarea"
      )!;

      fireEvent.paste(row, {
        clipboardData: { getData: () => "- Alpha\n- Beta" }
      });

      await waitFor(() => expect(notesApi.execute).toHaveBeenCalled());
      expect(envelopesOf(notesApi).map((envelope) => envelope.command.kind))
        .toEqual(["importNodes"]);
      expect(envelopesOf(notesApi)[0]!.historyGroup).toBeNull();
      view.unmount();
    }
  });

  it("keeps an empty bullet that is somebody's parent", async () => {
    const notesApi = withBlankSecondRow();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [
          ...snapshot.viewport!.nodes.map((node) =>
            node.id === "bullet-2" ? { ...node, text: "" } : node),
          {
            ...snapshot.viewport!.nodes[0],
            id: "under",
            parentId: "bullet-2",
            text: "Held"
          }
        ]
      }
    });
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("Held");
    const blank = document.querySelector<HTMLTextAreaElement>(
      "[data-outline-id='bullet-2'] textarea"
    )!;

    fireEvent.paste(blank, {
      clipboardData: { getData: () => "- Alpha\n- Beta" }
    });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalled());
    expect(envelopesOf(notesApi).map((envelope) => envelope.command.kind))
      .toEqual(["importNodes"]);
  });

  it("leaves a single-line paste to the field itself", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("First thought");

    // `fireEvent` answers false once something calls `preventDefault`, which is
    // the line between an import and the field's own insertion.
    const native = fireEvent.paste(editor, {
      clipboardData: { getData: () => "one line" }
    });

    expect(native).toBe(true);
    expect(notesApi.execute).not.toHaveBeenCalled();
  });

  it("removes an empty bullet atomically with Backspace", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("Second thought");
    fireEvent.change(editor, { target: { value: "" } });

    fireEvent.keyDown(editor, { key: "Backspace" });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { kind: "removeEmptyNode", id: "bullet-2" }
      })
    ));
  });

  it("indents a selected sibling block through one batch move", async () => {
    const notesApi = api();
    notesApi.undo = vi.fn().mockResolvedValue({
      revision: 9,
      changedNodes: [],
      deletedIds: [],
      history: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1 }
    });
    notesApi.redo = vi.fn().mockResolvedValue({
      revision: 10,
      changedNodes: [],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    render(<App api={notesApi} />);
    const second = await screen.findByDisplayValue("Second thought");
    const third = screen.getByDisplayValue("Third thought");
    fireEvent.pointerDown(second);
    fireEvent.pointerDown(third, { shiftKey: true });

    fireEvent.click(screen.getByRole("button", { name: "Indent" }));

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          kind: "moveNodes",
          moves: [
            { id: "bullet-2", parentId: "bullet-1", beforeId: null },
            { id: "bullet-3", parentId: "bullet-1", beforeId: null }
          ]
        }
      })
    ));
    expect(notesApi.execute).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(notesApi.undo).toHaveBeenCalledOnce());
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(notesApi.redo).toHaveBeenCalledOnce());
  });

  it("routes Tab on a keyboard-selected range through the same batch move", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const second = await screen.findByDisplayValue("Second thought");
    bandDownFrom(second);
    await screen.findByRole("toolbar", {
      name: "Actions for 2 selected notes"
    });

    fireEvent.keyDown(second, { key: "Tab" });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          kind: "moveNodes",
          moves: [
            { id: "bullet-2", parentId: "bullet-1", beforeId: null },
            { id: "bullet-3", parentId: "bullet-1", beforeId: null }
          ]
        }
      })
    ));
  });

  it("duplicates a selected sibling block with one batch command", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue("First thought");
    const second = screen.getByDisplayValue("Second thought");
    fireEvent.pointerDown(first);
    fireEvent.pointerDown(second, { shiftKey: true });

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          kind: "duplicateNodes",
          duplicates: [
            {
              id: "bullet-1",
              newId: expect.any(String),
              parentId: "page",
              beforeId: "bullet-3"
            },
            {
              id: "bullet-2",
              newId: expect.any(String),
              parentId: "page",
              beforeId: "bullet-3"
            }
          ]
        }
      })
    ));
    expect(notesApi.execute).toHaveBeenCalledOnce();
  });

  it("routes the duplicate shortcut to the selected block", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const second = await screen.findByDisplayValue("Second thought");
    bandDownFrom(second);
    await screen.findByRole("toolbar", {
      name: "Actions for 2 selected notes"
    });

    fireEvent.keyDown(second, { key: "d", altKey: true, shiftKey: true });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "duplicateNodes",
          duplicates: [
            expect.objectContaining({ id: "bullet-2" }),
            expect.objectContaining({ id: "bullet-3" })
          ]
        })
      })
    ));
  });

  it("drags a row with one projected batch move and exact depth preview", async () => {
    const notesApi = api();
    const { container } = render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");
    const handles = screen.getAllByRole("button", { name: "Zoom to item" });
    const thirdRow = screen.getByDisplayValue("Third thought")
      .closest<HTMLElement>(".notes-node")!;
    const originalElementFromPoint = Object.getOwnPropertyDescriptor(
      document,
      "elementFromPoint"
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => thirdRow)
    });

    try {
      fireEvent.pointerDown(handles[0], {
        button: 0,
        pointerId: 11,
        clientX: 80,
        clientY: 20
      });
      fireEvent.pointerMove(thirdRow, {
        buttons: 1,
        pointerId: 11,
        clientX: 80,
        clientY: 100
      });

      await waitFor(() =>
        expect(container.querySelector(".notes-outline-drop-preview"))
          .toHaveStyle("--notes-drop-depth: 0"));
      expect(await screen.findByTestId("notes-selection-drag-preview"))
        .toHaveTextContent("First thought");
      fireEvent.pointerUp(thirdRow, { button: 0, pointerId: 11 });

      await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: {
            kind: "moveNodes",
            moves: [{
              id: "bullet-1",
              parentId: "page",
              beforeId: null
            }]
          }
        })
      ));
    } finally {
      if (originalElementFromPoint) {
        Object.defineProperty(
          document,
          "elementFromPoint",
          originalElementFromPoint
        );
      } else {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    }
  });

  it("drags a selected forest through one atomic move command", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue("First thought");
    const second = screen.getByDisplayValue("Second thought");
    const thirdRow = screen.getByDisplayValue("Third thought")
      .closest<HTMLElement>(".notes-node")!;
    fireEvent.pointerDown(first, { button: 0, pointerId: 12 });
    fireEvent.pointerDown(second, {
      button: 0,
      pointerId: 13,
      shiftKey: true
    });
    const handles = screen.getAllByRole("button", { name: "Zoom to item" });
    const originalElementFromPoint = Object.getOwnPropertyDescriptor(
      document,
      "elementFromPoint"
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => thirdRow)
    });

    try {
      fireEvent.pointerDown(handles[0], {
        button: 0,
        pointerId: 14,
        clientX: 80,
        clientY: 20
      });
      fireEvent.pointerMove(thirdRow, {
        buttons: 1,
        pointerId: 14,
        clientX: 80,
        clientY: 100
      });
      expect(await screen.findByTestId("notes-selection-drag-preview"))
        .toHaveAttribute("data-multiple", "true");
      expect(screen.getByText("2", {
        selector: ".notes-selection-drag-preview-count"
      })).toBeVisible();
      fireEvent.pointerUp(thirdRow, { button: 0, pointerId: 14 });

      await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: {
            kind: "moveNodes",
            moves: [
              { id: "bullet-1", parentId: "page", beforeId: null },
              { id: "bullet-2", parentId: "page", beforeId: null }
            ]
          }
        })
      ));
      expect(notesApi.execute).toHaveBeenCalledOnce();
    } finally {
      if (originalElementFromPoint) {
        Object.defineProperty(
          document,
          "elementFromPoint",
          originalElementFromPoint
        );
      } else {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    }
  });

  it("moves a row with the accessible keyboard drag contract", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");
    const firstHandle = screen.getAllByRole("button", {
      name: "Zoom to item"
    })[0];

    fireEvent.keyDown(firstHandle, { key: " " });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Picked up First thought"
    );
    fireEvent.keyDown(firstHandle, { key: "ArrowDown" });
    fireEvent.keyDown(firstHandle, { key: "ArrowRight" });
    fireEvent.keyDown(firstHandle, { key: " " });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          kind: "moveNodes",
          moves: [{
            id: "bullet-1",
            parentId: "bullet-2",
            beforeId: null
          }]
        }
      })
    ));
    expect(notesApi.execute).toHaveBeenCalledOnce();
  });

  it("cancels a keyboard drag without creating history", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");
    const firstHandle = screen.getAllByRole("button", {
      name: "Zoom to item"
    })[0];

    fireEvent.keyDown(firstHandle, { key: " " });
    fireEvent.keyDown(firstHandle, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.querySelector(".notes-outline-drop-preview"))
        .toBeVisible());
    fireEvent.keyDown(firstHandle, { key: "Escape" });

    expect(document.querySelector(".notes-outline-drop-preview")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Keyboard move cancelled"
    );
    expect(notesApi.execute).not.toHaveBeenCalled();
  });

  it("projects a pointer drop into the destination split pane", async () => {
    const notesApi = api();
    const parent = {
      ...snapshot.viewport!.nodes[0],
      id: "parent",
      text: "Parent"
    };
    const child = {
      ...snapshot.viewport!.nodes[1],
      id: "child",
      parentId: "parent",
      text: "Child"
    };
    const source = {
      ...snapshot.viewport!.nodes[2],
      id: "source",
      kind: "image" as const,
      image: {
        contentHash: "c".repeat(64),
        originalName: "source.png",
        mimeType: "image/png",
        byteLength: 1,
        pixelWidth: 1,
        pixelHeight: 1,
        displayWidth: 320
      },
      text: "source.png"
    };
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [parent, child, source]
      }
    });
    notesApi.readImage = vi.fn().mockResolvedValue(Uint8Array.from([1]));
    render(<App api={notesApi} />);
    await screen.findByRole("group", { name: "Image: source.png" });
    fireEvent.click(screen.getAllByRole("button", {
      name: "Zoom to item"
    })[0], { shiftKey: true });
    const panes = screen.getAllByRole("region", { name: "Notes outline" });
    const destinationChild = panes[1].querySelector<HTMLElement>(
      "[data-outline-id='child']"
    )!;
    const sourceHandle = panes[0].querySelectorAll<HTMLButtonElement>(
      "button[aria-label='Zoom to item']"
    )[2];
    const originalElementFromPoint = Object.getOwnPropertyDescriptor(
      document,
      "elementFromPoint"
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => destinationChild)
    });

    try {
      fireEvent.pointerDown(sourceHandle, {
        button: 0,
        pointerId: 23,
        clientX: 80,
        clientY: 20
      });
      fireEvent.pointerMove(destinationChild, {
        buttons: 1,
        pointerId: 23,
        clientX: 80,
        clientY: 100
      });
      await waitFor(() =>
        expect(panes[1].querySelector(".notes-outline-drop-preview"))
          .toBeVisible());
      expect(panes[0].querySelector(".notes-outline-drop-preview")).toBeNull();
      fireEvent.pointerUp(destinationChild, {
        button: 0,
        pointerId: 23
      });

      await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: {
            kind: "moveNodes",
            moves: [{
              id: "source",
              parentId: "parent",
              beforeId: "child"
            }]
          }
        })
      ));
      expect(notesApi.execute).toHaveBeenCalledOnce();
    } finally {
      if (originalElementFromPoint) {
        Object.defineProperty(
          document,
          "elementFromPoint",
          originalElementFromPoint
        );
      } else {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    }
  });

  it("routes image clipboard files before text paste with one sibling anchor", async () => {
    const notesApi = api();
    notesApi.importImageBytes = vi.fn().mockImplementation(
      async (request: ImageImportRequest) => ({
      revision: 8,
      changedNodes: request.images.map((image, index) => ({
        id: image.nodeId,
        parentId: request.parentId,
        sortKey: 1_536 + index,
        kind: "image" as const,
        image: {
          contentHash: (index === 0 ? "a" : "b").repeat(64),
          originalName: image.originalName,
          mimeType: image.declaredMimeType ?? "image/png",
          byteLength: image.blob.size,
          pixelWidth: 1,
          pixelHeight: 1,
          displayWidth: 320
        },
        text: image.originalName,
        note: "",
        marker: "bullet" as const,
        collapsed: false,
        completed: false,
        starred: false,
        deleted: false
      })),
      deletedIds: [],
      history: {
        canUndo: true,
        canRedo: false,
        undoDepth: 1,
        redoDepth: 0
      }
      })
    );
    notesApi.readImage = vi.fn().mockResolvedValue(Uint8Array.from([1]));
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("First thought");
    const cat = new File([Uint8Array.from([1])], "cat.png", {
      type: "image/png"
    });
    const dog = new File([Uint8Array.from([2])], "dog.webp", {
      type: "image/webp"
    });
    const fileItem = (file: File) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file
    });

    fireEvent.paste(editor, {
      clipboardData: {
        items: [fileItem(cat), fileItem(dog)],
        getData: () => "- should not import text"
      }
    });

    await waitFor(() => expect(notesApi.importImageBytes).toHaveBeenCalledOnce());
    const request = vi.mocked(notesApi.importImageBytes).mock.calls[0][0];
    expect(request.parentId).toBe("page");
    expect(request.beforeId).toBe("bullet-2");
    expect(request.images.map((image) => image.originalName)).toEqual([
      "cat.png",
      "dog.webp"
    ]);
    expect(notesApi.execute).not.toHaveBeenCalled();
  });

  /**
   * The whole round trip in one gesture pair: a mixed band across two depths is
   * cut, and what the paste imports is compared field for field against the
   * rows that were cut. The restore itself is the backend's own test -- here
   * the two undo steps are the cut's and the paste's, one command each.
   */
  it("carries a mixed multi-depth band through cut and back on paste", async () => {
    const notesApi = api();
    const rows = [
      {
        ...snapshot.viewport!.nodes[0],
        id: "todo",
        text: "Buy milk",
        marker: "todo" as const,
        completed: true,
        note: "Two litres",
        collapsed: true,
        starred: true
      },
      {
        ...snapshot.viewport!.nodes[1],
        id: "photo",
        parentId: "todo",
        kind: "image" as const,
        text: "sample.png",
        image: COPIED_IMAGE
      },
      { ...snapshot.viewport!.nodes[1], id: "plain", text: "Plain thought" },
      { ...snapshot.viewport!.nodes[2], id: "spare", text: "Spare thought" }
    ];
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: { ...snapshot.viewport!, nodes: rows }
    });
    // The authoritative forest is the roots and everything under them, which is
    // what makes the collapsed image row part of the cut.
    notesApi.queryForest = vi.fn().mockImplementation(async (request) => ({
      revision: snapshot.revision,
      nodes: rows.filter((row) =>
        request.rootIds.includes(row.id) ||
        request.rootIds.includes(row.parentId ?? "")),
      complete: true
    }));
    // The delete reports what it took, so the cut is readable on the outline
    // rather than only in the command it sent.
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => ({
      revision: 8,
      changedNodes: [],
      deletedIds: envelope.command.kind === "deleteSubtrees"
        ? ["todo", "photo", "plain"]
        : [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }));
    // Two entries to walk back: the paste, then the cut. Only the second one
    // hands rows back, which is what makes "the cut is one step" an assertion
    // about the outline rather than about a call count.
    let undone = 0;
    notesApi.undo = vi.fn().mockImplementation(async () => ({
      revision: 9 + (undone += 1),
      changedNodes: undone === 2
        ? rows.filter((row) => row.id !== "spare")
        : [],
      deletedIds: [],
      history: {
        canUndo: true,
        canRedo: true,
        undoDepth: 2 - undone,
        redoDepth: undone
      }
    }));
    render(<App api={notesApi} />);
    fireEvent.pointerDown(await screen.findByDisplayValue("Buy milk"));
    fireEvent.pointerDown(screen.getByDisplayValue("Plain thought"), {
      shiftKey: true
    });
    await screen.findByRole("toolbar", { name: "Actions for 3 selected notes" });
    const setData = vi.fn();

    fireEvent.cut(screen.getByRole("region", { name: "Notes outline" }), {
      clipboardData: { setData }
    });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { kind: "deleteSubtrees", ids: ["todo", "plain"] }
      })
    ));
    const written = new Map<string, string>(setData.mock.calls as [
      string,
      string
    ][]);

    fireEvent.paste(screen.getByDisplayValue("Spare thought"), {
      clipboardData: { getData: (type: string) => written.get(type) ?? "" }
    });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledTimes(2));
    const pasted = vi.mocked(notesApi.execute).mock.calls[1]![0].command;
    if (pasted.kind !== "importNodes") throw new Error("expected importNodes");
    expect(pasted.nodes.map((imported) => ({
      text: imported.text,
      note: imported.note ?? "",
      marker: imported.marker ?? "bullet",
      completed: imported.completed ?? false,
      collapsed: imported.collapsed ?? false,
      starred: imported.starred ?? false,
      image: imported.image ?? null
    }))).toEqual([
      {
        text: "Buy milk",
        note: "Two litres",
        marker: "todo",
        completed: true,
        collapsed: true,
        starred: true,
        image: null
      },
      {
        text: "sample.png",
        note: "",
        marker: "bullet",
        completed: false,
        collapsed: false,
        starred: false,
        image: COPIED_IMAGE
      },
      {
        text: "Plain thought",
        note: "",
        marker: "bullet",
        completed: false,
        collapsed: false,
        starred: false,
        image: null
      }
    ]);
    // The picture rides as a hash, never as bytes on the wire.
    expect(notesApi.importImageBytes).not.toHaveBeenCalled();

    // Two steps back: the paste, then the cut. Only the second one has rows to
    // hand back, so that is the one this can watch. (The receipt for the paste
    // carries no rows to undo here -- the import is not projected optimistically
    // and the stub answers it empty.)
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(notesApi.undo).toHaveBeenCalledOnce());

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    expect(await screen.findByDisplayValue("Buy milk")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Plain thought")).toBeInTheDocument();
  });

  it("keeps 200 immediate draft overlays below the input latency budget", async () => {
    render(<App api={api()} />);
    const editor = await screen.findByDisplayValue("First thought");
    vi.useFakeTimers();
    const samples = Array.from({ length: 200 }, (_, index) => {
      const started = performance.now();
      fireEvent.change(editor, { target: { value: `Draft ${index}` } });
      return performance.now() - started;
    }).sort((left, right) => left - right);

    expect(samples[189]).toBeLessThan(20);
    expect(samples.at(-1)).toBeLessThan(50);
    vi.clearAllTimers();
  });
});
