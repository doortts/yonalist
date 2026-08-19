import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { completionCascade } from "./previewTree";
import { ROOT_ID } from "../store/storeSupport";

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

function home(): NoteView {
  return { ...bullet(ROOT_ID, ""), kind: "page", parentId: null };
}

describe("completion cascade", () => {
  // `page` is a page row -- Home's own child, drawn as a page rather than as a
  // row of one -- so the rows a tick settles start below it.
  const branch = [
    home(),
    bullet("page", ROOT_ID),
    todo("top", "page"),
    todo("first", "top"),
    todo("second", "top"),
    bullet("divider", "top"),
    todo("beyond", "divider")
  ];

  it("settles every row under the one clicked, whatever its marker", () => {
    expect(new Set(completionCascade(branch, "top", true)))
      .toEqual(new Set(["top", "first", "second", "divider", "beyond"]));
  });

  it("leaves the ancestor open while a sibling is still open", () => {
    expect(completionCascade(branch, "first", true)).toEqual(["first"]);
  });

  it("ticks the ancestor once nothing under it is left open", () => {
    const nearlyDone = branch.map((node) =>
      ["second", "divider", "beyond"].includes(node.id)
        ? { ...node, completed: true }
        : node);

    expect(new Set(completionCascade(nearlyDone, "first", true)))
      .toEqual(new Set(["first", "top"]));
  });

  it("stops the climb below the page row", () => {
    const nothingLeft = branch.map((node) =>
      node.id === "top" || node.kind === "page"
        ? node
        : { ...node, completed: true });

    expect(completionCascade(nothingLeft, "top", true)).toEqual(["top"]);
  });

  it("leaves the ancestor open while a Todo further down is open", () => {
    // The ticked sibling's own box is done, so a direct-children-only test
    // reads the branch as settled while the row under it is still open.
    const deep = [
      home(),
      bullet("page", ROOT_ID),
      todo("top", "page"),
      todo("done", "top", true),
      todo("nested", "done"),
      todo("last", "top")
    ];

    expect(completionCascade(deep, "last", true)).toEqual(["last"]);
  });

  it("clears every row under the one cleared", () => {
    const allDone = branch.map((node) => ({ ...node, completed: true }));

    expect(new Set(completionCascade(allDone, "top", false)))
      .toEqual(new Set(["top", "first", "second", "divider", "beyond"]));
  });

  it("clears every ancestor when a nested row is reopened", () => {
    const allDone = branch.map((node) => ({ ...node, completed: true }));

    expect(new Set(completionCascade(allDone, "first", false)))
      .toEqual(new Set(["first", "top"]));
  });

  it("clears an ancestor bullet when a row under it is reopened", () => {
    const allDone = branch.map((node) =>
      node.kind === "page" ? node : { ...node, completed: true });

    // `divider` carries no box, and the row reopened under it is not its own
    // child, so this is the ancestor rule reading a marker it must not read.
    expect(new Set(completionCascade(allDone, "beyond", false)))
      .toEqual(new Set(["beyond", "divider", "top"]));
  });

  it("drops rows already holding the target state", () => {
    const done = branch.map((node) =>
      node.id === "first" ? { ...node, completed: true } : node);

    expect(completionCascade(done, "first", true)).toEqual([]);
  });
});
