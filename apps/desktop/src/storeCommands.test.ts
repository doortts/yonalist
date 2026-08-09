import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NotesApi } from "./api";
import { initialNotesState, type NotesState } from "./notesState";
import { StoreCommands } from "./storeCommands";

function receipt(revision: number): MutationReceipt {
  return {
    revision,
    changedNodes: [],
    deletedIds: [],
    history: {
      canUndo: true,
      canRedo: false,
      undoDepth: revision - 1,
      redoDepth: 0
    }
  };
}

function api(execute: NotesApi["execute"]): NotesApi {
  return {
    bootstrap: vi.fn(),
    queryViewport: vi.fn(),
    queryForest: vi.fn(),
    execute,
    importImageBytes: vi.fn(),
    importImagePaths: vi.fn(),
    replaceImageBytes: vi.fn(),
    replaceImagePath: vi.fn(),
    readImage: vi.fn(),
    viewImageOriginal: vi.fn(),
    downloadImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn(),
    exportNotes: vi.fn(),
    closeSession: vi.fn(),
    unusedAssets: vi.fn(),
    deleteAllData: vi.fn()
  };
}

describe("StoreCommands", () => {
  it("serializes commands and gives the second command the committed revision", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      revision: 1
    };
    let releaseFirst!: (value: MutationReceipt) => void;
    const firstReceipt = new Promise<MutationReceipt>((resolve) => {
      releaseFirst = resolve;
    });
    const execute = vi.fn()
      .mockReturnValueOnce(firstReceipt)
      .mockResolvedValueOnce(receipt(3));
    const commands = new StoreCommands(api(execute), {
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      applyReceipt: (next) => {
        state = { ...state, revision: next.revision };
      }
    });

    const first = commands.execute({ kind: "createPage", id: "a", text: "A" });
    const second = commands.execute({ kind: "createPage", id: "b", text: "B" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    releaseFirst(receipt(2));
    await Promise.all([first, second]);

    expect(execute.mock.calls.map(([envelope]) => envelope.baseRevision))
      .toEqual([1, 2]);
    expect(state.pendingWrites).toBe(0);
  });

  it("coalesces repeated history-group notifications until a fence", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      revision: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce(receipt(2))
      .mockResolvedValueOnce({ ...receipt(3), history: receipt(2).history })
      .mockResolvedValueOnce(receipt(4));
    const commands = new StoreCommands(api(execute), {
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      applyReceipt: (next) => {
        state = {
          ...state,
          revision: next.revision,
          undoDepth: next.history.undoDepth
        };
      }
    });
    const history = vi.fn();
    commands.subscribeHistory(history);

    await commands.execute({ kind: "createPage", id: "a", text: "A" }, "typing");
    await commands.execute({ kind: "createPage", id: "b", text: "B" }, "typing");
    commands.breakHistoryGroup();
    await commands.execute({ kind: "createPage", id: "c", text: "C" }, "typing");

    expect(history).toHaveBeenCalledTimes(2);
  });
});
