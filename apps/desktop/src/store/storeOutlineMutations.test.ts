import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import { initialNotesState, type NotesState } from "../notesState";
import { StoreOutlineMutations } from "./storeOutlineMutations";

function receipt(): MutationReceipt {
  return {
    revision: 2,
    changedNodes: [],
    deletedIds: [],
    history: {
      canUndo: true,
      canRedo: false,
      undoDepth: 1,
      redoDepth: 0
    }
  };
}

describe("StoreOutlineMutations", () => {
  it("projects a created row before its queued command settles", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      activePageId: "page-1"
    };
    let release!: (value: MutationReceipt) => void;
    const pendingReceipt = new Promise<MutationReceipt>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn().mockReturnValue(pendingReceipt);
    const mutations = new StoreOutlineMutations({
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      execute,
      cancelTitle: vi.fn(),
      cancelNote: vi.fn(),
      cancelDrafts: vi.fn()
    });

    const pending = mutations.beginCreateNode("page-1", "New", null);

    expect(state.nodes).toEqual([
      expect.objectContaining({
        id: pending.id,
        parentId: "page-1",
        text: "New"
      })
    ]);
    expect(execute).toHaveBeenCalledWith({
      kind: "createNode",
      id: pending.id,
      parent_id: "page-1",
      before_id: null,
      text: "New"
    }, null);

    release(receipt());
    await pending.committed;
  });

  it("queues the kind behind its own row, not behind the next one", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      activePageId: "page-1"
    };
    const order: string[] = [];
    // A command settles a turn later, so a second row asked for in the meantime
    // takes its place in the queue before the first row's kind does -- unless
    // both of a row's commands are queued together.
    const execute = vi.fn().mockImplementation((command: { kind: string }) => {
      order.push(command.kind);
      return Promise.resolve(receipt());
    });
    const mutations = new StoreOutlineMutations({
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      execute,
      cancelTitle: vi.fn(),
      cancelNote: vi.fn(),
      cancelDrafts: vi.fn()
    });

    const first = mutations.beginCreateNode("page-1", "", null, "todo");
    const second = mutations.beginCreateNode("page-1", "", null, "todo");
    await Promise.all([first.committed, second.committed]);

    expect(order).toEqual([
      "createNode", "setMarker", "createNode", "setMarker"
    ]);
  });

  it("makes a row in the kind it was asked for, in one undo step", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      activePageId: "page-1"
    };
    const execute = vi.fn().mockResolvedValue(receipt());
    const mutations = new StoreOutlineMutations({
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      execute,
      cancelTitle: vi.fn(),
      cancelNote: vi.fn(),
      cancelDrafts: vi.fn()
    });

    const pending = mutations.beginCreateNode("page-1", "", null, "todo");
    await pending.committed;

    // The box is on the row before the round trip, not a beat after it.
    expect(state.nodes).toEqual([
      expect.objectContaining({ id: pending.id, marker: "todo" })
    ]);
    const groups = execute.mock.calls.map(([, group]) => group);
    expect(execute.mock.calls.map(([command]) => command.kind))
      .toEqual(["createNode", "setMarker"]);
    // One group across both, so the coalescer folds them into one undo step.
    expect(groups[0]).toBe(groups[1]);
    expect(groups[0]).not.toBeNull();
  });
});
