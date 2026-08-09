import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";

function bullet(id: string, sortKey: number, text: string): NoteView {
  return {
    id,
    parentId: "page-1",
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

const snapshot: BootSnapshot = {
  sessionId: "history-focus-session",
  revision: 1,
  activePageId: "page-1",
  pages: [{ id: "page-1", title: "Today" }],
  viewport: {
    pageId: "page-1",
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    nodes: [
      bullet("bullet-1", 1_024, "First thought"),
      bullet("bullet-2", 2_048, "Second thought")
    ]
  },
  history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
};

function api(): { readonly notesApi: NotesApi; createdId: () => string } {
  let created = "";
  const notesApi = {
    bootstrap: vi.fn().mockResolvedValue(snapshot),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1, nodes: [], complete: true
    }),
    execute: vi.fn().mockImplementation((envelope) => {
      // Enter at the end of a bullet splits it with an empty suffix.
      const command = envelope.command as {
        kind: string; id: string; new_id?: string;
      };
      if (command.kind === "splitNode") created = command.new_id!;
      return Promise.resolve({
        revision: 2,
        changedNodes: created
          ? [bullet(created, 1_536, "")]
          : [],
        deletedIds: [],
        history: {
          canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0
        }
      } satisfies MutationReceipt);
    }),
    importImageBytes: vi.fn(),
    importImagePaths: vi.fn(),
    replaceImageBytes: vi.fn(),
    replaceImagePath: vi.fn(),
    readImage: vi.fn(),
    viewImageOriginal: vi.fn(),
    downloadImage: vi.fn(),
    undo: vi.fn().mockImplementation(() => Promise.resolve({
      revision: 3,
      changedNodes: [bullet("bullet-1", 1_024, "First thought")],
      deletedIds: [created],
      history: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1 }
    } satisfies MutationReceipt)),
    redo: vi.fn().mockImplementation(() => Promise.resolve({
      revision: 4,
      changedNodes: [bullet(created, 1_536, "")],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    } satisfies MutationReceipt)),
    search: vi.fn().mockResolvedValue({ hits: [], nextCursor: null }),
    exportNotes: vi.fn(),
    closeSession: vi.fn(),
    unusedAssets: vi.fn(),
    deleteAllData: vi.fn()
  } as unknown as NotesApi;
  return { notesApi, createdId: () => created };
}

describe("history focus", () => {
  it("returns the caret to the bullet an undone Enter split off", async () => {
    const { notesApi, createdId } = api();
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    act(() => {
      first.focus();
      first.setSelectionRange(first.value.length, first.value.length);
    });
    await act(async () => {
      fireEvent.keyDown(first, { key: "Enter" });
    });
    await waitFor(() => expect(notesApi.execute).toHaveBeenCalled());
    await waitFor(() => expect(document.activeElement)
      .toHaveAttribute("data-node-id", createdId()));

    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });

    await waitFor(() => {
      const restored = screen.getByDisplayValue<HTMLTextAreaElement>(
        "First thought"
      );
      expect(restored).toHaveFocus();
      expect([restored.selectionStart, restored.selectionEnd])
        .toEqual(["First thought".length, "First thought".length]);
    });
  });

  it("keeps the caret in the outline across a redo", async () => {
    const { notesApi } = api();
    render(<App api={notesApi} />);
    const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "First thought"
    );
    act(() => {
      first.focus();
      first.setSelectionRange(first.value.length, first.value.length);
    });
    await act(async () => {
      fireEvent.keyDown(first, { key: "Enter" });
    });
    await waitFor(() => expect(notesApi.execute).toHaveBeenCalled());
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
    await waitFor(() => expect(screen.getByDisplayValue("First thought"))
      .toHaveFocus());

    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    });

    await waitFor(() => expect(notesApi.redo).toHaveBeenCalledOnce());
    expect(document.activeElement).toBeInstanceOf(HTMLTextAreaElement);
    expect(document.activeElement)
      .toHaveAttribute("data-outline-field", "title");
  });
});
