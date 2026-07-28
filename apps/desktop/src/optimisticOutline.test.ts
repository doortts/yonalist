import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { initialNotesState, type NotesState } from "./notesState";
import { projectSplitNode } from "./optimisticOutline";

function bullet(id: string, sortKey: number): NoteView {
  return {
    id,
    parentId: "page",
    sortKey,
    kind: "bullet",
    text: "",
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

describe("optimistic outline ordering", () => {
  it("keeps the newest repeated split immediately before its anchor", () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      activePageId: "page",
      nodes: [bullet("source", 1_024), bullet("middle-anchor", 2_048)]
    };
    let currentId = "source";

    for (let index = 0; index < 80; index += 1) {
      const newId = `${index % 2 === 0 ? "z" : "a"}-repeat-${index}`;
      const projected = projectSplitNode(state, {
        id: currentId,
        newId,
        parentId: "page",
        beforeId: "middle-anchor",
        prefix: "",
        suffix: ""
      });
      state = { ...state, ...projected };
      currentId = newId;

      const siblings = state.nodes.filter((node) => node.parentId === "page");
      expect(siblings.at(-2)?.id).toBe(newId);
      expect(new Set(siblings.map((node) => node.sortKey)).size)
        .toBe(siblings.length);
    }
  });
});
