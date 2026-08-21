import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { initialNotesState, type NotesState } from "./notesState";
import { projectSplitNode } from "./optimisticOutline";
import { orderedNumbers } from "./outline/outlineOrdered";

function bullet(id: string, sortKey: number): NoteView {
  return {
    id,
    parentId: "page",
    sortKey,
    kind: "bullet", image: null,
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

  // The command carries the marker over, and the row on screen must not flash
  // as a plain bullet while the receipt is still in flight.
  it("gives the projected half the source's marker without its tick", () => {
    const source: NoteView = {
      ...bullet("source", 1_024),
      marker: "todo",
      completed: true
    };
    const state: NotesState = {
      ...initialNotesState,
      status: "ready",
      activePageId: "page",
      nodes: [source]
    };

    const projected = projectSplitNode(state, {
      id: "source",
      newId: "new",
      parentId: "page",
      beforeId: null,
      prefix: "Task",
      suffix: ""
    });

    const created = projected.nodes.find((node) => node.id === "new");
    expect(created?.marker).toBe("todo");
    expect(created?.completed).toBe(false);
  });

  // Enter on a numbered row continues the run, so the half it makes carries the
  // marker over and the outline counts it as the next number.
  it("carries a numbered marker onto the half Enter makes", () => {
    const state: NotesState = {
      ...initialNotesState,
      status: "ready",
      activePageId: "page",
      nodes: [{ ...bullet("source", 1_024), marker: { ordered: { start: 3 } } }]
    };

    const projected = projectSplitNode(state, {
      id: "source",
      newId: "new",
      parentId: "page",
      beforeId: null,
      prefix: "Milk",
      suffix: ""
    });

    expect(projected.nodes.find((node) => node.id === "new")?.marker)
      .toEqual({ ordered: { start: 3 } });
    expect([...orderedNumbers(projected.nodes)]).toEqual([
      ["source", 3], ["new", 4]
    ]);
  });
});
