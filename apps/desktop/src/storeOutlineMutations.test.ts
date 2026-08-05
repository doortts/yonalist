import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import { initialNotesState, type NotesState } from "./notesState";
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
    });

    release(receipt());
    await pending.committed;
  });
});
