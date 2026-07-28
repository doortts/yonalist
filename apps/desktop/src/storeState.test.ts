import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { initialNotesState } from "./notesState";
import { receiptState } from "./storeState";

function bullet(id: string, parentId: string): NoteView {
  return {
    id,
    parentId,
    sortKey: 1_024,
    kind: "bullet",
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

describe("receipt state", () => {
  it("attaches changed descendants even when lexical receipt order puts children first", () => {
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page"
    }, {
      revision: 2,
      changedNodes: [
        bullet("a-child", "z-parent"),
        bullet("z-parent", "page")
      ],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.patch.nodes?.map((node) => node.id))
      .toEqual(["z-parent", "a-child"]);
  });
});
