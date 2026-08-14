import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import { initialNotesState, type NotesState } from "../notesState";
import { StoreDrafts } from "./storeDrafts";

function node(text: string) {
  return {
    id: "one",
    parentId: "page-1",
    sortKey: 1_024,
    kind: "bullet" as const, image: null,
    text,
    note: "",
    marker: "bullet" as const,
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function receipt(text: string, revision: number): MutationReceipt {
  return {
    revision,
    changedNodes: [node(text)],
    deletedIds: [],
    history: {
      canUndo: true,
      canRedo: false,
      undoDepth: 1,
      redoDepth: 0
    }
  };
}

describe("StoreDrafts", () => {
  it("keeps repeated Backspace flushes in one history group", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      revision: 1,
      activePageId: "page-1",
      nodes: [node("one")]
    };
    const execute = vi.fn(async (
      command,
      _historyGroup: string | null = null
    ) => {
      if (command.kind !== "updateText") throw new Error("expected updateText");
      const next = receipt(command.text, state.revision + 1);
      state = {
        ...state,
        revision: next.revision,
        nodes: next.changedNodes
      };
      return next;
    });
    const drafts = new StoreDrafts({
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      execute,
      settled: vi.fn().mockResolvedValue(undefined),
      breakHistoryGroup: vi.fn()
    });

    const firstGroup = drafts.beginBackspace(false);
    drafts.setTitle("one", "on");
    await drafts.flushTitle("one");
    const repeatedGroup = drafts.beginBackspace(true);
    drafts.setTitle("one", "o");
    await drafts.flushTitle("one");
    drafts.endBackspace();

    expect(repeatedGroup).toBe(firstGroup);
    expect(execute.mock.calls.map(([, group]) => group))
      .toEqual([firstGroup, firstGroup]);
  });

  it("flushes title and note drafts before waiting for command settlement", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      activePageId: "page-1",
      nodes: [node("one")]
    };
    const order: string[] = [];
    const execute = vi.fn(async (command) => {
      order.push(command.kind);
      return receipt(
        command.kind === "updateText" ? command.text : "one",
        state.revision + 1
      );
    });
    const drafts = new StoreDrafts({
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      execute,
      settled: async () => {
        order.push("settled");
      },
      breakHistoryGroup: vi.fn()
    });
    drafts.setTitle("one", "title");
    drafts.setNote("one", "note");

    await drafts.flushAll();

    expect(order).toEqual(["updateText", "updateNote", "settled"]);
  });
  it("skips the command when a page note draft matches the page node", async () => {
    const pageNode = {
      ...node("Today"),
      id: "page-1",
      parentId: "root",
      note: "Page context"
    };
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      activePageId: "page-1",
      pageNode,
      nodes: [node("one")]
    };
    const execute = vi.fn();
    const drafts = new StoreDrafts({
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      execute,
      settled: vi.fn().mockResolvedValue(undefined),
      breakHistoryGroup: vi.fn()
    });
    drafts.setNote("page-1", "Page context");

    await drafts.flushNote("page-1");

    expect(execute).not.toHaveBeenCalled();
    expect(state.noteDrafts["page-1"]).toBeUndefined();
  });
});
