import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { completionCascade } from "./previewTree";
import { ROOT_ID } from "./storeSupport";

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

function todo(id: string, parentId: string, completed = false): NoteView {
  return { ...bullet(id, parentId), marker: "todo", completed };
}

describe("completion cascade", () => {
  const branch = [
    bullet("page", ROOT_ID),
    todo("top", "page"),
    todo("first", "top"),
    todo("second", "top"),
    bullet("divider", "top"),
    todo("beyond", "divider")
  ];

  it("ticks every Todo under the one clicked, stopping at a bullet", () => {
    expect(new Set(completionCascade(branch, "top", true)))
      .toEqual(new Set(["top", "first", "second"]));
  });

  it("leaves the ancestor open while a sibling is still open", () => {
    expect(completionCascade(branch, "first", true)).toEqual(["first"]);
  });

  it("ticks the ancestor once nothing under it is left open", () => {
    const nearlyDone = branch.map((node) =>
      node.id === "second" ? { ...node, completed: true } : node);

    expect(new Set(completionCascade(nearlyDone, "first", true)))
      .toEqual(new Set(["first", "top"]));
  });

  it("leaves the ancestor open while a Todo further down is open", () => {
    // The ticked sibling's own box is done, so a direct-children-only test
    // reads the branch as settled while the row under it is still open.
    const deep = [
      bullet("page", ROOT_ID),
      todo("top", "page"),
      todo("done", "top", true),
      todo("nested", "done"),
      todo("last", "top")
    ];

    expect(completionCascade(deep, "last", true)).toEqual(["last"]);
  });

  it("clears every Todo under the one cleared", () => {
    const allDone = branch.map((node) =>
      node.marker === "todo" ? { ...node, completed: true } : node);

    expect(new Set(completionCascade(allDone, "top", false)))
      .toEqual(new Set(["top", "first", "second"]));
  });

  it("clears every ancestor when a nested Todo is reopened", () => {
    const allDone = branch.map((node) =>
      node.marker === "todo" ? { ...node, completed: true } : node);

    expect(new Set(completionCascade(allDone, "first", false)))
      .toEqual(new Set(["first", "top"]));
  });

  it("drops rows already holding the target state", () => {
    const done = branch.map((node) =>
      node.id === "first" ? { ...node, completed: true } : node);

    expect(completionCascade(done, "first", true)).toEqual([]);
  });
});
