import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { initialNotesState } from "./notesState";
import { receiptState } from "./storeState";

function bullet(id: string, parentId: string): NoteView {
  return {
    id,
    parentId,
    sortKey: 1_024,
    kind: "bullet", image: null,
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

  it("classifies text receipts as node-only invalidations", () => {
    const original = bullet("one", "page");
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      nodes: [original]
    }, {
      revision: 2,
      changedNodes: [{ ...original, text: "Renamed" }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.changedNodeIds).toEqual(["one"]);
    expect(result.outlineChanged).toBe(false);
  });

  it("classifies hierarchy receipts as outline invalidations", () => {
    const original = bullet("one", "page");
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      nodes: [original]
    }, {
      revision: 2,
      changedNodes: [{ ...original, parentId: "two", sortKey: 2_048 }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.changedNodeIds).toEqual(["one"]);
    expect(result.outlineChanged).toBe(true);
  });

  it("drops drafts the receipt made stale and keeps unflushed typing", () => {
    const one = { ...bullet("one", "page"), text: "one", note: "note one" };
    const two = { ...bullet("two", "page"), text: "two", note: "note two" };
    const three = { ...bullet("three", "page"), text: "three", note: "" };
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      nodes: [one, two, three],
      drafts: { one: "one", two: "renamed", three: "still typing" },
      noteDrafts: { one: "note one", two: "renote", three: "still typing" }
    }, {
      revision: 2,
      changedNodes: [
        // Undo puts a text back that neither draft knows about.
        { ...one, text: "older", note: "older note" },
        // The commit that matches the draft the user already stopped touching.
        { ...two, text: "renamed", note: "renote" }
      ],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.patch.drafts).toEqual({ three: "still typing" });
    expect(result.patch.noteDrafts).toEqual({ three: "still typing" });
  });

  it("keeps a draft the user typed past the text the receipt carries", () => {
    const one = { ...bullet("one", "page"), text: "one" };
    const result = receiptState({
      ...initialNotesState,
      status: "ready",
      sessionId: "session",
      activePageId: "page",
      nodes: [one],
      drafts: { one: "one and more" }
    }, {
      revision: 2,
      changedNodes: [{ ...one, text: "older" }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });

    expect(result.patch.drafts).toEqual({ one: "one and more" });
  });
});
