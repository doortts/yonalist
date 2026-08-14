import {
  act, fireEvent, render, screen, waitFor, within
} from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NotesApi } from "./api";
import { App } from "./App";
import { ROOT_ID } from "./store/storeSupport";

const snapshot: BootSnapshot = {
  sessionId: "navigation-session",
  revision: 7,
  activePageId: "page",
  pages: [{ id: "page", title: "Today", sortKey: 1_024 }],
  viewport: {
    pageId: "page",
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    nodes: ["First thought", "Second thought"].map((text, index) => ({
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
  history: {
    canUndo: false,
    canRedo: false,
    undoDepth: 0,
    redoDepth: 0
  }
};

function receipt(text: string): MutationReceipt {
  return {
    revision: 8,
    changedNodes: [{ ...snapshot.viewport!.nodes[0], text }],
    deletedIds: [],
    history: {
      canUndo: true,
      canRedo: false,
      undoDepth: 1,
      redoDepth: 0
    }
  };
}

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
    execute: vi.fn().mockImplementation((envelope) =>
      Promise.resolve(receipt(
        envelope.command.kind === "updateText"
          ? envelope.command.text
          : "First thought"
      ))),
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
    deleteAllData: vi.fn()
  };
}

/** A page is a live child of the root row, so that is what the fake writes. */
function pageNode(id: string, text: string, deleted: boolean) {
  return {
    id,
    parentId: ROOT_ID,
    sortKey: 1_024,
    kind: "bullet" as const,
    image: null,
    text,
    note: "",
    marker: "bullet" as const,
    collapsed: false,
    completed: false,
    starred: false,
    deleted
  };
}

/**
 * A backend that keeps the page list, so "did that page come back" is a real
 * question rather than a mocked answer.
 */
function pageApi(): NotesApi {
  const notesApi = api();
  const undone: (() => MutationReceipt)[] = [];
  let revision = 8;
  const receiptFor = (
    node: ReturnType<typeof pageNode>
  ): MutationReceipt => ({
    revision: (revision += 1),
    changedNodes: [node],
    deletedIds: [],
    history: {
      canUndo: true,
      canRedo: false,
      undoDepth: undone.length + 1,
      redoDepth: 0
    }
  });
  notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
    const { command } = envelope;
    if (command.kind === "createNode") {
      undone.push(() => receiptFor(pageNode(command.id, command.text, true)));
      return receiptFor(pageNode(command.id, command.text, false));
    }
    if (command.kind === "deleteSubtree") {
      undone.push(() => receiptFor(pageNode(command.id, "Today", false)));
      return receiptFor(pageNode(command.id, "Today", true));
    }
    return receipt("First thought");
  });
  notesApi.queryViewport = vi.fn().mockImplementation(async (request) => ({
    pageId: request.pageId,
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    nodes: request.pageId === "page"
      ? snapshot.viewport!.nodes
      : request.pageId === ROOT_ID
        ? [pageNode("page", "Today", false)]
        : []
  }));
  notesApi.undo = vi.fn().mockImplementation(async () => undone.pop()!());
  return notesApi;
}

describe("a mutation that moves the view", () => {
  it("takes one undo press to create a page and give it back", async () => {
    const notesApi = pageApi();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    await waitFor(() => expect(screen.getByDisplayValue("Untitled page"))
      .toHaveAttribute("aria-label", "Page title"));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title"));
    expect(notesApi.undo).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", {
      name: "Page actions for Untitled page"
    })).toBeNull();
  });

  it("takes one undo press to trash a page and give it back", async () => {
    const notesApi = pageApi();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");

    fireEvent.click(screen.getByRole("button", {
      name: "Page actions for Today"
    }));
    fireEvent.click(screen.getByRole("menuitem", {
      name: "Move page to Trash"
    }));
    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Page actions for Today"
    })).toBeNull());

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title"));
    expect(notesApi.undo).toHaveBeenCalledOnce();
  });
});

