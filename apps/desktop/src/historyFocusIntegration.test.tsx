import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
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

function child(id: string, parentId: string, text: string): NoteView {
  return { ...bullet(id, 1_024, text), parentId };
}

function bootSnapshot(
  firstText: string,
  extra: readonly NoteView[] = []
): BootSnapshot {
  return {
    sessionId: "history-focus-session",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Today", sortKey: 1_024 }],
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [
        bullet("bullet-1", 1_024, firstText),
        ...extra,
        bullet("bullet-2", 2_048, "Second thought")
      ]
    },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
}

function api(firstText = "First thought", extra: readonly NoteView[] = []): {
  readonly notesApi: NotesApi;
  createdId: () => string;
} {
  let created = "";
  let prefix = firstText;
  let suffix = "";
  const notesApi = {
    bootstrap: vi.fn().mockResolvedValue(bootSnapshot(firstText, extra)),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1, nodes: [], complete: true
    }),
    execute: vi.fn().mockImplementation((envelope) => {
      // Enter splits the bullet at the caret; at the end the suffix is empty.
      const command = envelope.command as {
        kind: string; id: string; new_id?: string;
        prefix?: string; suffix?: string;
      };
      if (command.kind === "splitNode") {
        created = command.new_id!;
        prefix = command.prefix ?? "";
        suffix = command.suffix ?? "";
      }
      return Promise.resolve({
        revision: 2,
        changedNodes: created
          ? [bullet(created, 1_536, suffix)]
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
      changedNodes: [bullet("bullet-1", 1_024, firstText)],
      deletedIds: [created],
      history: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1 }
    } satisfies MutationReceipt)),
    redo: vi.fn().mockImplementation(() => Promise.resolve({
      revision: 4,
      changedNodes: [
        bullet("bullet-1", 1_024, prefix),
        bullet(created, 1_536, suffix)
      ],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    } satisfies MutationReceipt)),
    search: vi.fn().mockResolvedValue({ hits: [], nextCursor: null }),
    exportNotes: vi.fn(),
    closeSession: vi.fn(),
    unusedAssets: vi.fn(),
    deleteAllData: vi.fn(),
    syncVaultGet: vi.fn().mockResolvedValue(null),
    syncVaultSet: vi.fn(),
    syncConflicts: vi.fn().mockResolvedValue([]),
    syncRestoreConflict: vi.fn()
  } as unknown as NotesApi;
  return { notesApi, createdId: () => created };
}

describe("history focus", () => {
  it("returns the caret to the offset Enter split the bullet at", async () => {
    const { notesApi, createdId } = api("어우우우야");
    // StrictMode, because main.tsx renders the App inside it: it double-invokes
    // render and simulates a remount, which is what a subscription made in a
    // constructor and torn down in an effect does not survive.
    render(<StrictMode><App api={notesApi} /></StrictMode>);
    const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "어우우우야"
    );
    act(() => {
      first.focus();
      first.setSelectionRange(2, 2);
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
      const restored = screen.getByDisplayValue<HTMLTextAreaElement>("어우우우야");
      expect(restored).toHaveFocus();
      expect([restored.selectionStart, restored.selectionEnd]).toEqual([2, 2]);
    });
  });

  // The nesting split has to cost exactly one undo as well: one ⌘Z puts the
  // bullet back whole, with the caret where the Enter found it.
  it("undoes a split that nested the half in one step, caret restored", async () => {
    const { notesApi, createdId } = api(
      "어우우우야", [child("bullet-1-child", "bullet-1", "child")]);
    // StrictMode, because main.tsx renders the App inside it: it double-invokes
    // render and simulates a remount, which is what a subscription made in a
    // constructor and torn down in an effect does not survive.
    render(<StrictMode><App api={notesApi} /></StrictMode>);
    const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "어우우우야"
    );
    act(() => {
      first.focus();
      first.setSelectionRange(2, 2);
    });
    await act(async () => {
      fireEvent.keyDown(first, { key: "Enter" });
    });
    await waitFor(() => expect(notesApi.execute).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.activeElement)
      .toHaveAttribute("data-node-id", createdId()));

    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });

    await waitFor(() => {
      const restored = screen.getByDisplayValue<HTMLTextAreaElement>("어우우우야");
      expect(restored).toHaveFocus();
      expect([restored.selectionStart, restored.selectionEnd]).toEqual([2, 2]);
    });
    expect(notesApi.undo).toHaveBeenCalledOnce();
  });

  it("returns the caret to the split row again on redo", async () => {
    const { notesApi, createdId } = api("어우우우야");
    // StrictMode, because main.tsx renders the App inside it: it double-invokes
    // render and simulates a remount, which is what a subscription made in a
    // constructor and torn down in an effect does not survive.
    render(<StrictMode><App api={notesApi} /></StrictMode>);
    const first = await screen.findByDisplayValue<HTMLTextAreaElement>(
      "어우우우야"
    );
    act(() => {
      first.focus();
      first.setSelectionRange(2, 2);
    });
    await act(async () => {
      fireEvent.keyDown(first, { key: "Enter" });
    });
    await waitFor(() => expect(document.activeElement)
      .toHaveAttribute("data-node-id", createdId()));
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
    await waitFor(() => expect(screen.getByDisplayValue("어우우우야"))
      .toHaveFocus());

    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    });

    await waitFor(() => {
      const tail = screen.getByDisplayValue<HTMLTextAreaElement>("우우야");
      expect(tail).toHaveFocus();
      expect(tail.selectionStart).toBe(0);
    });
  });

  it("returns the caret to the bullet an undone Enter split off", async () => {
    const { notesApi, createdId } = api();
    // StrictMode, because main.tsx renders the App inside it: it double-invokes
    // render and simulates a remount, which is what a subscription made in a
    // constructor and torn down in an effect does not survive.
    render(<StrictMode><App api={notesApi} /></StrictMode>);
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
    // StrictMode, because main.tsx renders the App inside it: it double-invokes
    // render and simulates a remount, which is what a subscription made in a
    // constructor and torn down in an effect does not survive.
    render(<StrictMode><App api={notesApi} /></StrictMode>);
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
