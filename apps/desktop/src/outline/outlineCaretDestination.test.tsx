import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "../api";
import { App } from "../App";

function bullet(
  id: string,
  sortKey: number,
  text: string,
  parentId = "page-1"
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

function picture(id: string, sortKey: number, parentId = "page-1"): NoteView {
  return {
    ...bullet(id, sortKey, "shot.png", parentId),
    kind: "image",
    image: {
      contentHash: "a".repeat(64),
      originalName: "shot.png",
      mimeType: "image/png",
      byteLength: 3,
      pixelWidth: 640,
      pixelHeight: 480,
      displayWidth: 320
    }
  };
}

interface OutlineCommand {
  readonly kind: string;
  readonly id: string;
  readonly text?: string;
  readonly previous_id?: string;
  readonly previous_text?: string;
  readonly current_text?: string;
}

/**
 * A backend that really removes the row and lifts its children into its place,
 * because the caret question this file asks only exists once the list has
 * reshaped underneath the focus request.
 */
function harness(seed: readonly NoteView[]) {
  let nodes = seed.map((node) => ({ ...node }));
  let revision = 1;
  const receipt = (
    changedNodes: readonly NoteView[],
    deletedIds: readonly string[] = []
  ): MutationReceipt => ({
    revision: (revision += 1),
    changedNodes: [...changedNodes],
    deletedIds: [...deletedIds],
    history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
  });
  const patch = (id: string, fields: Partial<NoteView>) => {
    nodes = nodes.map((node) =>
      node.id === id ? { ...node, ...fields } : node);
    return nodes.find((node) => node.id === id)!;
  };
  const execute = vi.fn().mockImplementation((envelope: {
    command: OutlineCommand;
  }) => {
    const command = envelope.command;
    if (command.kind === "removeEmptyNode") {
      const removed = nodes.find((node) => node.id === command.id)!;
      const promoted = nodes
        .filter((node) => node.parentId === command.id)
        .map((node, position) => ({
          ...node,
          parentId: removed.parentId,
          sortKey: removed.sortKey + position + 1
        }));
      const promotedById = new Map(promoted.map((node) => [node.id, node]));
      nodes = nodes
        .filter((node) => node.id !== command.id)
        .map((node) => promotedById.get(node.id) ?? node);
      return Promise.resolve(receipt(promoted, [command.id]));
    }
    if (command.kind === "updateText") {
      return Promise.resolve(receipt([patch(command.id, {
        text: command.text ?? ""
      })]));
    }
    if (command.kind === "mergeNodeBackward") {
      const merged = patch(command.id, {
        text: (command.previous_text ?? "") + (command.current_text ?? ""),
        sortKey: nodes.find((node) => node.id === command.previous_id)!.sortKey
      });
      nodes = nodes.filter((node) => node.id !== command.previous_id);
      return Promise.resolve(receipt([merged], [command.previous_id!]));
    }
    return Promise.resolve(receipt([]));
  });
  const boot: BootSnapshot = {
    sessionId: "caret-destination-session",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Today", sortKey: 1_024 }],
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: seed.map((node) => ({ ...node }))
    },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
  const notesApi = {
    bootstrap: vi.fn().mockResolvedValue(boot),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1, nodes: [], complete: true
    }),
    execute,
    importImageBytes: vi.fn(),
    importImagePaths: vi.fn(),
    replaceImageBytes: vi.fn(),
    replaceImagePath: vi.fn(),
    readImage: vi.fn().mockRejectedValue(new Error("no bytes in this test")),
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
    syncAttachments: vi.fn(),
    syncDeleteAttachment: vi.fn(),
    syncRestoreConflict: vi.fn()
  } as unknown as NotesApi;
  return { notesApi, execute, nodes: () => nodes };
}

// StrictMode, because main.tsx renders the App inside it: it double-invokes
// render and simulates a remount, which is what a subscription made in a
// constructor and torn down in an effect does not survive.
function mount(notesApi: NotesApi) {
  render(<StrictMode><App api={notesApi} /></StrictMode>);
}

async function backspaceOnEmptyRow(): Promise<void> {
  const blank = await waitFor(() => {
    const found = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-node-id="blank"][data-outline-field="title"]'
    );
    expect(found).not.toBeNull();
    return found!;
  });
  act(() => {
    blank.focus();
    blank.setSelectionRange(0, 0);
  });
  await act(async () => {
    fireEvent.keyDown(blank, { key: "Backspace" });
  });
}

/**
 * The observed symptom was focus on a row that is not an editor at all, so the
 * element type is the assertion; a row id alone would have passed through it.
 */
