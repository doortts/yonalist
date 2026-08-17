import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { PaneSnapshot } from "../appNavigation";
import type { NotesApi } from "../api";
import { initialNotesState, type NotesState } from "../notesState";
import { StoreCommands } from "./storeCommands";
import { appApi } from "../test/appApiFixture";

function caret(offset: number): PaneSnapshot {
  return {
    paneId: "primary",
    selectedIds: [],
    focus: {
      nodeId: "bullet-1",
      field: "title",
      selectionStart: offset,
      selectionEnd: offset
    }
  };
}

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
    ...appApi(),
    bootstrap: vi.fn(),
    queryForest: vi.fn(),
    execute,
    search: vi.fn()
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
      },
      flushDrafts: () => Promise.resolve(),
      materializePage: () => Promise.resolve(),
      capturePaneSnapshot: () => null
    });

    const first = commands.execute({ kind: "createNode", id: "a", parent_id: "root", before_id: null, text: "A" });
    const second = commands.execute({ kind: "createNode", id: "b", parent_id: "root", before_id: null, text: "B" });
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
      },
      flushDrafts: () => Promise.resolve(),
      materializePage: () => Promise.resolve(),
      capturePaneSnapshot: () => null
    });
    const history = vi.fn();
    commands.subscribeHistory(history);

    await commands.execute({ kind: "createNode", id: "a", parent_id: "root", before_id: null, text: "A" }, "typing");
    await commands.execute({ kind: "createNode", id: "b", parent_id: "root", before_id: null, text: "B" }, "typing");
    commands.breakHistoryGroup();
    await commands.execute({ kind: "createNode", id: "c", parent_id: "root", before_id: null, text: "C" }, "typing");

    expect(history).toHaveBeenCalledTimes(2);
  });

  it("reads the caret before the pre-command draft flush moves it", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      revision: 1
    };
    let live = caret(2);
    const commands = new StoreCommands(api(vi.fn().mockResolvedValue(receipt(2))), {
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      applyReceipt: (next) => {
        state = { ...state, revision: next.revision };
      },
      flushDrafts: () => {
        live = caret(9);
        return Promise.resolve();
      },
      materializePage: () => Promise.resolve(),
      capturePaneSnapshot: () => live
    });
    const history = vi.fn();
    commands.subscribeHistory(history);

    await commands.execute({ kind: "setStarred", id: "bullet-1", starred: true });

    expect(history.mock.calls[0][0].pane).toEqual(caret(2));
  });

  it("gives a coalesced group the caret of its first command", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      revision: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce(receipt(2))
      .mockResolvedValueOnce({ ...receipt(3), history: receipt(2).history });
    let live = caret(1);
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
      },
      flushDrafts: () => Promise.resolve(),
      materializePage: () => Promise.resolve(),
      capturePaneSnapshot: () => live
    });
    const history = vi.fn();
    commands.subscribeHistory(history);

    await commands.execute(
      { kind: "updateText", id: "bullet-1", text: "a" }, "typing");
    live = caret(2);
    await commands.execute(
      { kind: "updateText", id: "bullet-1", text: "ab" }, "typing");

    expect(history).toHaveBeenCalledOnce();
    expect(history.mock.calls[0][0].pane).toEqual(caret(1));
  });
});
