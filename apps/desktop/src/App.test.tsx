import {
  act, fireEvent, render, screen, waitFor, within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import type { NotesApi } from "./api";
import { ROOT_ID } from "./store/storeSupport";
import {
  appApi as api,
  receipt,
  snapshot
} from "./test/appApiFixture";

/** Echoes updateNote back the way the real server does: the full changed node. */
function echoingNoteApi(): NotesApi {
  const notesApi = api();
  notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
    const command = envelope.command;
    if (command.kind !== "updateNote") return receipt("First thought");
    const pageNode = snapshot.viewport!.pageNode!;
    const source = command.id === pageNode.id
      ? pageNode
      : snapshot.viewport!.nodes.find((node) => node.id === command.id)!;
    return {
      revision: 8,
      changedNodes: [{ ...source, note: command.note }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    };
  });
  return notesApi;
}

describe("Yonalist v2 desktop shell", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the current shell and bounded bootstrap without another query", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);

    expect(await screen.findByRole("heading", { name: "Yonalist" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Page title" })).toHaveTextContent("Today");
    expect(screen.getAllByRole("group", { name: "Note text" })[0]).toHaveTextContent(
      "First thought"
    );
    // The heading shares the body's centered column so it lines up with the
    // rows and scrolls away with them, instead of being pinned above them.
    expect(document.querySelector(".notes-outline-content .notes-page-header"))
      .not.toBeNull();
    expect(notesApi.queryViewport).not.toHaveBeenCalled();
  });

  /// Renamed with its premise: the card used to appear because no folder was
  /// recorded, and it now appears because the database has no answer to the one
  /// question the card asks. Neither the recorded folder nor `localStorage` is
  /// read any more, so the stub for that key went with them.
  it("shows the outliner and the vault card together on a first run", async () => {
    const notesApi = api();
    notesApi.onboardingFirstRun = vi.fn().mockResolvedValue(true);

    render(<App api={notesApi} />);

    expect(await screen.findByRole("complementary", { name: "Choose a sync folder" }))
      .toBeVisible();
    expect(screen.getAllByRole("group", { name: "Note text" })[0])
      .toHaveTextContent("First thought");
  });

  it("lists Pages above Library and keeps search behind the header icon", async () => {
    render(<App api={api()} />);
    await screen.findByRole("heading", { name: "Yonalist" });

    const headings = screen.getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings.indexOf("Pages")).toBeLessThan(headings.indexOf("Library"));
    expect(screen.queryByRole("searchbox", { name: "Search Yonalist" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("searchbox", { name: "Search Yonalist" });
    expect(document.querySelector(".yonalist-navigation-header"))
      .toHaveAttribute("data-search-open", "true");

    // A field with a query survives losing focus: its results are below it, and
    // clicking one means clicking away from the field.
    fireEvent.change(search, { target: { value: "thought" } });
    fireEvent.blur(search);
    expect(screen.getByRole("searchbox", { name: "Search Yonalist" })).toBeVisible();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("searchbox", { name: "Search Yonalist" })).toBeNull();
    expect(document.querySelector(".notes-search-results")).toBeNull();
  });

  it("closes an empty search field as soon as it loses focus", async () => {
    render(<App api={api()} />);
    await screen.findByRole("heading", { name: "Yonalist" });

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.blur(screen.getByRole("searchbox", { name: "Search Yonalist" }));

    expect(screen.queryByRole("searchbox", { name: "Search Yonalist" })).toBeNull();
  });

  it("opens the library search from the platform find shortcut", async () => {
    render(<App api={api()} />);
    const row = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );

    // From inside a row textarea: the window has no menu bar, so Cmd+F has to
    // reach the search from wherever the caret happens to be.
    fireEvent.keyDown(row, { key: "f", metaKey: true, ctrlKey: true });

    expect(screen.getByRole("searchbox", { name: "Search Yonalist" }))
      .toHaveFocus();
  });

  it("shows a control's shortcut under it only while the modifier is held", async () => {
    render(<App api={api()} />);
    await screen.findByRole("heading", { name: "Yonalist" });
    const hint = document.querySelector(".shortcut-hint");
    expect(hint?.textContent).toMatch(/F$/u);

    fireEvent.keyDown(window, { key: "Meta" });
    fireEvent.keyDown(window, { key: "Control" });
    expect(document.documentElement).toHaveAttribute("data-modifier-held");

    // Cmd+Tab leaves with the key still down, so no keyup ever arrives.
    fireEvent.blur(window);
    expect(document.documentElement).not.toHaveAttribute("data-modifier-held");
  });

  it("creates the first bullet from the current Add child composer", async () => {
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: []
      }
    });
    render(<App api={notesApi} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add child" }));

    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({
            kind: "createNode",
            parent_id: "page-1",
            before_id: null,
            text: ""
          })
        })
      );
    });
  });

  it("overlays a draft immediately and persists it after 300ms", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    vi.useFakeTimers();

    fireEvent.change(editor, { target: { value: "Instant draft" } });
    expect(editor).toHaveValue("Instant draft");
    expect(notesApi.execute).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(notesApi.execute).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRevision: 7,
        command: {
          kind: "updateText",
          id: "bullet-1",
          text: "Instant draft"
        }
      })
    );
  });

  it("does not interpret Enter while a Korean IME composition is active", async () => {
    const user = userEvent.setup();
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );

    fireEvent.keyDown(editor, {
      key: "Enter",
      nativeEvent: { isComposing: true },
      isComposing: true
    });
    await user.click(screen.getByRole("heading", { name: "Yonalist" }));

    await waitFor(() => {
      expect(notesApi.execute).not.toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({ kind: "createNode" })
        })
      );
    });
  });

  it("routes terminal Enter through one atomic split command", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    editor.setSelectionRange(editor.value.length, editor.value.length);

    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({
            kind: "splitNode",
            id: "bullet-1",
            parent_id: "page-1",
            before_id: "bullet-2",
            prefix: "First thought",
            suffix: ""
          })
        })
      );
    });
  });

  it("splits a selected range, renders the suffix row, and focuses its start", async () => {
    const notesApi = api();
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      const command = envelope.command;
      if (command.kind !== "splitNode") return receipt("First thought");
      return {
        revision: 8,
        changedNodes: [
          { ...snapshot.viewport!.nodes[0], text: command.prefix },
          {
            ...snapshot.viewport!.nodes[0],
            id: command.new_id,
            sortKey: 1536,
            text: command.suffix
          }
        ],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    fireEvent.change(editor, { target: { value: "alphaXYZomega" } });
    editor.setSelectionRange(5, 8);

    fireEvent.keyDown(editor, { key: "Enter" });

    const suffix = await screen.findByDisplayValue<HTMLTextAreaElement>("omega");
    await waitFor(() => expect(suffix).toHaveFocus());
    expect(screen.getAllByRole("group", { name: "Note text" }).some(
      (presentation) => presentation.textContent === "alpha"
    )).toBe(true);
    expect(suffix.selectionStart).toBe(0);
    expect(suffix.selectionEnd).toBe(0);
  });

  it("moves the Enter caret before the next animation frame", async () => {
    const notesApi = api();
    notesApi.execute = vi.fn().mockImplementation(() => new Promise(() => undefined));
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    first.setSelectionRange(first.value.length, first.value.length);
    const animationFrame = vi.spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);

    try {
      fireEvent.keyDown(first, { key: "Enter" });
      await act(async () => undefined);

      const blank = screen.getAllByLabelText<HTMLTextAreaElement>("Note text")
        .find((editor) => editor.value === "");
      expect(blank).toHaveFocus();
    } finally {
      animationFrame.mockRestore();
    }
  });

  it("does not rerender unchanged rows when Enter inserts a sibling", async () => {
    const notesApi = api();
    const boot = structuredClone(snapshot);
    let unchangedTextReads = 0;
    Object.defineProperty(boot.viewport!.nodes[0]!, "text", {
      configurable: true,
      enumerable: true,
      get: () => {
        unchangedTextReads += 1;
        return "First thought";
      }
    });
    notesApi.bootstrap = vi.fn().mockResolvedValue(boot);
    notesApi.execute = vi.fn().mockImplementation(() => new Promise(() => undefined));
    render(<App api={notesApi} />);
    const second = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "Second thought"
    );
    second.setSelectionRange(second.value.length, second.value.length);
    unchangedTextReads = 0;

    fireEvent.keyDown(second, { key: "Enter" });
    await act(async () => undefined);

    expect(unchangedTextReads).toBe(0);
  });

  it("keeps accepting repeated Enter while earlier split commits are pending", async () => {
    const notesApi = api();
    notesApi.execute = vi.fn().mockImplementation(() => new Promise(() => undefined));
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    first.setSelectionRange(first.value.length, first.value.length);

    fireEvent.keyDown(first, { key: "Enter" });

    await waitFor(() => {
      const blank = screen.getAllByLabelText<HTMLTextAreaElement>("Note text")
        .find((editor) => editor.value === "");
      expect(blank).toHaveFocus();
    });
    const firstBlank = screen.getAllByLabelText<HTMLTextAreaElement>("Note text")
      .find((editor) => editor.value === "")!;
    expect(firstBlank).not.toHaveAttribute("placeholder");

    fireEvent.keyDown(firstBlank, { key: "Enter", repeat: true });

    await waitFor(() => {
      const blanks = screen.getAllByLabelText<HTMLTextAreaElement>("Note text")
        .filter((editor) => editor.value === "");
      expect(blanks).toHaveLength(2);
      expect(blanks[1]).toHaveFocus();
    });
  });

  it("leaves no blank rows after the caret when Enter repeats before focus moves", async () => {
    const notesApi = api();
    notesApi.execute = vi.fn().mockImplementation(() => new Promise(() => undefined));
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    first.setSelectionRange(first.value.length, first.value.length);

    fireEvent.keyDown(first, { key: "Enter" });
    for (let index = 0; index < 4; index += 1) {
      fireEvent.keyDown(first, { key: "Enter", repeat: true });
    }

    await waitFor(() => {
      const editors = Array.from(
        document.querySelectorAll<HTMLTextAreaElement>(
          "textarea.notes-node-title"
        )
      );
      expect(editors.map((editor) => editor.value)).toEqual([
        "First thought",
        "",
        "",
        "",
        "",
        "",
        "Second thought"
      ]);
      expect(editors[5]).toHaveFocus();
    });
  });

  it("merges backward into the current row and focuses the exact join", async () => {
    const notesApi = api();
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      if (envelope.command.kind !== "mergeNodeBackward") {
        return receipt("First thought");
      }
      return {
        revision: 8,
        changedNodes: [{
          ...snapshot.viewport!.nodes[1],
          sortKey: 1024,
          text: envelope.command.previous_text + envelope.command.current_text
        }],
        deletedIds: ["bullet-1"],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    render(<App api={notesApi} />);
    const second = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "Second thought"
    );
    second.focus();
    second.setSelectionRange(0, 0);

    fireEvent.keyDown(second, { key: "Backspace" });

    const merged = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thoughtSecond thought"
    );
    await waitFor(() => {
      expect(merged).toHaveFocus();
      expect(merged.selectionStart).toBe("First thought".length);
    });
    expect(merged.dataset.nodeId).toBe("bullet-2");
    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: {
        kind: "mergeNodeBackward",
        id: "bullet-2",
        previous_id: "bullet-1",
        previous_text: "First thought",
        current_text: "Second thought"
      }
    }));
  });

  it("creates the first child from terminal Enter on a parent row", async () => {
    const child = {
      ...snapshot.viewport!.nodes[1],
      id: "child",
      parentId: "bullet-1",
      text: "Existing child",
      sortKey: 1024
    };
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [snapshot.viewport!.nodes[0], child, snapshot.viewport!.nodes[1]]
      }
    });
    render(<App api={notesApi} />);
    const parent = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    parent.setSelectionRange(parent.value.length, parent.value.length);

    fireEvent.keyDown(parent, { key: "Enter" });

    // The same split as a mid-text Enter on a parent, with an empty half after
    // the caret: one rule, one command.
    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
        command: expect.objectContaining({
          kind: "splitNode",
          id: "bullet-1",
          parent_id: "bullet-1",
          before_id: "child",
          prefix: "First thought",
          suffix: ""
        })
      }));
    });
  });

  it("moves repeated vertical arrows across rows and the page-title boundary immediately", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const pageTitle = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "Today"
    );
    const first = screen.getByDisplayValue<HTMLTextAreaElement>("First thought");
    const second = screen.getByDisplayValue<HTMLTextAreaElement>("Second thought");
    first.focus();
    first.setSelectionRange(4, 4);

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    expect(second.selectionStart).toBe(0);

    fireEvent.keyDown(second, { key: "ArrowUp", repeat: true });
    expect(first).toHaveFocus();
    expect(first.selectionStart).toBe(0);

    fireEvent.keyDown(first, { key: "ArrowUp", repeat: true });
    expect(pageTitle).toHaveFocus();

    fireEvent.keyDown(pageTitle, { key: "ArrowDown", repeat: true });
    expect(first).toHaveFocus();
  });

  it("crosses title boundaries immediately with repeated horizontal arrows", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    const second = screen.getByDisplayValue<HTMLTextAreaElement>(
      "Second thought"
    );
    second.focus();
    second.setSelectionRange(0, 0);

    fireEvent.keyDown(second, { key: "ArrowLeft", repeat: true });
    expect(first).toHaveFocus();
    expect(first.selectionStart).toBe(first.value.length);

    fireEvent.keyDown(first, { key: "ArrowRight", repeat: true });
    expect(second).toHaveFocus();
    expect(second.selectionStart).toBe(0);
  });

  it("extends and clears a pane-local selection with the keyboard", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue("First thought");
    const second = screen.getByDisplayValue("Second thought");

    // The chord sweeps the row's own text first, then the row, then the row
    // below it, so a band across the pair stands three presses in.
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => {
      expect(first.closest(".notes-node")).toHaveAttribute(
        "data-selected",
        "true"
      );
      expect(second.closest(".notes-node")).toHaveAttribute(
        "data-selected",
        "true"
      );
    });

    fireEvent.keyDown(first, { key: "Escape" });
    await waitFor(() => {
      expect(first.closest(".notes-node")).not.toHaveAttribute("data-selected");
      expect(second.closest(".notes-node")).not.toHaveAttribute("data-selected");
    });
  });

  it("keeps the export target pane-local across ordinary and selection toolbars", async () => {
    render(<App api={api()} />);
    const first = await screen.findByDisplayValue("First thought");
    const second = screen.getByDisplayValue("Second thought");

    const ordinaryExport = await screen.findByRole("button", { name: "Export" });
    fireEvent.click(ordinaryExport);
    let menu = await screen.findByRole("menu", { name: "Export notes" });
    expect(within(menu).getByRole("menuitem", {
      name: "Selected node as Markdown"
    })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", {
      name: "Current page as Markdown"
    })).toBeEnabled();
    fireEvent.click(ordinaryExport);

    fireEvent.pointerDown(first, {
      button: 0,
      pointerId: 31,
      ctrlKey: true
    });
    expect(await screen.findByRole("toolbar", {
      name: "Actions for 1 selected notes"
    })).toBeVisible();
    const selectionExport = await screen.findByRole("button", { name: "Export" });
    fireEvent.click(selectionExport);
    menu = await screen.findByRole("menu", { name: "Export notes" });
    expect(within(menu).getByRole("menuitem", {
      name: "Selected node as Markdown"
    })).toBeEnabled();
    fireEvent.click(selectionExport);

    fireEvent.pointerDown(second, {
      button: 0,
      pointerId: 32,
      ctrlKey: true
    });
    expect(await screen.findByRole("toolbar", {
      name: "Actions for 2 selected notes"
    })).toBeVisible();
    const multiSelectionExport = await screen.findByRole("button", {
      name: "Export"
    });
    fireEvent.click(multiSelectionExport);
    menu = await screen.findByRole("menu", { name: "Export notes" });
    expect(within(menu).getByRole("menuitem", {
      name: "Selected node as Markdown"
    })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", {
      name: "Current page as Markdown"
    })).toBeEnabled();
  });

  it("counts the selection beside Online, not in the message slot", async () => {
    render(<App api={api()} />);
    const first = await screen.findByDisplayValue("First thought");
    const second = screen.getByDisplayValue("Second thought");
    const statusBar = screen.getByLabelText("Status bar");

    fireEvent.pointerDown(first, { button: 0, pointerId: 41, ctrlKey: true });
    fireEvent.pointerDown(second, { button: 0, pointerId: 42, ctrlKey: true });

    // The count is state the band holds, so it reads where the bar already
    // keeps state -- at the right, in front of Online.
    await within(statusBar).findByText("2 selected");
    expect([...statusBar.querySelector(".statusbar-actions")!.children]
      .map((child) => child.textContent)).toEqual(["2 selected", "Online"]);
    expect(statusBar.querySelector(".statusbar-feedback")).toBeEmptyDOMElement();
  });

  it("says nothing in the status bar while a write is in flight", async () => {
    const notesApi = api();
    notesApi.execute = vi.fn().mockImplementation(
      () => new Promise(() => undefined)
    );
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue("First thought");
    const statusBar = screen.getByLabelText("Status bar");

    fireEvent.pointerDown(first, { button: 0, pointerId: 44, ctrlKey: true });
    await within(statusBar).findByText("1 selected");
    fireEvent.click(await screen.findByRole("button", { name: "Complete" }));

    // A write settles in a few hundred milliseconds without the reader doing
    // anything, so announcing it only makes the bar flicker. The controls that
    // must wait already say so themselves through aria-busy.
    await waitFor(() => expect(notesApi.execute).toHaveBeenCalled());
    expect(statusBar.querySelector(".statusbar-feedback")).toBeEmptyDOMElement();
    expect(within(statusBar).getByText("1 selected")).toBeVisible();
  });

  it("keeps the count beside an error the band's own action raised", async () => {
    const notesApi = api();
    notesApi.execute = vi.fn().mockRejectedValue(new Error("Save refused"));
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue("First thought");
    const statusBar = screen.getByLabelText("Status bar");

    fireEvent.pointerDown(first, { button: 0, pointerId: 45, ctrlKey: true });
    await within(statusBar).findByText("1 selected");
    fireEvent.click(await screen.findByRole("button", { name: "Complete" }));

    // The band survives a failed action, so reporting the failure must not cost
    // the reader the count of what is still selected.
    expect(await within(statusBar).findByText("Save refused")).toBeVisible();
    expect(within(statusBar).getByText("1 selected")).toBeVisible();
  });

  it("keeps the breadcrumb readable while the selection actions float over it", async () => {
    render(<App api={api()} />);
    const first = await screen.findByDisplayValue("First thought");

    fireEvent.pointerDown(first, { button: 0, pointerId: 43, ctrlKey: true });

    // The band's actions used to take the toolbar's place, which took the page
    // path with it -- the one thing a reader needs to know where the band is.
    expect(await screen.findByRole("toolbar", {
      name: "Actions for 1 selected notes"
    })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
  });

  it("hides a collapsed subtree and restores it through the current arrow slot", async () => {
    const parent = { ...snapshot.viewport!.nodes[0], collapsed: true };
    const child = {
      ...snapshot.viewport!.nodes[1],
      id: "child",
      parentId: parent.id,
      text: "Hidden child",
      sortKey: 1024
    };
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [parent, child, snapshot.viewport!.nodes[1]]
      }
    });
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => ({
      revision: 8,
      changedNodes: [{
        ...parent,
        collapsed: envelope.command.kind === "setCollapsed"
          ? envelope.command.collapsed
          : parent.collapsed
      }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }));
    render(<App api={notesApi} />);

    expect(await screen.findByRole("button", {
      name: "Expand First thought"
    })).toBeVisible();
    expect(screen.queryByDisplayValue("Hidden child")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "Expand First thought"
    }));
    await waitFor(() => {
      expect(screen.getAllByRole("group", { name: "Note text" }).some(
        (presentation) => presentation.textContent === "Hidden child"
      )).toBe(true);
    });
    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: {
        kind: "setCollapsed",
        id: "bullet-1",
        collapsed: false
      }
    }));
  });

  it("opens, edits, and flushes a supporting note with Shift+Enter", async () => {
    const notesApi = api();
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => ({
      revision: 8,
      changedNodes: [{
        ...snapshot.viewport!.nodes[0],
        note: envelope.command.kind === "updateNote"
          ? envelope.command.note
          : ""
      }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }));
    render(<App api={notesApi} />);
    const title = await screen.findByDisplayValue("First thought");

    fireEvent.keyDown(title, { key: "Enter", shiftKey: true });
    const note = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Supporting note: First thought"
    });
    await waitFor(() => expect(note).toHaveFocus());
    fireEvent.change(note, { target: { value: "Supporting context" } });
    fireEvent.blur(note);

    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
        command: {
          kind: "updateNote",
          id: "bullet-1",
          note: "Supporting context"
        }
      }));
    });
    expect(note).toHaveValue("Supporting context");
  });

  it("focuses a note opened with Shift+Enter without waiting for a frame", async () => {
    render(<App api={api()} />);
    const title = await screen.findByDisplayValue("First thought");
    const pageTitle = screen.getByDisplayValue("Today");
    // An occluded or backgrounded window runs no frame callbacks at all, so a
    // caret that waits on one never arrives -- in the browser the field mounted
    // and focus stayed on the title.
    const frames = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(() => 0);
    // Queried off the data attributes, not the accessible name: an unfocused
    // field marks its textarea `aria-hidden`, so a role query would report the
    // field missing instead of reporting where the caret went.
    const noteField = (nodeId: string) => document.querySelector(
      `textarea[data-outline-field="note"][data-node-id="${nodeId}"]`
    );
    try {
      fireEvent.keyDown(title, { key: "Enter", shiftKey: true });
      expect(noteField("bullet-1")).toHaveFocus();

      fireEvent.keyDown(pageTitle, { key: "Enter", shiftKey: true });
      expect(noteField("page-1")).toHaveFocus();
    } finally {
      frames.mockRestore();
    }
  });

  it("moves from a supporting note to the next visible title", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const firstTitle = await screen.findByDisplayValue("First thought");
    const secondTitle = screen.getByDisplayValue("Second thought");

    fireEvent.keyDown(firstTitle, { key: "Enter", shiftKey: true });
    const note = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Supporting note: First thought"
    });
    fireEvent.keyDown(note, {
      key: "ArrowDown",
      target: { selectionStart: 0, selectionEnd: 0 }
    });

    await waitFor(() => expect(secondTitle).toHaveFocus());
  });

  it("closes a note erased to empty and lands at the end of its title", async () => {
    render(<App api={api()} />);
    const title = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );

    fireEvent.keyDown(title, { key: "Enter", shiftKey: true });
    const note = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Supporting note: First thought"
    });
    fireEvent.change(note, { target: { value: "Supporting context" } });
    fireEvent.change(note, { target: { value: "" } });
    fireEvent.keyDown(note, { key: "Backspace" });

    await waitFor(() => expect(title).toHaveFocus());
    expect(title.selectionStart).toBe("First thought".length);
    expect(document.querySelector(
      '[data-outline-field="note"][data-node-id="bullet-1"]'
    )).toBeNull();
  });

  it("closes an erased page note and lands at the end of the page title", async () => {
    render(<App api={api()} />);
    const pageTitle = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "Today"
    );

    fireEvent.keyDown(pageTitle, { key: "Enter", shiftKey: true });
    const note = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Page note"
    });
    fireEvent.change(note, { target: { value: "Page context" } });
    fireEvent.change(note, { target: { value: "" } });
    fireEvent.keyDown(note, { key: "Backspace" });

    await waitFor(() => expect(pageTitle).toHaveFocus());
    expect(pageTitle.selectionStart).toBe("Today".length);
    expect(document.querySelector(
      '[data-outline-field="note"][data-node-id="page-1"]'
    )).toBeNull();
  });

  it("creates the next sibling from the last supporting note with Shift+Enter", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const lastTitle = await screen.findByDisplayValue("Second thought");

    fireEvent.keyDown(lastTitle, { key: "Enter", shiftKey: true });
    const note = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Supporting note: Second thought"
    });
    fireEvent.keyDown(note, { key: "Enter", shiftKey: true });

    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
        command: expect.objectContaining({
          kind: "createNode",
          parent_id: "page-1",
          before_id: null,
          text: ""
        })
      }));
    });
  });

  it("opens and persists the page note with Shift+Enter on the title", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const pageTitle = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "Today"
    );

    fireEvent.keyDown(pageTitle, { key: "Enter", shiftKey: true });
    const note = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Page note"
    });
    await waitFor(() => expect(note).toHaveFocus());
    // Shift+Enter must open the note, not put a newline into the title.
    expect(pageTitle).toHaveValue("Today");
    fireEvent.change(note, { target: { value: "Page context" } });
    fireEvent.blur(note);

    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
        command: {
          kind: "updateNote",
          id: "page-1",
          note: "Page context"
        }
      }));
    });
  });

  it("keeps the page heading note across the draft flush", async () => {
    render(<App api={echoingNoteApi()} />);
    const heading = await screen.findByDisplayValue<HTMLTextAreaElement>("Today");

    fireEvent.keyDown(heading, { key: "Enter", shiftKey: true });
    const note = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Page note"
    });
    vi.useFakeTimers();
    fireEvent.change(note, { target: { value: "page note" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(note).toHaveValue("page note");
  });

  it("keeps the zoomed heading note across the draft flush", async () => {
    render(<App api={echoingNoteApi()} />);
    await screen.findByDisplayValue("First thought");
    fireEvent.click(screen.getAllByRole("button", { name: "Zoom to item" })[0]!);
    const heading = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    await waitFor(() =>
      expect(heading).toHaveAttribute("aria-label", "Page title"));

    fireEvent.keyDown(heading, { key: "Enter", shiftKey: true });
    const note = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Page note"
    });
    vi.useFakeTimers();
    fireEvent.change(note, { target: { value: "zoomed note" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(note).toHaveValue("zoomed note");
  });

  it("renders a persisted page note on load", async () => {
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        pageNode: { ...snapshot.viewport!.pageNode!, note: "Page context" }
      }
    });
    render(<App api={notesApi} />);

    // A resting field renders as its presentation group; the textarea behind it
    // is aria-hidden until the field is focused.
    expect(await screen.findByRole("group", { name: "Page note" }))
      .toHaveTextContent("Page context");
  });

  it("hides an untouched page note again on blur", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const pageTitle = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "Today"
    );

    fireEvent.keyDown(pageTitle, { key: "Enter", shiftKey: true });
    const note = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Page note"
    });
    fireEvent.blur(note);

    await waitFor(() => expect(
      document.querySelector('[data-outline-field="note"][data-node-id="page-1"]')
    ).toBeNull());
  });

  it("converts a bullet to Todo and renders its stable checkbox", async () => {
    const notesApi = api();
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => ({
      revision: 8,
      changedNodes: [{
        ...snapshot.viewport!.nodes[0],
        marker: envelope.command.kind === "setMarker"
          ? envelope.command.marker
          : "bullet"
      }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }));
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getByRole("button", { name: "Actions for First thought" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "To-do" }));

    expect(await screen.findByRole("checkbox", {
      name: "Mark complete: First thought"
    })).toBeVisible();
    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: {
        kind: "setMarker",
        id: "bullet-1",
        marker: "todo"
      }
    }));
  });

  // A checklist stays a checklist: the split command carries the marker, so the
  // row Enter opens wears its own box from the first paint.
  it("gives the row Enter opens on a Todo its own checkbox", async () => {
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [
          { ...snapshot.viewport!.nodes[0]!, marker: "todo" as const },
          snapshot.viewport!.nodes[1]!
        ]
      }
    });
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    editor.setSelectionRange(editor.value.length, editor.value.length);

    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(
      screen.getAllByRole("checkbox", { name: /^Mark complete:/u })
    ).toHaveLength(2));
  });

  it("takes the box off an emptied Todo before the row itself", async () => {
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [
          {
            ...snapshot.viewport!.nodes[0]!,
            text: "",
            marker: "todo" as const
          },
          snapshot.viewport!.nodes[1]!
        ]
      }
    });
    render(<App api={notesApi} />);
    await screen.findByRole("checkbox", { name: "Mark complete: Untitled" });
    const editor = screen.getAllByLabelText<HTMLTextAreaElement>("Note text")
      .find((candidate) => candidate.value === "")!;
    editor.focus();
    editor.setSelectionRange(0, 0);

    fireEvent.keyDown(editor, { key: "Backspace" });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { kind: "setMarker", id: "bullet-1", marker: "bullet" }
      })
    ));
    expect(notesApi.execute).not.toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({ kind: "removeEmptyNode" })
    }));
  });

  it("shows one bar per Todo chain, counting the whole branch", async () => {
    const parent = { ...snapshot.viewport!.nodes[0], marker: "todo" as const };
    const directDone = {
      ...snapshot.viewport!.nodes[1],
      id: "direct-done",
      parentId: parent.id,
      marker: "todo" as const,
      completed: true
    };
    const directOpen = {
      ...snapshot.viewport!.nodes[1],
      id: "direct-open",
      parentId: parent.id,
      marker: "todo" as const
    };
    const grandchild = {
      ...snapshot.viewport!.nodes[1],
      id: "grandchild",
      parentId: directOpen.id,
      marker: "todo" as const,
      completed: true
    };
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [parent, directDone, directOpen, grandchild]
      }
    });
    render(<App api={notesApi} />);

    const bar = await screen.findByRole("progressbar", {
      name: "2 of 3 To-dos complete"
    });
    expect(bar).toBeVisible();
    expect(within(bar).getByText("2/3")).toBeVisible();
    // direct-open carries a Todo of its own, but the chain it belongs to is
    // already reported one row up.
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  });

  it("counts down to the total alone once the chain is finished", async () => {
    const parent = { ...snapshot.viewport!.nodes[0], marker: "todo" as const };
    const child = {
      ...snapshot.viewport!.nodes[1],
      id: "child",
      parentId: parent.id,
      marker: "todo" as const,
      completed: true
    };
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: { ...snapshot.viewport!, nodes: [parent, child] }
    });
    render(<App api={notesApi} />);

    const bar = await screen.findByRole("progressbar", {
      name: "1 of 1 To-dos complete"
    });
    expect(within(bar).getByText("1")).toBeVisible();
    expect(within(bar).queryByText("1/1")).toBeNull();
  });

  // The chain the tick settles reaches past the loaded window, so the row that
  // was clicked is all the client sends and notes-core settles the rest.
  it("sends the ticked box alone and leaves the chain to the server", async () => {
    const parent = { ...snapshot.viewport!.nodes[0], marker: "todo" as const };
    const child = {
      ...snapshot.viewport!.nodes[1],
      id: "child",
      parentId: parent.id,
      marker: "todo" as const
    };
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: { ...snapshot.viewport!, nodes: [parent, child] }
    });
    render(<App api={notesApi} />);

    fireEvent.click(await screen.findByRole("checkbox", {
      name: `Mark complete: ${parent.text}`
    }));

    await waitFor(() => {
      expect(vi.mocked(notesApi.execute).mock.calls.at(-1)?.[0].command)
        .toEqual({ kind: "setCompleted", id: parent.id, completed: true });
    });
  });

  it("applies /todo as one coalesced text-and-marker gesture", async () => {
    const notesApi = api();
    let current = snapshot.viewport!.nodes[0];
    let revision = snapshot.revision;
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      revision += 1;
      if (envelope.command.kind === "updateText") {
        current = { ...current, text: envelope.command.text };
      }
      if (envelope.command.kind === "setMarker") {
        current = { ...current, marker: envelope.command.marker };
      }
      return {
        revision,
        changedNodes: [current],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    render(<App api={notesApi} />);
    const title = await screen.findByDisplayValue<HTMLTextAreaElement>("First thought");

    fireEvent.change(title, {
      target: { value: "/todo", selectionStart: 5, selectionEnd: 5 }
    });
    expect(await screen.findByRole("listbox", { name: "Slash commands" })).toBeVisible();
    fireEvent.keyDown(title, { key: "Enter" });

    expect(await screen.findByRole("checkbox", {
      name: "Mark complete: Untitled"
    })).toBeVisible();
    const calls = vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope
    );
    expect(calls.at(-2)?.historyGroup).toMatch(/^slash:/);
    expect(calls.at(-1)?.historyGroup).toBe(calls.at(-2)?.historyGroup);
    expect(calls.at(-2)?.command).toEqual({
      kind: "updateText",
      id: "bullet-1",
      text: ""
    });
    expect(calls.at(-1)?.command).toEqual({
      kind: "setMarker",
      id: "bullet-1",
      marker: "todo"
    });
  });

  it("offers a checked row the way back, and takes it", async () => {
    const notesApi = api();
    let current = {
      ...snapshot.viewport!.nodes[0],
      marker: "todo" as const,
      completed: true
    };
    let revision = snapshot.revision;
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [current, snapshot.viewport!.nodes[1]]
      }
    });
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      revision += 1;
      if (envelope.command.kind === "updateText") {
        current = { ...current, text: envelope.command.text };
      }
      if (envelope.command.kind === "setMarker") {
        current = { ...current, marker: envelope.command.marker };
      }
      if (envelope.command.kind === "setCompleted") {
        current = { ...current, completed: envelope.command.completed };
      }
      return {
        revision,
        changedNodes: [current],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    render(<App api={notesApi} />);
    const title = await screen.findByDisplayValue<HTMLTextAreaElement>("First thought");

    fireEvent.change(title, {
      target: {
        value: "First thought /todo",
        selectionStart: 19,
        selectionEnd: 19
      }
    });
    expect(await screen.findByRole("option", { name: /Change to bullet/ }))
      .toBeVisible();
    fireEvent.keyDown(title, { key: "Enter" });

    await waitFor(() => expect(vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope.command
    ).at(-1)).toEqual({
      kind: "setMarker",
      id: "bullet-1",
      marker: "bullet"
    }));
    const calls = vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope
    );
    // Text, marker and the tick undo as one step.
    expect(calls.at(-1)?.historyGroup).toMatch(/^slash:/);
    expect(calls.at(-2)?.historyGroup).toBe(calls.at(-1)?.historyGroup);
    // The tick goes back with the box: a finished row with no box to untick
    // would draw a line through itself with nothing to undo it.
    expect(calls.map(({ command }) => command)).toContainEqual({
      kind: "setCompleted",
      id: "bullet-1",
      completed: false
    });
    // What the row keeps is everything the query was not.
    await waitFor(() => expect(title).toHaveValue("First thought "));
  });

  // The same seam `/todo` commits through, so the box and the text it strips
  // undo together.
  it("turns a task box typed at a title's start into a check box", async () => {
    const notesApi = api();
    let current = snapshot.viewport!.nodes[0];
    let revision = snapshot.revision;
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      revision += 1;
      const { command } = envelope;
      if (command.kind === "updateText") current = { ...current, text: command.text };
      if (command.kind === "setMarker") current = { ...current, marker: command.marker };
      if (command.kind === "setCompleted") {
        current = { ...current, completed: command.completed };
      }
      return {
        revision,
        changedNodes: [current],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    render(<App api={notesApi} />);
    const title = await screen.findByDisplayValue<HTMLTextAreaElement>("First thought");

    fireEvent.change(title, {
      target: { value: "[x] Shipped", selectionStart: 4, selectionEnd: 4 }
    });

    expect(await screen.findByRole("checkbox", {
      name: "Mark incomplete: Shipped"
    })).toBeVisible();
    // The prefix is off the row and the caret stands where the title now begins.
    expect(title.value).toBe("Shipped");
    expect(title.selectionStart).toBe(0);
    const calls = vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope
    );
    expect(calls.map(({ command }) => command)).toEqual([
      { kind: "updateText", id: "bullet-1", text: "Shipped" },
      { kind: "setMarker", id: "bullet-1", marker: "todo" },
      { kind: "setCompleted", id: "bullet-1", completed: true }
    ]);
    // One group across all three: one keystroke, one undo step.
    expect(new Set(calls.map(({ historyGroup }) => historyGroup)).size).toBe(1);
    expect(calls[0]?.historyGroup).toMatch(/^slash:/u);
  });

  // A literal `[ ] ` title is meant to stay typeable, so the rule reads the
  // value the row held before the keystroke, not the shape the keystroke left.
  it("leaves a literal box title alone when a later edit ends at the box", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const title = await screen.findByDisplayValue<HTMLTextAreaElement>("First thought");

    // The whole line at once: the caret lands at its end, so no box is made.
    fireEvent.change(title, {
      target: { value: "[ ] one", selectionStart: 7, selectionEnd: 7 }
    });
    // Backspace over the `o`, which puts the caret right after the box.
    fireEvent.change(title, {
      target: { value: "[ ] ne", selectionStart: 4, selectionEnd: 4 }
    });

    expect(title.value).toBe("[ ] ne");
    expect(screen.queryByRole("checkbox", { name: "Mark complete: ne" })).toBeNull();
    expect(vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope.command.kind
    )).not.toContain("setMarker");
  });

  it("indents the current row below its previous sibling with Tab", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("Second thought");

    fireEvent.keyDown(editor, { key: "Tab" });

    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: {
            kind: "indent",
            id: "bullet-2",
            new_parent_id: "bullet-1"
          }
        })
      );
    });
  });

  it("outdents a row directly after its former parent", async () => {
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [
          snapshot.viewport!.nodes[0],
          { ...snapshot.viewport!.nodes[1], parentId: "bullet-1" },
          {
            ...snapshot.viewport!.nodes[1],
            id: "bullet-3",
            text: "Third thought",
            sortKey: 3072
          }
        ]
      }
    });
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("Second thought");

    fireEvent.keyDown(editor, { key: "Tab", shiftKey: true });

    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: {
            kind: "outdent",
            id: "bullet-2",
            new_parent_id: "page-1",
            before_id: "bullet-3"
          }
        })
      );
    });
  });

  it("executes duplicate through the row action menu", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getByRole("button", { name: "Actions for First thought" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({
            kind: "duplicate",
            id: "bullet-1",
            parent_id: "page-1",
            before_id: "bullet-2"
          })
        })
      );
    });
  });

  it("moves a page to Trash through the existing page action control", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getByRole("button", {
      name: "Page actions for Today"
    }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move page to Trash" }));

    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: { kind: "deleteSubtree", id: "page-1" }
        })
      );
    });
  });

  it("hides completed subtrees with the existing Completed items control", async () => {
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [
          { ...snapshot.viewport!.nodes[0], completed: true },
          snapshot.viewport!.nodes[1]
        ]
      }
    });
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getByRole("button", { name: "Completed items" }));

    expect(screen.queryByDisplayValue("First thought")).toBeNull();
    expect(screen.getAllByRole("group", { name: "Note text" }).some(
      (presentation) => presentation.textContent === "Second thought"
    )).toBe(true);
    expect(screen.getByText("Completed items are hidden.")).toBeVisible();
  });

  it("loads Trash through the indexed search endpoint", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getByRole("button", { name: "Trash" }));

    await waitFor(() => {
      expect(notesApi.search).toHaveBeenCalledWith({
        text: "is:trash",
        cursor: null,
        limit: 30
      });
    });
  });

  /** A page is a live child of the root, so home shows it as an ordinary row. */
  function pageRow(id: string, text: string, sortKey: number) {
    return {
      id,
      parentId: ROOT_ID,
      sortKey,
      kind: "bullet" as const,
      image: null,
      text,
      note: "",
      marker: "bullet" as const,
      collapsed: false,
      completed: false,
      starred: false,
      deleted: false
    };
  }

  /** Two pages, so "lists every page" is a real question. */
  function homeApi() {
    const notesApi = api();
    const rows = [
      pageRow("page-1", "Today", 1_024),
      pageRow("page-2", "Backlog", 2_048)
    ];
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      pages: [...snapshot.pages, { id: "page-2", title: "Backlog", sortKey: 2_048 }]
    });
    notesApi.queryViewport = vi.fn().mockImplementation(async (request) => ({
      pageId: request.pageId,
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: request.pageId === ROOT_ID ? rows : []
    }));
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      const { command } = envelope;
      const edited = command.kind === "updateText"
        ? rows.find((row) => row.id === command.id)
        : undefined;
      return {
        revision: 9,
        changedNodes: edited ? [{ ...edited, text: command.text }] : [],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    return notesApi;
  }

  /**
   * The page behind home stays on screen until its viewport is replaced, and
   * both surfaces show "Today" -- the row is the one that is not a heading.
   */
  async function homeRow(text: string) {
    await waitFor(() => expect(screen.getByDisplayValue(text))
      .toHaveAttribute("aria-label", "Note text"));
    return screen.getByDisplayValue<HTMLTextAreaElement>(text);
  }

  it("opens All as the root outline: editable rows, no page heading", async () => {
    render(<App api={homeApi()} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getByRole("button", { name: "All" }));

    await homeRow("Today");
    expect(screen.getByDisplayValue("Backlog")).toHaveAttribute(
      "aria-label",
      "Note text"
    );
    // Workflowy's home has no title of its own, and its breadcrumb is the
    // house alone.
    expect(document.querySelector(".notes-page-header")).toBeNull();
    expect(crumbLabels()).toEqual([""]);
    const house = within(breadcrumb()).getByRole("button", {
      name: "All pages"
    });
    expect(house).toBeDisabled();
    expect(house).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    // Home is a row of the Pages list too -- its first one -- so on home that
    // row is the active one and no real page row is.
    const activeRows = document.querySelectorAll(
      ".notes-library-page-row[data-active='true']"
    );
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]).toHaveTextContent("All");
    expect(screen.queryByDisplayValue("First thought")).toBeNull();
    // Adding a page is adding a child of the root, so home keeps the composer.
    expect(screen.getByRole("button", { name: "Add child" })).toBeVisible();
  });

  it("renames a page by editing its home row", async () => {
    const notesApi = homeApi();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const row = await screen.findByDisplayValue<HTMLTextAreaElement>("Backlog");

    fireEvent.change(row, { target: { value: "Later" } });
    fireEvent.blur(row);

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { kind: "updateText", id: "page-2", text: "Later" }
      })
    ));
    const sidebar = screen.getByRole("navigation", { name: "Navigation" });
    await waitFor(() => expect(within(sidebar).getByRole("button", {
      name: "Later"
    })).toBeVisible());
  });

  it("creates the next page from Enter at the end of a home row", async () => {
    const notesApi = homeApi();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const row = await homeRow("Today");
    row.setSelectionRange(row.value.length, row.value.length);

    fireEvent.keyDown(row, { key: "Enter" });

    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          kind: "splitNode",
          id: "page-1",
          parent_id: ROOT_ID,
          before_id: "page-2",
          prefix: "Today",
          suffix: ""
        })
      })
    ));
  });

  it("opens a page from the sidebar while home is showing", async () => {
    render(<App api={homeApi()} />);
    await screen.findByDisplayValue("First thought");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await screen.findByDisplayValue("Backlog");
    const sidebar = screen.getByRole("navigation", { name: "Navigation" });

    fireEvent.click(within(sidebar).getByRole("button", { name: "Backlog" }));

    await waitFor(() => expect(screen.getByDisplayValue("Backlog"))
      .toHaveAttribute("aria-label", "Page title"));
    expect(screen.getByRole("button", { name: "All" }))
      .not.toHaveAttribute("aria-current");
    expect(within(sidebar).getByRole("button", {
      name: "Backlog",
      current: "page"
    })).toBeVisible();
  });

  it("keeps the All row reachable while a filtered view is on", async () => {
    render(<App api={homeApi()} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    // The page rows go away with the filter, but the way back must not.
    expect(screen.queryByRole("button", { name: "Backlog" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    await homeRow("Today");
    expect(screen.getByRole("button", { name: "Backlog" })).toBeVisible();
  });

  it("zooms a home row and comes back through the breadcrumb house", async () => {
    render(<App api={homeApi()} />);
    await screen.findByDisplayValue("First thought");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await homeRow("Today");

    fireEvent.click(screen.getAllByRole("button", { name: "Zoom to item" })[0]);

    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title"));
    expect(crumbLabels()).toEqual(["", "Today"]);

    fireEvent.click(within(breadcrumb()).getByRole("button", {
      name: "All pages"
    }));

    await homeRow("Today");
    expect(document.querySelector(".notes-page-header")).toBeNull();
  });

  /** Alpha › Beta, so a two-level zoom has a real ancestor to walk. */
  function nestedApi() {
    const notesApi = api();
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [
          { ...snapshot.viewport!.nodes[0]!, text: "Alpha" },
          {
            ...snapshot.viewport!.nodes[1]!,
            parentId: "bullet-1",
            text: "Beta"
          }
        ]
      }
    });
    return notesApi;
  }

  function breadcrumb() {
    return screen.getByRole("navigation", { name: "Breadcrumb" });
  }

  function crumbLabels() {
    return within(breadcrumb()).getAllByRole("button")
      .map((crumb) => crumb.textContent);
  }

  it("shows home and the current page in the breadcrumb before a zoom", async () => {
    render(<App api={api()} />);
    await screen.findByDisplayValue("First thought");

    expect(crumbLabels()).toEqual(["", "Today"]);
    expect(within(breadcrumb()).getByRole("button", { name: "All pages" }))
      .toBeEnabled();
    const page = within(breadcrumb()).getByRole("button", { name: "Today" });
    expect(page).toHaveAttribute("aria-current", "page");
    expect(page).toBeDisabled();
  });

  it("walks the zoom ancestors and zooms back to the one clicked", async () => {
    render(<App api={nestedApi()} />);
    await screen.findByDisplayValue("Beta");

    fireEvent.click(screen.getAllByRole("button", { name: "Zoom to item" })[1]);

    expect(crumbLabels()).toEqual(["", "Today", "Alpha", "Beta"]);
    expect(within(breadcrumb()).getByRole("button", { name: "Beta" }))
      .toHaveAttribute("aria-current", "page");

    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "Alpha" }));

    await waitFor(() => expect(screen.getByDisplayValue("Alpha"))
      .toHaveAttribute("aria-label", "Page title"));
    expect(crumbLabels()).toEqual(["", "Today", "Alpha"]);
  });

  it("returns to the page root from the breadcrumb page segment", async () => {
    render(<App api={nestedApi()} />);
    await screen.findByDisplayValue("Beta");
    fireEvent.click(screen.getAllByRole("button", { name: "Zoom to item" })[1]);

    fireEvent.click(within(breadcrumb()).getByRole("button", { name: "Today" }));

    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title"));
    expect(crumbLabels()).toEqual(["", "Today"]);
  });

  /** A row wearing exactly the children the case under test needs. */
  function familyApi(...childText: readonly string[]): NotesApi {
    const notesApi = api();
    const base = snapshot.viewport!.nodes[0]!;
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...snapshot,
      viewport: {
        ...snapshot.viewport!,
        nodes: [
          { ...base, id: "parent", text: "Alpha" },
          ...childText.map((text, place) => ({
            ...base,
            id: `child-${place}`,
            parentId: "parent",
            sortKey: 2_048 + place * 1_024,
            text
          }))
        ]
      }
    });
    return notesApi;
  }

  function caretIn(name: string): readonly [HTMLTextAreaElement, number] {
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name });
    return [field, field.selectionStart];
  }

  it("ends the zoomed row's own title when nothing is under it", async () => {
    render(<App api={familyApi()} />);
    await screen.findByDisplayValue("Alpha");

    fireEvent.click(screen.getAllByRole("button", { name: "Zoom to item" })[0]!);

    await waitFor(() => expect(screen.getByDisplayValue("Alpha"))
      .toHaveAttribute("aria-label", "Page title"));
    await waitFor(() => {
      const [field, caret] = caretIn("Page title");
      expect(field).toHaveFocus();
      expect(caret).toBe("Alpha".length);
    });
  });

  it("ends the one child a zoomed row has", async () => {
    render(<App api={familyApi("Beta")} />);
    await screen.findByDisplayValue("Beta");

    fireEvent.click(screen.getAllByRole("button", { name: "Zoom to item" })[0]!);

    await waitFor(() => {
      const field = screen.getByDisplayValue<HTMLTextAreaElement>("Beta");
      expect(field).toHaveFocus();
      expect(field.selectionStart).toBe("Beta".length);
    });
  });

  it("leads the first child when the zoomed row has several", async () => {
    render(<App api={familyApi("Beta", "Gamma")} />);
    await screen.findByDisplayValue("Beta");

    fireEvent.click(screen.getAllByRole("button", { name: "Zoom to item" })[0]!);

    await waitFor(() => {
      const field = screen.getByDisplayValue<HTMLTextAreaElement>("Beta");
      expect(field).toHaveFocus();
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe(0);
    });
  });

  it("opens the root outline from the breadcrumb house", async () => {
    render(<App api={homeApi()} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(within(breadcrumb()).getByRole("button", {
      name: "All pages"
    }));

    expect(await screen.findByDisplayValue("Backlog")).toHaveAttribute(
      "aria-label",
      "Note text"
    );
    expect(crumbLabels()).toEqual([""]);
  });

  it("moves a sibling with Alt+ArrowUp", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    const editor = await screen.findByDisplayValue("Second thought");

    fireEvent.keyDown(editor, { key: "ArrowUp", altKey: true, shiftKey: true });

    await waitFor(() => {
      expect(notesApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: {
            kind: "moveNode",
            id: "bullet-2",
            parent_id: "page-1",
            before_id: "bullet-1"
          }
        })
      );
    });
  });

});