function caretHolder(): HTMLTextAreaElement {
  const active = document.activeElement;
  expect(active).toBeInstanceOf(HTMLTextAreaElement);
  return active as HTMLTextAreaElement;
}

describe("caret destination after Backspace", () => {
  it("lands at the end of the row above when an empty parent goes", async () => {
    const { notesApi } = harness([
      bullet("above", 1_024, "부두의"),
      bullet("blank", 2_048, ""),
      bullet("kid-1", 1_024, "# 이론상", "blank"),
      bullet("kid-2", 2_048, "이별이", "blank")
    ]);
    mount(notesApi);
    await screen.findByDisplayValue("부두의");

    await backspaceOnEmptyRow();

    await waitFor(() => {
      const caret = caretHolder();
      expect(caret.value).toBe("부두의");
      expect(caret.selectionStart).toBe("부두의".length);
    });
    // The children came with it, one level up, which is the half that already
    // worked and must keep working.
    expect(screen.getByDisplayValue("# 이론상")).toBeInTheDocument();
    expect(screen.getByDisplayValue("이별이")).toBeInTheDocument();
  });

  it("skips a picture row above rather than focus something with no caret", async () => {
    const { notesApi } = harness([
      bullet("above", 1_024, "부두의"),
      picture("shot", 2_048),
      bullet("blank", 3_072, ""),
      bullet("kid-1", 1_024, "# 이론상", "blank"),
      bullet("kid-2", 2_048, "이별이", "blank")
    ]);
    mount(notesApi);
    await screen.findByRole("group", { name: "Image: shot.png" });

    await backspaceOnEmptyRow();

    await waitFor(() => {
      const caret = caretHolder();
      expect(caret).toHaveAttribute("data-node-id", "above");
      expect(caret.selectionStart).toBe("부두의".length);
    });
  });

  it("skips a picture row above an empty row with no children too", async () => {
    const { notesApi } = harness([
      bullet("above", 1_024, "부두의"),
      picture("shot", 2_048),
      bullet("blank", 3_072, "")
    ]);
    mount(notesApi);
    await screen.findByRole("group", { name: "Image: shot.png" });

    await backspaceOnEmptyRow();

    await waitFor(() => {
      const caret = caretHolder();
      expect(caret).toHaveAttribute("data-node-id", "above");
      expect(caret.selectionStart).toBe("부두의".length);
    });
  });

  it("takes the first row below when the empty row is the first one", async () => {
    const { notesApi } = harness([
      bullet("blank", 1_024, ""),
      bullet("below", 2_048, "이별이")
    ]);
    mount(notesApi);
    await screen.findByDisplayValue("이별이");

    await backspaceOnEmptyRow();

    await waitFor(() => {
      expect(caretHolder()).toHaveAttribute("data-node-id", "below");
    });
  });

  it("takes the page title when no row can hold the caret", async () => {
    const { notesApi } = harness([
      bullet("blank", 1_024, ""),
      picture("shot", 2_048)
    ]);
    mount(notesApi);
    await screen.findByRole("group", { name: "Image: shot.png" });

    await backspaceOnEmptyRow();

    await waitFor(() => {
      expect(caretHolder()).toHaveAttribute("data-node-id", "page-1");
    });
  });

  it("still joins into the previous sibling at the join offset", async () => {
    const { notesApi } = harness([
      bullet("first", 1_024, "alpha"),
      bullet("second", 2_048, "beta")
    ]);
    mount(notesApi);
    const second = await screen.findByDisplayValue<HTMLTextAreaElement>("beta");
    act(() => {
      second.focus();
      second.setSelectionRange(0, 0);
    });

    await act(async () => {
      fireEvent.keyDown(second, { key: "Backspace" });
    });

    await waitFor(() => {
      const caret = caretHolder();
      expect(caret.value).toBe("alphabeta");
      expect(caret.selectionStart).toBe("alpha".length);
    });
  });

  it("still folds a first child into its parent at the join offset", async () => {
    const { notesApi } = harness([
      bullet("parent", 1_024, "alpha"),
      bullet("child", 1_024, "beta", "parent")
    ]);
    mount(notesApi);
    const child = await screen.findByDisplayValue<HTMLTextAreaElement>("beta");
    act(() => {
      child.focus();
      child.setSelectionRange(0, 0);
    });

    await act(async () => {
      fireEvent.keyDown(child, { key: "Backspace" });
    });

    await waitFor(() => {
      const caret = caretHolder();
      expect(caret).toHaveAttribute("data-node-id", "parent");
      expect(caret.value).toBe("alphabeta");
      expect(caret.selectionStart).toBe("alpha".length);
    });
  });
});
