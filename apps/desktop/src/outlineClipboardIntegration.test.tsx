import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NotesApi } from "./api";
import { App } from "./App";

const snapshot: BootSnapshot = {
  sessionId: "session-clipboard",
  revision: 7,
  activePageId: "page",
  pages: [{ id: "page", title: "Today" }],
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
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn().mockResolvedValue({ hits: [], nextCursor: null }),
    closeSession: vi.fn()
  };
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

    expect(setData).not.toHaveBeenCalled();
    expect(notesApi.execute).not.toHaveBeenCalled();
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

  it("imports an indented outline as one child-subtree command", async () => {
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
          parent_id: "bullet-1",
          before_id: null,
          nodes: [
            { id: expect.any(String), parentId: "bullet-1", text: "Alpha" },
            { id: expect.any(String), parentId: expect.any(String), text: "Beta" }
          ]
        })
      })
    ));
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
    fireEvent.keyDown(second, { key: "ArrowDown", shiftKey: true });
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
    fireEvent.keyDown(second, { key: "ArrowDown", shiftKey: true });
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

      expect(container.querySelector(".notes-outline-drop-preview"))
        .toHaveStyle("--notes-drop-depth: 0");
      expect(screen.getByTestId("notes-selection-drag-preview"))
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
      expect(screen.getByTestId("notes-selection-drag-preview"))
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
    expect(document.querySelector(".notes-outline-drop-preview"))
      .toBeVisible();
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
      text: "Source"
    };
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [parent, child, source]
      }
    });
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("Source");
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

      expect(panes[1].querySelector(".notes-outline-drop-preview"))
        .toBeVisible();
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