describe("who owns the Undo shortcut", () => {
  /** Leaves one outline mutation behind, so a stray Undo would be visible. */
  async function withSomethingToUndo(notesApi: NotesApi) {
    notesApi.undo = vi.fn().mockResolvedValue({
      ...receipt("First thought"),
      revision: 9,
      history: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1 }
    });
    render(<App api={notesApi} />);
    const row = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    fireEvent.change(row, { target: { value: "Changed title" } });
    fireEvent.blur(row);
    await waitFor(() => expect(notesApi.execute).toHaveBeenCalled());
    return row;
  }

  it("leaves the library search field to its own native undo", async () => {
    const notesApi = api();
    await withSomethingToUndo(notesApi);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("searchbox", { name: "Search Yonalist" });
    const delivered = fireEvent.keyDown(search, { key: "z", ctrlKey: true });

    expect(delivered).toBe(true);
    expect(notesApi.undo).not.toHaveBeenCalled();
  });

  it("leaves a chooser filter to its own native undo", async () => {
    const notesApi = api();
    await withSomethingToUndo(notesApi);
    fireEvent.click(screen.getByRole("button", {
      name: "Actions for Changed title"
    }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Tags" }));
    const filter = await screen.findByRole("combobox", { name: "Add a tag" });

    const delivered = fireEvent.keyDown(filter, { key: "z", ctrlKey: true });

    expect(delivered).toBe(true);
    expect(notesApi.undo).not.toHaveBeenCalled();
  });

  it("still routes an outline row textarea to the outline history", async () => {
    const notesApi = api();
    const row = await withSomethingToUndo(notesApi);

    const delivered = fireEvent.keyDown(row, { key: "z", ctrlKey: true });

    expect(delivered).toBe(false);
    await waitFor(() => expect(notesApi.undo).toHaveBeenCalledOnce());
  });
});

describe("navigation history integration", () => {
  it("undoes and redoes zoom locally without replaying SQLite", async () => {
    const notesApi = api();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");
    fireEvent.click(screen.getAllByRole("button", {
      name: "Zoom to item"
    })[0]);
    await waitFor(() => expect(screen.getByDisplayValue("First thought"))
      .toHaveAttribute("aria-label", "Page title"));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title"));
    expect(notesApi.undo).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByDisplayValue("First thought"))
      .toHaveAttribute("aria-label", "Page title"));
    expect(notesApi.redo).not.toHaveBeenCalled();
  });

  it("restores selection, editing focus, and caret", async () => {
    render(<App api={api()} />);
    const second = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "Second thought"
    );
    fireEvent.pointerDown(second, {
      button: 0,
      pointerId: 41,
      ctrlKey: true
    });
    act(() => {
      second.focus();
      second.setSelectionRange(3, 3);
    });
    fireEvent.keyDown(second, { key: ".", altKey: true });
    await waitFor(() => expect(screen.getByDisplayValue("Second thought"))
      .toHaveAttribute("aria-label", "Page title"));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title"));
    const restored = screen.getByDisplayValue<HTMLTextAreaElement>(
      "Second thought"
    );
    await waitFor(() => {
      expect(restored.closest(".notes-node")).toHaveAttribute(
        "data-selected",
        "true"
      );
      expect(restored).toHaveFocus();
      expect([restored.selectionStart, restored.selectionEnd]).toEqual([3, 3]);
    });
  });

  it("replays a newer mutation before preceding navigation", async () => {
    const notesApi = api();
    notesApi.undo = vi.fn().mockResolvedValue({
      ...receipt("First thought"),
      revision: 9,
      history: {
        canUndo: false,
        canRedo: true,
        undoDepth: 0,
        redoDepth: 1
      }
    });
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");
    fireEvent.click(screen.getAllByRole("button", {
      name: "Zoom to item"
    })[0]);
    const zoomTitle = await screen.findByDisplayValue("First thought");
    fireEvent.change(zoomTitle, { target: { value: "Changed title" } });
    fireEvent.blur(zoomTitle);
    await waitFor(() => expect(notesApi.execute).toHaveBeenCalled());

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(notesApi.undo).toHaveBeenCalledOnce());
    expect(screen.getByDisplayValue("First thought")).toHaveAttribute(
      "aria-label",
      "Page title"
    );
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title"));
  });

  it("undoes and redoes the trip between home and a page", async () => {
    const notesApi = pageApi();
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("First thought");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    // Home has no page heading, so the page row on it is an ordinary row.
    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Note text"));
    const sidebar = screen.getByRole("navigation", { name: "Navigation" });
    // The page behind home is still the active one: leaving home has to work
    // even when the page clicked is the one already open.
    fireEvent.click(within(sidebar).getByRole("button", { name: "Today" }));
    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title"));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Note text"));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title"));
    expect(notesApi.undo).not.toHaveBeenCalled();
    expect(notesApi.redo).not.toHaveBeenCalled();
  });

  it("restores split pane navigation", async () => {
    render(<App api={api()} />);
    await screen.findByDisplayValue("First thought");
    fireEvent.click(screen.getAllByRole("button", {
      name: "Zoom to item"
    })[0], { shiftKey: true });
    expect(screen.getAllByRole("region", {
      name: "Notes outline"
    })).toHaveLength(2);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.getAllByRole("region", {
      name: "Notes outline"
    })).toHaveLength(1));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getAllByRole("region", {
      name: "Notes outline"
    })).toHaveLength(2));
  });
});
