import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NotesApi } from "./api";
import { App } from "./App";

const snapshot: BootSnapshot = {
  sessionId: "navigation-session",
  revision: 7,
  activePageId: "page",
  pages: [{ id: "page", title: "Today" }],
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
    readImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn().mockResolvedValue({ hits: [], nextCursor: null }),
    closeSession: vi.fn()
  };
}

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
